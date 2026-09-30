import { HttpException, HttpStatus, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditAction, InstallmentStatus, ParentOrderPaymentStatus, PaymentPurpose, PaymentStatus, Prisma } from '@prisma/client';
import { badRequestWith, conflictWith } from '../../common/http-errors';
import { TooManyRequestsException } from '../../common/exceptions/too-many-requests.exception';
import type { EnvironmentVariables } from '../../config/env.validation';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { CreditLedgerService } from '../credit/credit-ledger.service';
import { CreditOrderService, type ProviderFollowUp } from '../credit/credit-order.service';
import { lockParentOrder, writeOrderAudit, type OrderActor } from '../orders/order-audit';
import { OrderLifecycleService } from '../orders/order-lifecycle.service';
import type { InitiatePaymentResponseDto, PaymentOutcome, PaymentOutcomeDto } from './dto/payment.dto';
import {
  PAYMENT_GATEWAY,
  PaymentGatewayError,
  type GatewayInitiation,
  type GatewayVerification,
  type PaymentGatewayProvider,
} from './gateway/payment-gateway.interface';
import { PLATFORM_DISPLAY_NAME } from '../../common/brand';

type Tx = Prisma.TransactionClient;

/** Open attempts one order may have inside the grace window (each one opens a bank session). */
export const MAX_OPEN_ATTEMPTS = 5;

const paymentSelect = {
  id: true,
  status: true,
  parentOrderId: true,
  purpose: true,
  paymentMethod: true,
  cashAmount: true,
  creditAmount: true,
  creditAccountId: true,
  creditReservationRef: true,
  installmentPlanId: true,
  installmentScheduleId: true,
  installmentSchedule: { select: { status: true } },
  bankRrn: true,
  metadata: true,
  gatewayTrackingToken: true,
  parentOrder: { select: { id: true, orderNumber: true, paymentStatus: true, paymentExpiresAt: true } },
} satisfies Prisma.PaymentSelect;

type PaymentRow = Prisma.PaymentGetPayload<{ select: typeof paymentSelect }>;

/** What `startGatewaySession` needs to open a bank session for an already-created INITIATED payment. */
export interface GatewaySessionRequest {
  paymentId: string;
  parentOrderId: string;
  orderNumber: string;
  amount: Prisma.Decimal;
  description: string;
  customerMobile: string;
}

/**
 * Card payments through the active IPG.
 *
 * Money safety rules:
 * - success is decided only by the gateway's server-to-server verify, never by
 *   the redirect parameters, and verify always sends the amount *we* stored;
 * - the gateway is called outside database transactions; the result is then
 *   applied in one transaction that locks the parent order (the same lock the
 *   expiry sweeper, cancellations and vendors use) and re-reads the payment,
 *   so concurrent or repeated callbacks apply at most once;
 * - order completion (stock commit, escrow holds, PAID) and Payment SUCCESSFUL
 *   commit together or not at all;
 * - a captured payment for an order that is no longer payable is recorded as
 *   SUCCESSFUL with `requiresManualRefund` and audited — never dropped.
 *
 * Phase 8 (credit): a HYBRID attempt carries a credit reservation next to its
 * card part. On a verified card payment the reservation is committed and the
 * instalment schedule written before the order completes (same transaction;
 * lock order parent → credit account → stock → wallets); on failure — or if the
 * gateway cannot even open a session — the reservation is released. When any
 * attempt pays the order, the still-held reservations of the other attempts are
 * released. INSTALLMENT_REPAYMENT payments settle one instalment and restore its
 * principal to the credit line. Provider calls follow after the commit.
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  private readonly callbackUrl: string;
  private readonly graceMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly lifecycle: OrderLifecycleService,
    private readonly creditLedger: CreditLedgerService,
    private readonly creditOrders: CreditOrderService,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGatewayProvider,
    config: ConfigService<EnvironmentVariables, true>,
  ) {
    this.callbackUrl = `${config.getOrThrow<string>('PUBLIC_API_ORIGIN')}/api/v1/payments/callback`;
    this.graceMs = config.getOrThrow<number>('PAYMENT_CALLBACK_GRACE_MINUTES') * 60_000;
  }

  get gatewayName(): PaymentGatewayProvider['name'] {
    return this.gateway.name;
  }

  async initiate(userId: string, parentOrderId: string, actor: OrderActor): Promise<InitiatePaymentResponseDto> {
    const now = new Date();
    const order = await this.prisma.parentOrder.findFirst({
      where: { id: parentOrderId, userId },
      select: { id: true, orderNumber: true, paymentStatus: true, paymentExpiresAt: true, finalPayableAmount: true, user: { select: { mobile: true } } },
    });
    if (!order) {
      throw new NotFoundException('Order not found');
    }
    if (order.paymentStatus !== ParentOrderPaymentStatus.PENDING) {
      throw conflictWith('ORDER_NOT_PAYABLE', `This order is ${order.paymentStatus}; only PENDING orders can be paid`, {
        paymentStatus: order.paymentStatus,
      });
    }
    if (order.paymentExpiresAt !== null && order.paymentExpiresAt <= now) {
      throw conflictWith('ORDER_PAYMENT_EXPIRED', 'The payment window of this order has closed; place the order again', {
        paymentExpiresAt: order.paymentExpiresAt,
      });
    }
    const open = await this.prisma.payment.count({
      where: { parentOrderId, status: PaymentStatus.INITIATED, createdAt: { gt: new Date(now.getTime() - this.graceMs) } },
    });
    if (open >= MAX_OPEN_ATTEMPTS) {
      throw new TooManyRequestsException('Too many open payment attempts for this order; finish or wait for one of them', this.graceMs / 1000);
    }

    const payment = await this.prisma.$transaction(async (tx) => {
      const created = await tx.payment.create({
        data: { parentOrderId, gatewayName: this.gateway.name, cashAmount: order.finalPayableAmount, creditAmount: 0, status: PaymentStatus.INITIATED },
        select: { id: true },
      });
      await writeOrderAudit(tx, actor, {
        action: AuditAction.CREATE,
        entityName: 'Payment',
        entityId: created.id,
        newValue: { parentOrderId, orderNumber: order.orderNumber, gatewayName: this.gateway.name, amount: order.finalPayableAmount.toFixed(2) },
      });
      return created;
    });

    const initiation = await this.startGatewaySession({
      paymentId: payment.id,
      parentOrderId,
      orderNumber: order.orderNumber,
      amount: order.finalPayableAmount,
      description: `پرداخت سفارش ${order.orderNumber} — ${PLATFORM_DISPLAY_NAME}`,
      customerMobile: order.user.mobile,
    });
    return {
      paymentId: payment.id,
      redirectUrl: initiation.redirectUrl,
      gatewayName: this.gateway.name,
      amount: order.finalPayableAmount.toFixed(2),
      currency: 'IRR',
      orderNumber: order.orderNumber,
      paymentExpiresAt: order.paymentExpiresAt,
    };
  }

  /**
   * Opens the bank session of an INITIATED payment (card-only, the card part of
   * a HYBRID attempt, or an instalment repayment). If the gateway refuses or
   * cannot be reached, the payment becomes FAILED, its credit reservation (if
   * any) is released, and 502 GATEWAY_UNAVAILABLE is thrown.
   */
  async startGatewaySession(request: GatewaySessionRequest): Promise<GatewayInitiation> {
    let initiation: GatewayInitiation;
    try {
      initiation = await this.gateway.initiatePayment(
        {
          paymentId: request.paymentId,
          orderNumber: request.orderNumber,
          amount: request.amount,
          description: request.description,
          customerMobile: request.customerMobile,
        },
        this.callbackUrl,
      );
    } catch (error) {
      const gatewayError = error instanceof PaymentGatewayError ? error : new PaymentGatewayError(String(error), 'GATEWAY_ERROR', true);
      const followUps = await this.prisma.$transaction(async (tx) => {
        await lockParentOrder(tx, request.parentOrderId);
        const current = await tx.payment.findUniqueOrThrow({ where: { id: request.paymentId }, select: paymentSelect });
        const released = current.status === PaymentStatus.INITIATED ? await this.creditOrders.releaseLocked(tx, current) : null;
        await tx.payment.update({
          where: { id: request.paymentId },
          data: {
            status: PaymentStatus.FAILED,
            metadata: {
              stage: 'initiate',
              code: gatewayError.code,
              message: gatewayError.message.slice(0, 500),
              ...(released ? { creditReservationReleased: true } : {}),
            },
          },
        });
        return released ? [released] : [];
      });
      await this.creditOrders.followUp(followUps);
      this.logger.warn(`Gateway ${this.gateway.name} refused to open a session for payment ${request.paymentId}: ${gatewayError.message}`);
      throw new HttpException(
        { statusCode: HttpStatus.BAD_GATEWAY, error: 'Bad Gateway', code: 'GATEWAY_UNAVAILABLE', message: 'The payment gateway could not open a payment session; try again', gatewayCode: gatewayError.code },
        HttpStatus.BAD_GATEWAY,
      );
    }
    await this.prisma.payment.update({
      where: { id: request.paymentId },
      data: { gatewayTrackingToken: initiation.gatewayToken, metadata: { stage: 'initiated', gateway: initiation.details } as Prisma.InputJsonValue },
    });
    return initiation;
  }

  /** Public bank callback (GET query or POST form/JSON). Idempotent. */
  async handleCallback(params: Record<string, unknown>, actor: OrderActor): Promise<PaymentOutcomeDto> {
    const callback = this.gateway.parseCallback(params);
    if (callback.gatewayToken === null) {
      throw badRequestWith('INVALID_CALLBACK', 'The callback does not carry a payment token');
    }
    const found = await this.prisma.payment.findFirst({
      where: { gatewayName: this.gateway.name, gatewayTrackingToken: callback.gatewayToken },
      select: paymentSelect,
    });
    if (!found) {
      throw new NotFoundException('Unknown payment');
    }
    if (found.status !== PaymentStatus.INITIATED) {
      return this.outcomeOf(found); // repeated callback: same answer, no second verify
    }

    let verification: GatewayVerification;
    try {
      verification = await this.gateway.verifyPayment(callback.gatewayToken, { amount: found.cashAmount, bankStatus: callback.bankStatus });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Verify of payment ${found.id} failed; it stays INITIATED: ${message}`);
      return {
        ...this.outcomeOf(found),
        outcome: 'VERIFICATION_PENDING',
        message: 'The bank could not confirm the payment yet. If money was taken, retry this page shortly; unconfirmed payments are reversed by the bank.',
      };
    }

    const followUps: ProviderFollowUp[] = [];
    const settled = await this.prisma.$transaction(async (tx) => {
      await lockParentOrder(tx, found.parentOrder.id);
      const current = await tx.payment.findUniqueOrThrow({ where: { id: found.id }, select: paymentSelect });
      if (current.status !== PaymentStatus.INITIATED) {
        return current; // another callback won the race
      }
      return verification.success
        ? this.applySuccess(tx, current, verification, actor, followUps)
        : this.applyFailure(tx, current, verification, actor, followUps);
    });
    await this.creditOrders.followUp(followUps);
    return this.outcomeOf(settled);
  }

  private async applySuccess(
    tx: Tx,
    payment: PaymentRow,
    verification: GatewayVerification,
    actor: OrderActor,
    followUps: ProviderFollowUp[],
  ): Promise<PaymentRow> {
    const paidAt = new Date();
    const effect =
      payment.purpose === PaymentPurpose.INSTALLMENT_REPAYMENT
        ? await this.applyRepayment(tx, payment, verification, paidAt)
        : await this.applyCheckout(tx, payment, verification, actor, paidAt, followUps);
    const requiresManualRefund = !effect.applied;
    const metadata = {
      ...asObject(payment.metadata),
      stage: 'verified',
      verifyCode: verification.code,
      alreadyVerified: verification.alreadyVerified,
      cardPanMasked: verification.cardPanMasked,
      ...(requiresManualRefund
        ? { requiresManualRefund: true, orderStatusAtCapture: payment.parentOrder.paymentStatus, ...effect.details }
        : effect.details),
    } as Prisma.InputJsonValue;
    const updated = await tx.payment.update({
      where: { id: payment.id },
      data: { status: PaymentStatus.SUCCESSFUL, paidAt, bankRrn: verification.bankRrn, metadata: metadata },
      select: paymentSelect,
    });
    await writeOrderAudit(tx, actor, {
      action: AuditAction.PAYMENT_CAPTURE,
      entityName: 'Payment',
      entityId: payment.id,
      oldValue: { status: PaymentStatus.INITIATED },
      newValue: {
        status: PaymentStatus.SUCCESSFUL,
        orderNumber: payment.parentOrder.orderNumber,
        purpose: payment.purpose,
        paymentMethod: payment.paymentMethod,
        amount: payment.cashAmount.toFixed(2),
        creditAmount: payment.creditAmount.toFixed(2),
        bankRrn: verification.bankRrn,
        verifyCode: verification.code,
        ...(payment.installmentScheduleId ? { installmentScheduleId: payment.installmentScheduleId } : {}),
        ...(requiresManualRefund ? { requiresManualRefund: true, orderPaymentStatus: updated.parentOrder.paymentStatus, ...effect.details } : {}),
      },
    });
    if (requiresManualRefund) {
      this.logger.error(
        `Payment ${payment.id} (RRN ${verification.bankRrn ?? '-'}) was captured for order ${payment.parentOrder.orderNumber}, ` +
          `which is ${updated.parentOrder.paymentStatus}: MANUAL REFUND REQUIRED`,
      );
    }
    return updated;
  }

  /**
   * Card payment (or the card part of a HYBRID attempt) for an order. The order
   * must still be PENDING and, for HYBRID, the credit reservation still held;
   * then credit is committed + scheduled first and the order completes.
   */
  private async applyCheckout(
    tx: Tx,
    payment: PaymentRow,
    verification: GatewayVerification,
    actor: OrderActor,
    paidAt: Date,
    followUps: ProviderFollowUp[],
  ): Promise<{ applied: boolean; details: Record<string, unknown> }> {
    const orderId = payment.parentOrder.id;
    if (payment.parentOrder.paymentStatus !== ParentOrderPaymentStatus.PENDING) {
      return { applied: false, details: {} };
    }
    const details: Record<string, unknown> = {};
    if (payment.creditAmount.greaterThan(0)) {
      const state = await this.creditLedger.reservationState(tx, payment.creditAccountId!, payment.creditReservationRef!);
      if (state !== 'HELD') {
        // Defensive: a PENDING order whose hybrid reservation is gone cannot be completed with this card part.
        return { applied: false, details: { creditReservationState: state } };
      }
      const committed = await this.creditOrders.commitAndScheduleLocked(tx, payment, paidAt);
      followUps.push(committed.followUp);
      details['schedule'] = committed.schedule;
    }
    const application = await this.lifecycle.applyPaymentLocked(tx, orderId, actor, {
      paymentId: payment.id,
      paymentMethod: payment.paymentMethod,
      ...(verification.bankRrn ? { bankRrn: verification.bankRrn } : {}),
    });
    if (!application.applied) {
      throw new Error(`Order ${orderId} was PENDING under lock but the payment could not be applied`);
    }
    followUps.push(...(await this.creditOrders.releaseOpenReservationsLocked(tx, orderId, payment.id)));
    details['escrowHeld'] = application.escrowHeld;
    return { applied: true, details };
  }

  private async applyRepayment(
    tx: Tx,
    payment: PaymentRow,
    verification: GatewayVerification,
    paidAt: Date,
  ): Promise<{ applied: boolean; details: Record<string, unknown> }> {
    const result = await this.creditOrders.applyRepaymentLocked(tx, payment.installmentScheduleId!, payment.cashAmount, { bankRrn: verification.bankRrn, paidAt });
    return { applied: result.applied, details: { installmentStatus: result.installmentStatus, restoredPrincipal: result.restoredPrincipal } };
  }

  private async applyFailure(
    tx: Tx,
    payment: PaymentRow,
    verification: GatewayVerification,
    actor: OrderActor,
    followUps: ProviderFollowUp[],
  ): Promise<PaymentRow> {
    // HYBRID: the card part failed, so the credit reservation is rolled back.
    const released = await this.creditOrders.releaseLocked(tx, payment);
    if (released) followUps.push(released);
    const updated = await tx.payment.update({
      where: { id: payment.id },
      data: {
        status: PaymentStatus.FAILED,
        metadata: {
          ...asObject(payment.metadata),
          stage: 'failed',
          code: verification.code,
          message: verification.message.slice(0, 500),
          ...(released ? { creditReservationReleased: true } : {}),
        },
      },
      select: paymentSelect,
    });
    // The order itself stays PENDING with its stock reserved: the customer can
    // try again until paymentExpiresAt, then the expiry sweeper releases it.
    await writeOrderAudit(tx, actor, {
      action: AuditAction.STATUS_CHANGE,
      entityName: 'Payment',
      entityId: payment.id,
      oldValue: { status: PaymentStatus.INITIATED },
      newValue: {
        status: PaymentStatus.FAILED,
        orderNumber: payment.parentOrder.orderNumber,
        purpose: payment.purpose,
        paymentMethod: payment.paymentMethod,
        code: verification.code,
        message: verification.message,
        ...(released ? { creditReservationReleased: released.reservationRef } : {}),
      },
    });
    return updated;
  }

  private outcomeOf(payment: PaymentRow): PaymentOutcomeDto {
    const order = payment.parentOrder;
    const repayment = payment.purpose === PaymentPurpose.INSTALLMENT_REPAYMENT;
    const canRetry = repayment
      ? payment.installmentSchedule?.status === InstallmentStatus.PENDING || payment.installmentSchedule?.status === InstallmentStatus.OVERDUE
      : order.paymentStatus === ParentOrderPaymentStatus.PENDING && (order.paymentExpiresAt === null || order.paymentExpiresAt > new Date());
    const metadata = asObject(payment.metadata);
    let outcome: PaymentOutcome;
    let message: string;
    if (payment.status === PaymentStatus.SUCCESSFUL) {
      outcome = metadata['requiresManualRefund'] === true ? 'PAID_REQUIRES_REFUND' : 'PAID';
      message = repayment
        ? outcome === 'PAID'
          ? 'Payment confirmed; the instalment is paid'
          : 'The bank captured this payment but the instalment was already settled; it will be refunded by our finance team'
        : outcome === 'PAID'
          ? 'Payment confirmed; the order is paid'
          : 'The bank captured this payment but the order had already been paid or closed; it will be refunded by our finance team';
    } else if (payment.status === PaymentStatus.INITIATED) {
      outcome = 'VERIFICATION_PENDING';
      message = 'The payment has not been confirmed yet';
    } else {
      outcome = 'FAILED';
      message = canRetry ? 'The payment was not completed; you can try again' : 'The payment was not completed';
    }
    return {
      outcome,
      paymentId: payment.id,
      paymentStatus: payment.status,
      parentOrderId: order.id,
      orderNumber: order.orderNumber,
      orderPaymentStatus: order.paymentStatus,
      bankRrn: payment.bankRrn,
      message,
      canRetry: outcome === 'FAILED' && canRetry,
      paymentExpiresAt: order.paymentExpiresAt,
      purpose: payment.purpose,
      paymentMethod: payment.paymentMethod,
      cashAmount: payment.cashAmount.toFixed(2),
      creditAmount: payment.creditAmount.toFixed(2),
      installmentScheduleId: payment.installmentScheduleId,
    };
  }
}

function asObject(value: Prisma.JsonValue | null): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value) : {};
}
