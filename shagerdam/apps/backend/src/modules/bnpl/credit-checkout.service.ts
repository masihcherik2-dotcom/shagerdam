import { BadGatewayException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditAction, CreditAccountStatus, ParentOrderPaymentStatus, PaymentMethod, PaymentPurpose, PaymentStatus, Prisma } from '@prisma/client';
import { TooManyRequestsException } from '../../common/exceptions/too-many-requests.exception';
import { badRequestWith, conflictWith } from '../../common/http-errors';
import type { EnvironmentVariables } from '../../config/env.validation';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { CreditLedgerService } from '../credit/credit-ledger.service';
import { splitPayment } from '../credit/credit-math';
import { CreditOrderService, type ProviderFollowUp, type ScheduleSummary } from '../credit/credit-order.service';
import { CreditProviderError, type CreditProviderAdapter, type CreditReservation } from '../credit/providers/credit-provider.interface';
import { CreditProviderRegistry } from '../credit/providers/credit-provider.registry';
import { lockParentOrder, writeOrderAudit, type OrderActor } from '../orders/order-audit';
import { OrderLifecycleService } from '../orders/order-lifecycle.service';
import { MAX_OPEN_ATTEMPTS, PaymentsService } from '../payments/payments.service';
import type { CreditPaymentInitiateResponseDto, InitiateCreditPaymentDto } from './dto/bnpl.dto';
import { PLATFORM_DISPLAY_NAME } from '../../common/brand';

/**
 * Credit and hybrid checkout (TM brief §3–4).
 *
 * Sequence: validate (order PENDING and payable, active account, active plan,
 * split) → provider `reserveCredit` (outside any transaction) → one transaction
 * that locks the parent order, then the credit account, writes the
 * PURCHASE_RESERVE_HOLD row and the Payment. BANK_CREDIT completes in that same
 * transaction: commit (PURCHASE_COMMIT), instalment schedule, order PAID via the
 * shared lifecycle (stock committed, vendor escrow funded, packages
 * PENDING_APPROVAL). HYBRID then opens a bank session for the card part; if the
 * gateway fails (now, or at the callback) the reservation is released.
 *
 * If the transaction fails after the provider reserved, the provider
 * reservation is released immediately (nothing was recorded locally).
 */
@Injectable()
export class CreditCheckoutService {
  private readonly logger = new Logger(CreditCheckoutService.name);
  private readonly graceMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: CreditProviderRegistry,
    private readonly ledger: CreditLedgerService,
    private readonly creditOrders: CreditOrderService,
    private readonly lifecycle: OrderLifecycleService,
    private readonly payments: PaymentsService,
    config: ConfigService<EnvironmentVariables, true>,
  ) {
    this.graceMs = config.getOrThrow<number>('PAYMENT_CALLBACK_GRACE_MINUTES') * 60_000;
  }

  async initiate(userId: string, dto: InitiateCreditPaymentDto, actor: OrderActor): Promise<CreditPaymentInitiateResponseDto> {
    await this.registry.assertEnabled();
    const now = new Date();
    const order = await this.prisma.parentOrder.findFirst({
      where: { id: dto.parentOrderId, userId },
      select: { id: true, orderNumber: true, paymentStatus: true, paymentExpiresAt: true, finalPayableAmount: true, user: { select: { mobile: true } } },
    });
    if (!order) {
      throw new NotFoundException('Order not found');
    }
    assertPayable(order, now);

    const provider = await this.registry.requireActiveProvider();
    const adapter = this.registry.adapterFor(provider);
    const account = await this.prisma.creditAccount.findUnique({
      where: { userId_providerId: { userId, providerId: provider.id } },
      select: { id: true, status: true, availableAmount: true, expiresAt: true },
    });
    if (!account) {
      throw conflictWith('CREDIT_ACCOUNT_REQUIRED', `You have no credit account with ${provider.code}; apply first`);
    }
    if (account.status !== CreditAccountStatus.ACTIVE) {
      throw conflictWith('CREDIT_ACCOUNT_NOT_ACTIVE', `The credit account is ${account.status}`, { accountStatus: account.status });
    }
    if (account.expiresAt !== null && account.expiresAt <= now) {
      throw conflictWith('CREDIT_ACCOUNT_EXPIRED', 'The credit account has expired', { expiresAt: account.expiresAt });
    }
    const plan = await this.prisma.installmentPlan.findFirst({
      where: { id: dto.planId, providerId: provider.id, isActive: true },
      select: { id: true, title: true, durationMonths: true, interestRatePercent: true },
    });
    if (!plan) {
      throw badRequestWith('INSTALLMENT_PLAN_NOT_AVAILABLE', 'This instalment plan is not offered by the active credit provider');
    }
    const split = splitPayment(dto.paymentMethod, order.finalPayableAmount, account.availableAmount);
    if ('rejected' in split) {
      throw this.rejection(split.rejected, order.finalPayableAmount, account.availableAmount);
    }
    const open = await this.prisma.payment.count({
      where: { parentOrderId: order.id, status: PaymentStatus.INITIATED, createdAt: { gt: new Date(now.getTime() - this.graceMs) } },
    });
    if (open >= MAX_OPEN_ATTEMPTS) {
      throw new TooManyRequestsException('Too many open payment attempts for this order; finish or wait for one of them', this.graceMs / 1000);
    }

    const reservation = await this.reserveAtProvider(adapter, account.id, split.creditAmount, order.id);
    const method = dto.paymentMethod;
    const followUps: ProviderFollowUp[] = [];
    let result: { paymentId: string; schedule: ScheduleSummary | null; orderPaymentStatus: ParentOrderPaymentStatus };
    try {
      result = await this.prisma.$transaction(async (tx) => {
        await lockParentOrder(tx, order.id);
        const current = await tx.parentOrder.findUniqueOrThrow({ where: { id: order.id }, select: { paymentStatus: true, paymentExpiresAt: true } });
        assertPayable(current, new Date());
        await this.ledger.hold(tx, account.id, split.creditAmount, reservation.reservationRef, order.id);
        const payment = await tx.payment.create({
          data: {
            parentOrderId: order.id,
            purpose: PaymentPurpose.ORDER_CHECKOUT,
            paymentMethod: method,
            creditAccountId: account.id,
            installmentPlanId: plan.id,
            creditReservationRef: reservation.reservationRef,
            // BANK_CREDIT never touches a card gateway: the "gateway" is the credit provider.
            gatewayName: method === PaymentMethod.BANK_CREDIT ? provider.code : this.payments.gatewayName,
            cashAmount: split.cashAmount,
            creditAmount: split.creditAmount,
            status: PaymentStatus.INITIATED,
            metadata: { stage: 'credit_reserved', provider: provider.code, reservation: reservation.details } as Prisma.InputJsonValue,
          },
          select: { id: true, parentOrderId: true, creditAmount: true, creditAccountId: true, creditReservationRef: true, installmentPlanId: true },
        });
        await writeOrderAudit(tx, actor, {
          action: AuditAction.CREATE,
          entityName: 'Payment',
          entityId: payment.id,
          newValue: {
            parentOrderId: order.id,
            orderNumber: order.orderNumber,
            paymentMethod: method,
            providerCode: provider.code,
            planId: plan.id,
            creditAmount: split.creditAmount.toFixed(2),
            cashAmount: split.cashAmount.toFixed(2),
            creditReservationRef: reservation.reservationRef,
          },
        });
        if (method !== PaymentMethod.BANK_CREDIT) {
          return { paymentId: payment.id, schedule: null, orderPaymentStatus: current.paymentStatus };
        }

        const paidAt = new Date();
        const committed = await this.creditOrders.commitAndScheduleLocked(tx, payment, paidAt);
        followUps.push(committed.followUp);
        const application = await this.lifecycle.applyPaymentLocked(tx, order.id, actor, { paymentId: payment.id, paymentMethod: PaymentMethod.BANK_CREDIT });
        if (!application.applied) {
          throw new Error(`Order ${order.id} was PENDING under lock but the credit payment could not be applied`);
        }
        followUps.push(...(await this.creditOrders.releaseOpenReservationsLocked(tx, order.id, payment.id)));
        await tx.payment.update({
          where: { id: payment.id },
          data: {
            status: PaymentStatus.SUCCESSFUL,
            paidAt,
            metadata: {
              stage: 'credit_committed',
              provider: provider.code,
              reservation: reservation.details,
              schedule: committed.schedule,
              escrowHeld: application.escrowHeld,
            } as unknown as Prisma.InputJsonValue,
          },
        });
        await writeOrderAudit(tx, actor, {
          action: AuditAction.PAYMENT_CAPTURE,
          entityName: 'Payment',
          entityId: payment.id,
          oldValue: { status: PaymentStatus.INITIATED },
          newValue: {
            status: PaymentStatus.SUCCESSFUL,
            orderNumber: order.orderNumber,
            paymentMethod: method,
            creditAmount: split.creditAmount.toFixed(2),
            creditReservationRef: reservation.reservationRef,
            installments: committed.schedule.installments,
            escrowHeld: application.escrowHeld,
          },
        });
        return { paymentId: payment.id, schedule: committed.schedule, orderPaymentStatus: ParentOrderPaymentStatus.PAID };
      });
    } catch (error) {
      // Nothing was recorded locally: undo the provider-side reservation now.
      await adapter.releaseCredit(reservation.reservationRef).catch((releaseError: unknown) => {
        this.logger.error(`Could not release provider reservation ${reservation.reservationRef} after a failed checkout: ${String(releaseError)}`);
      });
      throw error;
    }
    await this.creditOrders.followUp(followUps);

    const base = {
      paymentId: result.paymentId,
      parentOrderId: order.id,
      orderNumber: order.orderNumber,
      paymentMethod: method,
      creditAmount: split.creditAmount.toFixed(2),
      cashAmount: split.cashAmount.toFixed(2),
      currency: 'IRR',
      plan: { id: plan.id, title: plan.title, durationMonths: plan.durationMonths, interestRatePercent: plan.interestRatePercent.toFixed(2) },
    };
    if (method === PaymentMethod.BANK_CREDIT) {
      return { ...base, status: 'COMPLETED', orderPaymentStatus: result.orderPaymentStatus, redirectUrl: null, gatewayName: null, paymentExpiresAt: null, schedule: result.schedule };
    }
    // HYBRID: open the bank session for the card part (on failure the reservation is released and 502 is thrown).
    const initiation = await this.payments.startGatewaySession({
      paymentId: result.paymentId,
      parentOrderId: order.id,
      orderNumber: order.orderNumber,
      amount: split.cashAmount,
      description: `پرداخت نقدی سفارش ${order.orderNumber} (ترکیبی با اعتبار) — ${PLATFORM_DISPLAY_NAME}`,
      customerMobile: order.user.mobile,
    });
    return {
      ...base,
      status: 'IPG_REQUIRED',
      orderPaymentStatus: result.orderPaymentStatus,
      redirectUrl: initiation.redirectUrl,
      gatewayName: this.payments.gatewayName,
      paymentExpiresAt: order.paymentExpiresAt,
      schedule: null,
    };
  }

  private async reserveAtProvider(adapter: CreditProviderAdapter, accountId: string, amount: Prisma.Decimal, parentOrderId: string): Promise<CreditReservation> {
    try {
      return await adapter.reserveCredit(accountId, amount, parentOrderId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Provider ${adapter.code} could not reserve credit for order ${parentOrderId}: ${message}`);
      throw new BadGatewayException({
        statusCode: 502,
        error: 'Bad Gateway',
        code: 'CREDIT_PROVIDER_UNAVAILABLE',
        message: 'The credit provider could not reserve the credit; try again later',
        providerCode: error instanceof CreditProviderError ? error.code : 'PROVIDER_ERROR',
      });
    }
  }

  private rejection(reason: 'INSUFFICIENT_CREDIT' | 'HYBRID_NOT_REQUIRED' | 'AMOUNT_NOT_WHOLE_RIALS', payable: Prisma.Decimal, available: Prisma.Decimal): Error {
    const details = { finalPayableAmount: payable.toFixed(2), availableAmount: available.toFixed(2) };
    switch (reason) {
      case 'INSUFFICIENT_CREDIT':
        return conflictWith('INSUFFICIENT_CREDIT', 'Your available credit does not cover this payment method; use HYBRID or card', details);
      case 'HYBRID_NOT_REQUIRED':
        return conflictWith('HYBRID_NOT_REQUIRED', 'Your available credit covers the whole order; use BANK_CREDIT', details);
      case 'AMOUNT_NOT_WHOLE_RIALS':
        return conflictWith('AMOUNT_NOT_WHOLE_RIALS', 'The order amount is not in whole rials and cannot be financed', details);
    }
  }
}

function assertPayable(order: { paymentStatus: ParentOrderPaymentStatus; paymentExpiresAt: Date | null }, now: Date): void {
  if (order.paymentStatus !== ParentOrderPaymentStatus.PENDING) {
    throw conflictWith('ORDER_NOT_PAYABLE', `This order is ${order.paymentStatus}; only PENDING orders can be paid`, { paymentStatus: order.paymentStatus });
  }
  if (order.paymentExpiresAt !== null && order.paymentExpiresAt <= now) {
    throw conflictWith('ORDER_PAYMENT_EXPIRED', 'The payment window of this order has closed; place the order again', { paymentExpiresAt: order.paymentExpiresAt });
  }
}
