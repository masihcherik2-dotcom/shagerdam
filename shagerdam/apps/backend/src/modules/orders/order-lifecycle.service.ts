import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditAction, DisputeStatus, ParentOrderPaymentStatus, PaymentMethod, PaymentStatus, Prisma, SubOrderStatus, VendorStatus } from '@prisma/client';
import { conflictWith } from '../../common/http-errors';
import type { EnvironmentVariables } from '../../config/env.validation';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { CreditOrderService, type ProviderFollowUp } from '../credit/credit-order.service';
import { InventoryService } from '../products/inventory.service';
import { WalletLedgerService, type ReverseOutcome } from '../wallet/wallet-ledger.service';
import type { ForceSubOrderStatusDto, VendorUpdateSubOrderStatusDto } from './dto/order-input.dto';
import { lockParentOrder, stockMovements, SYSTEM_ACTOR, writeOrderAudit, type OrderActor } from './order-audit';
import type { ActorRole } from './order-views';
import { canStaffForce, canVendorTransition, paidStockEffect, vendorTransitionsFrom } from './sub-order-state-machine';

type Tx = Prisma.TransactionClient;

type UnpaidOutcome = 'CUSTOMER_CANCEL' | 'PAYMENT_FAILED' | 'PAYMENT_EXPIRED';

const UNPAID_OUTCOME: Record<UnpaidOutcome, { status: ParentOrderPaymentStatus; role: ActorRole; defaultReason: string }> = {
  CUSTOMER_CANCEL: { status: ParentOrderPaymentStatus.CANCELLED, role: 'CUSTOMER', defaultReason: 'Cancelled by the customer before payment' },
  PAYMENT_FAILED: { status: ParentOrderPaymentStatus.FAILED, role: 'SYSTEM', defaultReason: 'Payment failed' },
  PAYMENT_EXPIRED: { status: ParentOrderPaymentStatus.CANCELLED, role: 'SYSTEM', defaultReason: 'Payment was not completed in time' },
};

/**
 * Wallet consequence of a package transition: escrow released on delivery, the
 * vendor's earnings reversed on cancel/refund, or — for dispute resolutions
 * (Phase 9) — the frozen earnings refunded or released.
 */
export type WalletAction = 'ESCROW_RELEASED' | 'ESCROW_REVERSED' | 'EARNINGS_REVERSED' | 'DISPUTE_HOLD_REFUNDED' | 'DISPUTE_HOLD_RELEASED' | 'NONE';

export interface TransitionResult {
  subOrderId: string;
  previousStatus: SubOrderStatus;
  stockAction: 'RESTOCKED' | 'NONE';
  walletAction: WalletAction;
  auditLogId: string;
}

/** Disputes that still freeze their package (Phase 9). */
export const ACTIVE_DISPUTE_STATUSES: readonly DisputeStatus[] = [DisputeStatus.OPEN, DisputeStatus.VENDOR_RESPONDED, DisputeStatus.UNDER_ARBITRATION];

/** Package fields a dispute resolution receives (the row read under the parent-order lock). */
export type DisputedPackage = TransitionRow;

/**
 * How a dispute resolution overrides the default consequences of a transition:
 * the stock decision and the wallet movement come from the dispute, not from
 * the status change (the escrow is frozen in DISPUTE_HOLD, which the default
 * release/reverse refuse to touch).
 */
export interface DisputeOutcome {
  restock: boolean;
  wallet: (tx: Tx, sub: DisputedPackage) => Promise<WalletAction>;
  audit: Record<string, unknown>;
}

/** What confirming a payment did; `applied: false` means the order was no longer PENDING. */
export interface PaymentApplication {
  applied: boolean;
  escrowHeld: string;
  auditLogId: string | null;
}

/**
 * Every state change of an order after checkout. All operations lock the parent
 * order row first, so a payment callback, a customer cancel, the expiry sweeper
 * and vendor/staff actions on the same order are strictly serialised, and the
 * state read after the lock is the state acted upon.
 *
 * Stock rules (reservation made at checkout):
 * - unpaid order cancelled / payment failed / payment expired → release reservation;
 * - payment confirmed → commit reservation (stock and reserved both drop);
 * - paid package cancelled by the vendor or refunded by staff before shipping → restock.
 *
 * Wallet rules (Phase 7, via `WalletLedgerService` in the same transaction):
 * - payment confirmed → each package's vendorEarningsAmount is held in escrow (PENDING);
 * - package DELIVERED (customer confirmation or staff/carrier) → escrow released to WITHDRAWABLE, once;
 * - package CANCELLED / REFUNDED → the vendor's earnings are reversed (from escrow, or from the
 *   withdrawable balance if already delivered; 409 when the vendor already withdrew it).
 */
@Injectable()
export class OrderLifecycleService {
  private readonly logger = new Logger(OrderLifecycleService.name);

  private readonly paymentGraceMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly ledger: WalletLedgerService,
    private readonly creditOrders: CreditOrderService,
    config: ConfigService<EnvironmentVariables, true>,
  ) {
    this.paymentGraceMs = config.getOrThrow<number>('PAYMENT_CALLBACK_GRACE_MINUTES') * 60_000;
  }

  // ─── unpaid orders ────────────────────────────────────────────────────────

  /** Customer cancels an order that has not been paid yet. */
  async cancelByCustomer(userId: string, parentOrderId: string, reason: string | undefined, actor: OrderActor): Promise<string> {
    const followUps: ProviderFollowUp[] = [];
    const auditLogId = await this.prisma.$transaction(async (tx) => {
      const locked = await lockParentOrder(tx, parentOrderId);
      const order = locked
        ? await tx.parentOrder.findFirst({ where: { id: parentOrderId, userId }, select: { id: true, paymentStatus: true } })
        : null;
      if (!order) {
        throw new NotFoundException('Order not found');
      }
      if (order.paymentStatus !== ParentOrderPaymentStatus.PENDING) {
        throw conflictWith(
          'ORDER_NOT_CANCELLABLE',
          order.paymentStatus === ParentOrderPaymentStatus.PAID
            ? 'This order is already paid; ask the store or support to cancel it'
            : `This order is already ${order.paymentStatus}`,
          { paymentStatus: order.paymentStatus },
        );
      }
      return this.closeUnpaid(tx, order.id, 'CUSTOMER_CANCEL', reason, actor, followUps);
    });
    await this.creditOrders.followUp(followUps);
    return auditLogId;
  }

  /** Payment gateway reported failure for an unpaid order. Idempotent: returns `false` if not PENDING. */
  async markPaymentFailed(parentOrderId: string, reason?: string, actor: OrderActor = SYSTEM_ACTOR): Promise<boolean> {
    const followUps: ProviderFollowUp[] = [];
    const closed = await this.prisma.$transaction(async (tx) => {
      const order = await this.lockPending(tx, parentOrderId);
      if (!order) return false;
      await this.closeUnpaid(tx, order.id, 'PAYMENT_FAILED', reason, actor, followUps);
      return true;
    });
    await this.creditOrders.followUp(followUps);
    return closed;
  }

  /**
   * Payment confirmed: the order becomes PAID, each reservation is converted
   * into a sale and each package's vendor earnings enter escrow. Idempotent:
   * `applied: false` if the order is not PENDING (already paid, or
   * cancelled/expired first).
   */
  async markPaid(parentOrderId: string, actor: OrderActor = SYSTEM_ACTOR): Promise<PaymentApplication> {
    return this.prisma.$transaction(async (tx) => {
      if (!(await lockParentOrder(tx, parentOrderId))) {
        return { applied: false, escrowHeld: '0.00', auditLogId: null };
      }
      return this.applyPaymentLocked(tx, parentOrderId, actor, {});
    });
  }

  /**
   * `markPaid` for a caller that already runs the transaction and holds the
   * parent-order lock (the payment callback, which updates the Payment row in
   * the same transaction). Sub-orders keep PENDING_APPROVAL and become visible
   * to vendors because the parent is now PAID. `paymentMethod` records how the
   * order was paid (CASH_IPG, BANK_CREDIT or HYBRID; default CASH_IPG).
   */
  async applyPaymentLocked(
    tx: Tx,
    parentOrderId: string,
    actor: OrderActor,
    payment: { paymentId?: string; bankRrn?: string; paymentMethod?: PaymentMethod },
  ): Promise<PaymentApplication> {
    const paymentMethod = payment.paymentMethod ?? PaymentMethod.CASH_IPG;
    const order = await tx.parentOrder.findFirst({
      where: { id: parentOrderId, paymentStatus: ParentOrderPaymentStatus.PENDING },
      select: { id: true },
    });
    if (!order) return { applied: false, escrowHeld: '0.00', auditLogId: null };

    const subs = await tx.subOrder.findMany({
      where: { parentOrderId },
      select: { id: true, vendorId: true, subOrderNumber: true, vendorEarningsAmount: true, items: { select: { productVariantId: true, quantity: true } } },
      orderBy: { vendorId: 'asc' }, // wallet lock order
    });
    for (const move of stockMovements(subs.flatMap((sub) => sub.items))) {
      await this.inventory.commitReservation(move.variantId, move.quantity, tx);
    }
    const paidAt = new Date();
    await tx.parentOrder.update({
      where: { id: parentOrderId },
      data: { paymentStatus: ParentOrderPaymentStatus.PAID, paidAt, paymentMethod },
    });
    let escrowHeld = new Prisma.Decimal(0);
    for (const sub of subs) {
      if (await this.ledger.holdSaleEscrow(tx, sub)) {
        escrowHeld = escrowHeld.plus(sub.vendorEarningsAmount);
      }
    }
    const auditLogId = await writeOrderAudit(tx, actor, {
      action: AuditAction.PAYMENT_CAPTURE,
      entityName: 'ParentOrder',
      entityId: parentOrderId,
      oldValue: { paymentStatus: ParentOrderPaymentStatus.PENDING },
      newValue: {
        paymentStatus: ParentOrderPaymentStatus.PAID,
        paidAt: paidAt.toISOString(),
        paymentMethod,
        escrowHeld: escrowHeld.toFixed(2),
        packages: subs.length,
        ...(payment.paymentId ? { paymentId: payment.paymentId } : {}),
        ...(payment.bankRrn ? { bankRrn: payment.bankRrn } : {}),
      },
    });
    return { applied: true, escrowHeld: escrowHeld.toFixed(2), auditLogId };
  }

  /**
   * Cancels unpaid orders whose payment window has passed and releases their
   * stock. Each order is handled in its own transaction (one bad row cannot
   * block the rest) and re-checked under lock (a payment that landed meanwhile wins).
   */
  async expireOverdue(now: Date = new Date(), batchSize = 100): Promise<number> {
    // A customer who is on the bank page right now must not lose the order: an
    // INITIATED payment younger than the grace window protects it.
    const inFlightSince = new Date(now.getTime() - this.paymentGraceMs);
    const inFlight: Prisma.ParentOrderWhereInput = {
      payments: { some: { status: PaymentStatus.INITIATED, createdAt: { gt: inFlightSince } } },
    };
    const due = await this.prisma.parentOrder.findMany({
      where: { paymentStatus: ParentOrderPaymentStatus.PENDING, paymentExpiresAt: { lte: now }, NOT: inFlight },
      select: { id: true },
      orderBy: { paymentExpiresAt: 'asc' },
      take: batchSize,
    });
    let expired = 0;
    for (const { id } of due) {
      try {
        const followUps: ProviderFollowUp[] = [];
        const done = await this.prisma.$transaction(async (tx) => {
          const order = await this.lockPending(tx, id);
          if (!order || order.paymentExpiresAt === null || order.paymentExpiresAt > now) return false;
          if ((await tx.parentOrder.count({ where: { id, ...inFlight } })) > 0) return false;
          await this.closeUnpaid(tx, id, 'PAYMENT_EXPIRED', undefined, SYSTEM_ACTOR, followUps);
          return true;
        });
        await this.creditOrders.followUp(followUps);
        if (done) expired += 1;
      } catch (error) {
        this.logger.error(`Could not expire order ${id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return expired;
  }

  // ─── paid orders: vendor and staff ────────────────────────────────────────

  async vendorTransition(userId: string, subOrderId: string, dto: VendorUpdateSubOrderStatusDto, actor: OrderActor): Promise<TransitionResult> {
    const store = await this.prisma.vendor.findUnique({ where: { userId }, select: { id: true, status: true } });
    if (!store) {
      throw new ForbiddenException('This account has no store');
    }
    // A suspended store still has to fulfil or cancel what it already sold.
    if (store.status !== VendorStatus.APPROVED && store.status !== VendorStatus.SUSPENDED) {
      throw new ForbiddenException(`The store is ${store.status}; it has no orders to manage`);
    }
    const parentOrderId = await this.parentOf(subOrderId, (sub) => sub.vendorId === store.id);

    return this.prisma.$transaction(async (tx) => {
      await lockParentOrder(tx, parentOrderId);
      const sub = await this.loadForTransition(tx, subOrderId);
      if (!sub || sub.vendorId !== store.id || sub.parentOrder.paymentStatus !== ParentOrderPaymentStatus.PAID) {
        throw new NotFoundException('Order not found');
      }
      if (!canVendorTransition(sub.status, dto.status)) {
        throw conflictWith('INVALID_STATUS_TRANSITION', `A ${sub.status} package cannot be moved to ${dto.status}`, {
          currentStatus: sub.status,
          allowedTransitions: vendorTransitionsFrom(sub.status),
        });
      }
      const now = new Date();
      const data: Prisma.SubOrderUpdateManyMutationInput =
        dto.status === SubOrderStatus.SHIPPED
          ? { status: dto.status, trackingCode: dto.trackingCode!, carrierName: dto.shippingCarrier!, shippedAt: now }
          : dto.status === SubOrderStatus.CANCELLED
            ? { status: dto.status, cancelledAt: now, cancellationReason: dto.reason! }
            : { status: dto.status };
      const note =
        dto.status === SubOrderStatus.SHIPPED ? `${dto.shippingCarrier!}: ${dto.trackingCode!}` : (dto.reason ?? null);
      return this.applyTransition(tx, sub, dto.status, data, { role: 'VENDOR', note, actor });
    });
  }

  async staffForce(subOrderId: string, dto: ForceSubOrderStatusDto, actor: OrderActor): Promise<TransitionResult> {
    const parentOrderId = await this.parentOf(subOrderId, () => true);
    return this.prisma.$transaction(async (tx) => {
      await lockParentOrder(tx, parentOrderId);
      const sub = await this.loadForTransition(tx, subOrderId);
      if (!sub) {
        throw new NotFoundException('Sub-order not found');
      }
      if (sub.parentOrder.paymentStatus !== ParentOrderPaymentStatus.PAID) {
        throw conflictWith('ORDER_NOT_PAID', 'Only packages of paid orders can be delivered or refunded', {
          paymentStatus: sub.parentOrder.paymentStatus,
        });
      }
      if (!canStaffForce(sub.status, dto.status)) {
        throw conflictWith('INVALID_STATUS_TRANSITION', `A ${sub.status} package cannot be forced to ${dto.status}`, {
          currentStatus: sub.status,
        });
      }
      const data: Prisma.SubOrderUpdateManyMutationInput =
        dto.status === SubOrderStatus.DELIVERED ? { status: dto.status, deliveredAt: new Date() } : { status: dto.status };
      return this.applyTransition(tx, sub, dto.status, data, { role: 'STAFF', note: dto.reason, actor });
    });
  }

  /**
   * The customer confirms receipt of a SHIPPED package: it becomes DELIVERED
   * and the vendor's escrow is released to the withdrawable balance.
   */
  async confirmDeliveryByCustomer(userId: string, parentOrderId: string, subOrderId: string, actor: OrderActor): Promise<TransitionResult> {
    return this.prisma.$transaction(async (tx) => {
      const locked = await lockParentOrder(tx, parentOrderId);
      const sub = locked ? await this.loadForTransition(tx, subOrderId) : null;
      if (!sub || sub.parentOrderId !== parentOrderId || sub.parentOrder.userId !== userId) {
        throw new NotFoundException('Order not found');
      }
      if (sub.parentOrder.paymentStatus !== ParentOrderPaymentStatus.PAID || sub.status !== SubOrderStatus.SHIPPED) {
        throw conflictWith('INVALID_STATUS_TRANSITION', `A ${sub.status} package cannot be confirmed as delivered; only SHIPPED packages can`, {
          currentStatus: sub.status,
        });
      }
      return this.applyTransition(tx, sub, SubOrderStatus.DELIVERED, { status: SubOrderStatus.DELIVERED, deliveredAt: new Date() }, {
        role: 'CUSTOMER',
        note: 'Receipt confirmed by the customer',
        actor,
      });
    });
  }

  // ─── disputes (Phase 9) ─────────────────────────────────────────────────

  /**
   * Applies a dispute decision to its package, inside the caller's transaction
   * (which already holds the parent-order lock): REFUNDED for the buyer,
   * DELIVERED for the vendor. A package that is already DELIVERED keeps its
   * status; only the wallet movement and the audit row are written.
   *
   * Credit-funded packages cannot be refunded yet (CREDIT_ORDER_REFUND_UNSUPPORTED,
   * same rule as every other refund path).
   */
  async applyDisputeOutcomeLocked(
    tx: Tx,
    subOrderId: string,
    target: typeof SubOrderStatus.REFUNDED | typeof SubOrderStatus.DELIVERED,
    meta: { role: ActorRole; note: string; actor: OrderActor },
    outcome: DisputeOutcome,
  ): Promise<TransitionResult> {
    const sub = await this.loadForTransition(tx, subOrderId);
    if (!sub) {
      throw new NotFoundException('Sub-order not found');
    }
    if (sub.parentOrder.paymentStatus !== ParentOrderPaymentStatus.PAID) {
      throw conflictWith('ORDER_NOT_PAID', 'Only packages of paid orders can be resolved', { paymentStatus: sub.parentOrder.paymentStatus });
    }
    if (sub.status === target) {
      const walletAction = await outcome.wallet(tx, sub);
      const auditLogId = await writeOrderAudit(tx, meta.actor, {
        action: AuditAction.DISPUTE_RESOLUTION,
        entityName: 'SubOrder',
        entityId: sub.id,
        oldValue: { status: sub.status },
        newValue: { status: target, subOrderNumber: sub.subOrderNumber, actorRole: meta.role, note: meta.note, stockAction: 'NONE', walletAction, ...outcome.audit },
      });
      return { subOrderId: sub.id, previousStatus: sub.status, stockAction: 'NONE', walletAction, auditLogId };
    }
    if (!canStaffForce(sub.status, target)) {
      throw conflictWith('INVALID_STATUS_TRANSITION', `A ${sub.status} package cannot be resolved to ${target}`, { currentStatus: sub.status });
    }
    const data: Prisma.SubOrderUpdateManyMutationInput =
      target === SubOrderStatus.DELIVERED ? { status: target, deliveredAt: new Date() } : { status: target };
    return this.applyTransition(tx, sub, target, data, meta, outcome);
  }

  // ─── internals ────────────────────────────────────────────────────────────

  private async lockPending(tx: Tx, parentOrderId: string): Promise<{ id: string; paymentExpiresAt: Date | null } | null> {
    if (!(await lockParentOrder(tx, parentOrderId))) {
      return null;
    }
    return tx.parentOrder.findFirst({
      where: { id: parentOrderId, paymentStatus: ParentOrderPaymentStatus.PENDING },
      select: { id: true, paymentExpiresAt: true },
    });
  }

  /**
   * Unpaid order leaves the funnel: credit reservations released (before stock,
   * per the lock order parent → credit account → stock → wallets), stock
   * reservations released, every package CANCELLED. Parent row must be locked;
   * the provider-side releases are appended to `followUps` for after the commit.
   */
  private async closeUnpaid(
    tx: Tx,
    parentOrderId: string,
    outcome: UnpaidOutcome,
    reason: string | undefined,
    actor: OrderActor,
    followUps: ProviderFollowUp[],
  ): Promise<string> {
    const rule = UNPAID_OUTCOME[outcome];
    const note = reason ?? rule.defaultReason;
    const now = new Date();
    const creditReleases = await this.creditOrders.releaseOpenReservationsLocked(tx, parentOrderId);
    followUps.push(...creditReleases);
    const subs = await tx.subOrder.findMany({
      where: { parentOrderId },
      select: { id: true, status: true, items: { select: { productVariantId: true, quantity: true } } },
    });
    for (const move of stockMovements(subs.flatMap((sub) => sub.items))) {
      await this.inventory.release(move.variantId, move.quantity, tx);
    }
    await tx.parentOrder.update({
      where: { id: parentOrderId },
      data: { paymentStatus: rule.status, cancelledAt: now, cancellationReason: note },
    });
    await tx.subOrder.updateMany({
      where: { parentOrderId },
      data: { status: SubOrderStatus.CANCELLED, cancelledAt: now, cancellationReason: note },
    });
    await tx.subOrderStatusHistory.createMany({
      data: subs.map((sub) => ({
        subOrderId: sub.id,
        fromStatus: sub.status,
        toStatus: SubOrderStatus.CANCELLED,
        actorUserId: actor.actorId,
        actorRole: rule.role,
        note,
      })),
    });
    return writeOrderAudit(tx, actor, {
      action: AuditAction.STATUS_CHANGE,
      entityName: 'ParentOrder',
      entityId: parentOrderId,
      oldValue: { paymentStatus: ParentOrderPaymentStatus.PENDING },
      newValue: {
        paymentStatus: rule.status,
        outcome,
        reason: note,
        releasedLines: subs.reduce((count, sub) => count + sub.items.length, 0),
        ...(creditReleases.length > 0 ? { creditReservationsReleased: creditReleases.map((r) => r.reservationRef) } : {}),
      },
    });
  }

  /** Resolves the parent id before locking; unknown or foreign sub-orders are a 404 (no existence leak). */
  private async parentOf(subOrderId: string, visible: (sub: { vendorId: string }) => boolean): Promise<string> {
    const sub = await this.prisma.subOrder.findUnique({ where: { id: subOrderId }, select: { parentOrderId: true, vendorId: true } });
    if (!sub || !visible(sub)) {
      throw new NotFoundException('Order not found');
    }
    return sub.parentOrderId;
  }

  private loadForTransition(tx: Tx, subOrderId: string): Promise<TransitionRow | null> {
    return tx.subOrder.findUnique({ where: { id: subOrderId }, select: transitionSelect });
  }

  private async applyTransition(
    tx: Tx,
    sub: TransitionRow,
    target: SubOrderStatus,
    data: Prisma.SubOrderUpdateManyMutationInput,
    meta: { role: ActorRole; note: string | null; actor: OrderActor },
    dispute?: DisputeOutcome,
  ): Promise<TransitionResult> {
    if (!dispute) {
      // Escrow freeze (Phase 9): while a dispute is active, the package changes only through the dispute.
      const active = await tx.dispute.findFirst({ where: { subOrderId: sub.id, status: { in: [...ACTIVE_DISPUTE_STATUSES] } }, select: { id: true, status: true } });
      if (active) {
        throw conflictWith('SUB_ORDER_UNDER_DISPUTE', 'This package has an active dispute; it can only change through the dispute resolution', {
          disputeId: active.id,
          disputeStatus: active.status,
        });
      }
    }
    if ((target === SubOrderStatus.CANCELLED || target === SubOrderStatus.REFUNDED) && sub.parentOrder.paymentMethod !== PaymentMethod.CASH_IPG) {
      // Returning bank credit (REFUND_RESTORE, schedule adjustment, provider refund API) is not in the Phase 8 scope.
      throw conflictWith(
        'CREDIT_ORDER_REFUND_UNSUPPORTED',
        `Packages of orders paid with ${sub.parentOrder.paymentMethod} cannot be cancelled or refunded yet; handle it with the credit provider manually`,
        { paymentMethod: sub.parentOrder.paymentMethod },
      );
    }
    // Guarded by the status read under the parent lock; the WHERE makes it explicit.
    const updated = await tx.subOrder.updateMany({ where: { id: sub.id, status: sub.status }, data });
    if (updated.count !== 1) {
      throw conflictWith('CONCURRENT_UPDATE', 'The package was changed by someone else; reload and try again');
    }
    const restock = dispute ? dispute.restock : paidStockEffect(sub.status, target) === 'RESTOCK';
    if (restock) {
      for (const move of stockMovements(sub.items)) {
        await this.inventory.adjustStock(move.variantId, move.quantity, tx);
      }
    }
    const walletAction = dispute ? await dispute.wallet(tx, sub) : await this.applyWalletEffect(tx, sub, target, meta.note);
    await tx.subOrderStatusHistory.create({
      data: { subOrderId: sub.id, fromStatus: sub.status, toStatus: target, actorUserId: meta.actor.actorId, actorRole: meta.role, note: meta.note },
    });
    const auditLogId = await writeOrderAudit(tx, meta.actor, {
      action: dispute ? AuditAction.DISPUTE_RESOLUTION : AuditAction.STATUS_CHANGE,
      entityName: 'SubOrder',
      entityId: sub.id,
      oldValue: { status: sub.status },
      newValue: {
        status: target,
        subOrderNumber: sub.subOrderNumber,
        actorRole: meta.role,
        note: meta.note,
        stockAction: restock ? 'RESTOCKED' : 'NONE',
        walletAction,
        ...(walletAction !== 'NONE' ? { vendorEarningsAmount: sub.vendorEarningsAmount.toFixed(2) } : {}),
        ...(restock ? { restockedLines: stockMovements(sub.items) } : {}),
        ...(dispute ? dispute.audit : {}),
      },
    });
    return { subOrderId: sub.id, previousStatus: sub.status, stockAction: restock ? 'RESTOCKED' : 'NONE', walletAction, auditLogId };
  }

  /** Escrow consequence of a transition on a paid package; runs under the parent lock, before the audit row. */
  private async applyWalletEffect(tx: Tx, sub: TransitionRow, target: SubOrderStatus, note: string | null): Promise<WalletAction> {
    if (target === SubOrderStatus.DELIVERED) {
      const released = await this.ledger.releaseEscrow(tx, sub);
      if (released) {
        await tx.subOrder.update({ where: { id: sub.id }, data: { escrowReleasedAt: new Date() } });
      }
      return released ? 'ESCROW_RELEASED' : 'NONE';
    }
    if (target === SubOrderStatus.CANCELLED || target === SubOrderStatus.REFUNDED) {
      const outcome: ReverseOutcome = await this.ledger.reverseEscrow(tx, sub, note ?? target);
      return outcome === 'FROM_PENDING' ? 'ESCROW_REVERSED' : outcome === 'FROM_WITHDRAWABLE' ? 'EARNINGS_REVERSED' : 'NONE';
    }
    return 'NONE';
  }
}

const transitionSelect = {
  id: true,
  vendorId: true,
  subOrderNumber: true,
  parentOrderId: true,
  vendorEarningsAmount: true,
  status: true,
  parentOrder: { select: { paymentStatus: true, userId: true, paymentMethod: true } },
  items: { select: { productVariantId: true, quantity: true } },
} satisfies Prisma.SubOrderSelect;

type TransitionRow = Prisma.SubOrderGetPayload<{ select: typeof transitionSelect }>;
