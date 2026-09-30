import { Injectable, NotFoundException } from '@nestjs/common';
import {
  AuditAction,
  DisputeEventType,
  DisputeStatus,
  DisputeVendorAction,
  MediaKind,
  Prisma,
  SubOrderStatus,
  WalletBalanceBucket,
} from '@prisma/client';
import { TooManyRequestsException } from '../../common/exceptions/too-many-requests.exception';
import { badRequestWith, conflictWith } from '../../common/http-errors';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { RedisService } from '../../infra/redis/redis.service';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { lockParentOrder, writeOrderAudit, type OrderActor } from '../orders/order-audit';
import { OrderLifecycleService } from '../orders/order-lifecycle.service';
import type { ActorRole } from '../orders/order-views';
import { WalletLedgerService, type DisputeRefund } from '../wallet/wallet-ledger.service';
import { requireStore } from '../wallet/vendor-store';
import { DisputeNotifier, type RefundNotice } from './dispute-notifier';
import { customerCanCancel, MAX_DISPUTES_PER_DAY, openRejection, refundDue, shouldRestock, staffCanArbitrate, vendorCanRespond } from './dispute-policy';
import { DisputeQueriesService } from './dispute-queries.service';
import type { ArbitrateDisputeDto, CancelDisputeDto, CreateDisputeDto, DisputeActionResultDto, VendorRespondDisputeDto } from './dto/dispute.dto';

type Tx = Prisma.TransactionClient;
type WalletResult = DisputeActionResultDto['walletAction'];

const DAY_SECONDS = 24 * 60 * 60;
export const EVIDENCE_PURPOSE = 'dispute_evidence';
export const disputeOpenCountKey = (userId: string): string => `dispute:open:count:${userId}`;

/** The dispute as the commands need it, read under the parent-order lock. */
const lockedSelect = {
  id: true,
  status: true,
  subOrderId: true,
  holdSource: true,
  holdAmount: true,
  holdShortfall: true,
  raisedBy: { select: { mobile: true } },
  subOrder: {
    select: { id: true, vendorId: true, subOrderNumber: true, vendorEarningsAmount: true, status: true, itemsSubtotal: true, shippingFee: true },
  },
} satisfies Prisma.DisputeSelect;
type LockedDispute = Prisma.DisputeGetPayload<{ select: typeof lockedSelect }>;

interface EvidenceAsset {
  id: string;
  url: string;
  mimeType: string;
}

interface Decision {
  role: ActorRole;
  userId: string;
  notes: string;
  itemReturned: boolean | undefined;
  event: DisputeEventType;
  actor: OrderActor;
}

interface Resolved {
  walletAction: WalletResult;
  stockAction: 'RESTOCKED' | 'NONE';
  subOrderStatus: SubOrderStatus;
  notice: RefundNotice | null;
}

/**
 * State-changing side of disputes (Phase 9).
 *
 * Every command takes the **parent-order lock first** — the same lock the order
 * lifecycle, payment callbacks and delivery confirmation take — so a dispute can
 * never race a status change of its package. Lock order stays
 * parent → stock → wallet. The dispute row, its evidence and timeline, the wallet
 * ledger, the package status and the audit rows commit in one transaction; the
 * refund SMS goes out only after the commit.
 */
@Injectable()
export class DisputesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly ledger: WalletLedgerService,
    private readonly lifecycle: OrderLifecycleService,
    private readonly notifier: DisputeNotifier,
    private readonly queries: DisputeQueriesService,
  ) {}

  // ─── customer ─────────────────────────────────────────────────────────────

  async open(user: AuthenticatedUser, dto: CreateDisputeDto, actor: OrderActor): Promise<DisputeActionResultDto> {
    const owned = await this.prisma.subOrder.findFirst({
      where: { id: dto.subOrderId, parentOrder: { userId: user.id } },
      select: { parentOrderId: true },
    });
    if (!owned) {
      throw new NotFoundException('Sub-order not found');
    }
    const evidence = await this.resolveEvidence(dto.evidenceUrls, user.id);
    await this.enforceDailyLimit(user.id);

    const opened = await this.prisma.$transaction(async (tx) => {
      await lockParentOrder(tx, owned.parentOrderId);
      const sub = await tx.subOrder.findUniqueOrThrow({
        where: { id: dto.subOrderId },
        select: {
          id: true,
          vendorId: true,
          subOrderNumber: true,
          vendorEarningsAmount: true,
          status: true,
          parentOrder: { select: { paymentStatus: true } },
          disputes: { select: { id: true, status: true } },
        },
      });
      const rejection = openRejection(sub.parentOrder.paymentStatus === 'PAID', sub.status, sub.disputes);
      if (rejection) {
        const { code, message, ...details } = rejection;
        throw conflictWith(code, message, details);
      }

      const dispute = await tx.dispute
        .create({
          data: {
            subOrderId: sub.id,
            vendorId: sub.vendorId,
            raisedByUserId: user.id,
            reason: dto.reason,
            description: dto.description,
            subOrderStatusAtOpen: sub.status,
          },
          select: { id: true },
        })
        .catch((error: unknown) => {
          // Backstop of the partial unique index "one active dispute per package".
          if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
            throw conflictWith('DISPUTE_ALREADY_ACTIVE', 'This package already has an active dispute');
          }
          throw error;
        });

      const freeze = await this.ledger.freezeForDispute(tx, sub, dispute.id);
      await tx.dispute.update({
        where: { id: dispute.id },
        data: { holdSource: freeze.source, holdAmount: freeze.amount, holdShortfall: freeze.shortfall },
      });
      await this.addEvidence(tx, dispute.id, user.id, evidence);

      const shortfallNote = freeze.shortfall.greaterThan(0)
        ? ` Shortfall ${freeze.shortfall.toFixed(2)}: the store had already withdrawn part of these earnings.`
        : '';
      await tx.disputeEvent.create({
        data: {
          disputeId: dispute.id,
          type: DisputeEventType.OPENED,
          actorUserId: user.id,
          actorRole: 'CUSTOMER',
          toStatus: DisputeStatus.OPEN,
          note: `Dispute opened (${dto.reason}).${shortfallNote}`.slice(0, 1000),
          data: {
            reason: dto.reason,
            evidenceCount: evidence.length,
            holdSource: freeze.source,
            holdAmount: freeze.amount.toFixed(2),
            holdShortfall: freeze.shortfall.toFixed(2),
          },
        },
      });
      await writeOrderAudit(tx, actor, {
        action: AuditAction.CREATE,
        entityName: 'Dispute',
        entityId: dispute.id,
        newValue: {
          subOrderId: sub.id,
          subOrderNumber: sub.subOrderNumber,
          reason: dto.reason,
          status: DisputeStatus.OPEN,
          subOrderStatus: sub.status,
          holdSource: freeze.source,
          holdAmount: freeze.amount.toFixed(2),
          holdShortfall: freeze.shortfall.toFixed(2),
          evidenceCount: evidence.length,
        },
      });
      return { id: dispute.id, frozen: freeze.source !== null, subOrderStatus: sub.status };
    });

    return this.result(opened.id, opened.frozen ? 'FROZEN' : 'NONE', opened.subOrderStatus, 'NONE');
  }

  /** The customer withdraws the dispute: the frozen earnings go back where they came from; the package keeps its status. */
  async cancel(user: AuthenticatedUser, disputeId: string, dto: CancelDisputeDto, actor: OrderActor): Promise<DisputeActionResultDto> {
    const parentOrderId = await this.parentOf({ id: disputeId, raisedByUserId: user.id });

    const done = await this.prisma.$transaction(async (tx) => {
      await lockParentOrder(tx, parentOrderId);
      const dispute = await this.locked(tx, disputeId);
      if (!customerCanCancel(dispute.status)) {
        throw conflictWith('DISPUTE_NOT_CANCELLABLE', `A ${dispute.status} dispute cannot be cancelled`, { status: dispute.status });
      }
      const credited = await this.ledger.releaseDisputeHold(tx, dispute.subOrder, dispute, 'SOURCE');
      await tx.dispute.update({ where: { id: dispute.id }, data: { status: DisputeStatus.CANCELLED, cancelledAt: new Date() } });
      const note = dto.reason ?? 'Cancelled by the customer';
      await tx.disputeEvent.create({
        data: {
          disputeId: dispute.id,
          type: DisputeEventType.CANCELLED_BY_CUSTOMER,
          actorUserId: user.id,
          actorRole: 'CUSTOMER',
          fromStatus: dispute.status,
          toStatus: DisputeStatus.CANCELLED,
          note,
          data: { holdReturnedTo: credited, amount: dispute.holdAmount.toFixed(2) },
        },
      });
      await writeOrderAudit(tx, actor, {
        action: AuditAction.STATUS_CHANGE,
        entityName: 'Dispute',
        entityId: dispute.id,
        oldValue: { status: dispute.status },
        newValue: { status: DisputeStatus.CANCELLED, note, holdReturnedTo: credited, amount: dispute.holdAmount.toFixed(2) },
      });
      const walletAction: WalletResult =
        credited === null ? 'NONE' : credited === WalletBalanceBucket.WITHDRAWABLE ? 'RELEASED_TO_WITHDRAWABLE' : 'RETURNED_TO_ESCROW';
      return { walletAction, subOrderStatus: dispute.subOrder.status };
    });

    return this.result(disputeId, done.walletAction, done.subOrderStatus, 'NONE');
  }

  // ─── vendor ───────────────────────────────────────────────────────────────

  async respond(user: AuthenticatedUser, disputeId: string, dto: VendorRespondDisputeDto, actor: OrderActor): Promise<DisputeActionResultDto> {
    const store = await requireStore(this.prisma, user.id);
    const parentOrderId = await this.parentOf({ id: disputeId, vendorId: store.id });
    const evidence = await this.resolveEvidence(dto.evidenceUrls ?? [], user.id);

    const done = await this.prisma.$transaction(async (tx): Promise<Resolved> => {
      await lockParentOrder(tx, parentOrderId);
      const dispute = await this.locked(tx, disputeId);
      if (!vendorCanRespond(dispute.status)) {
        throw conflictWith('DISPUTE_NOT_AWAITING_VENDOR', `The store can no longer answer a ${dispute.status} dispute`, { status: dispute.status });
      }
      await tx.dispute.update({
        where: { id: dispute.id },
        data: { vendorAction: dto.action, vendorDefenseNotes: dto.defenseNotes, vendorRespondedAt: new Date(), vendorRespondedByUserId: user.id },
      });
      await this.addEvidence(tx, dispute.id, user.id, evidence);

      if (dto.action === DisputeVendorAction.ACCEPT_RETURN) {
        return this.resolveForBuyer(tx, dispute, {
          role: 'VENDOR',
          userId: user.id,
          notes: `Store accepted the return: ${dto.defenseNotes}`,
          itemReturned: dto.itemReturned,
          event: DisputeEventType.VENDOR_ACCEPTED_RETURN,
          actor,
        });
      }

      await tx.dispute.update({ where: { id: dispute.id }, data: { status: DisputeStatus.UNDER_ARBITRATION } });
      await tx.disputeEvent.create({
        data: {
          disputeId: dispute.id,
          type: DisputeEventType.VENDOR_DEFENDED,
          actorUserId: user.id,
          actorRole: 'VENDOR',
          fromStatus: dispute.status,
          toStatus: DisputeStatus.UNDER_ARBITRATION,
          note: dto.defenseNotes.slice(0, 1000),
          data: { evidenceCount: evidence.length },
        },
      });
      await writeOrderAudit(tx, actor, {
        action: AuditAction.STATUS_CHANGE,
        entityName: 'Dispute',
        entityId: dispute.id,
        oldValue: { status: dispute.status },
        newValue: { status: DisputeStatus.UNDER_ARBITRATION, vendorAction: dto.action, evidenceCount: evidence.length },
      });
      return { walletAction: 'NONE', stockAction: 'NONE', subOrderStatus: dispute.subOrder.status, notice: null };
    });

    return this.finish(disputeId, done);
  }

  // ─── staff ────────────────────────────────────────────────────────────────

  async arbitrate(user: AuthenticatedUser, disputeId: string, dto: ArbitrateDisputeDto, actor: OrderActor): Promise<DisputeActionResultDto> {
    const parentOrderId = await this.parentOf({ id: disputeId });

    const done = await this.prisma.$transaction(async (tx): Promise<Resolved> => {
      await lockParentOrder(tx, parentOrderId);
      const dispute = await this.locked(tx, disputeId);
      if (!staffCanArbitrate(dispute.status)) {
        throw conflictWith('DISPUTE_ALREADY_CLOSED', `A ${dispute.status} dispute cannot be arbitrated`, { status: dispute.status });
      }
      if (dto.decision === 'BUYER_FAVOR') {
        return this.resolveForBuyer(tx, dispute, {
          role: 'STAFF',
          userId: user.id,
          notes: dto.resolutionNotes,
          itemReturned: dto.itemReturned,
          event: DisputeEventType.ARBITRATED_BUYER_FAVOR,
          actor,
        });
      }
      return this.resolveForVendor(tx, dispute, {
        role: 'STAFF',
        userId: user.id,
        notes: dto.resolutionNotes,
        itemReturned: undefined,
        event: DisputeEventType.ARBITRATED_VENDOR_FAVOR,
        actor,
      });
    });

    return this.finish(disputeId, done);
  }

  // ─── outcomes ─────────────────────────────────────────────────────────────

  /**
   * Buyer favour: package REFUNDED (restocked when appropriate), frozen earnings
   * deducted with REFUND_DEDUCTION (plus any shortfall recovered from the
   * current withdrawable balance), refund owed to the customer recorded.
   */
  private async resolveForBuyer(tx: Tx, dispute: LockedDispute, decision: Decision): Promise<Resolved> {
    const restock = shouldRestock(dispute.subOrder.status, decision.itemReturned);
    let refund: DisputeRefund | null = null;
    const transition = await this.lifecycle.applyDisputeOutcomeLocked(
      tx,
      dispute.subOrderId,
      SubOrderStatus.REFUNDED,
      { role: decision.role, note: decision.notes.slice(0, 500), actor: decision.actor },
      {
        restock,
        wallet: async (walletTx, pkg) => {
          refund = await this.ledger.refundDisputeHold(walletTx, pkg, dispute, decision.notes);
          return refund.fromHold.plus(refund.fromWithdrawable).greaterThan(0) ? 'DISPUTE_HOLD_REFUNDED' : 'NONE';
        },
        audit: { disputeId: dispute.id, decision: 'BUYER_FAVOR', itemReturned: decision.itemReturned ?? null },
      },
    );
    const settled = refund as DisputeRefund | null;
    const fromHold = settled?.fromHold ?? new Prisma.Decimal(0);
    const fromWithdrawable = settled?.fromWithdrawable ?? new Prisma.Decimal(0);
    const unrecovered = settled?.unrecovered ?? new Prisma.Decimal(0);
    const amount = refundDue(dispute.subOrder);
    const restocked = transition.stockAction === 'RESTOCKED';

    await tx.dispute.update({
      where: { id: dispute.id },
      data: {
        status: DisputeStatus.RESOLVED_BUYER_FAVOR,
        resolvedAt: new Date(),
        resolvedByUserId: decision.userId,
        resolutionNotes: decision.notes,
        itemReturned: decision.itemReturned ?? null,
        restocked,
        refundAmount: amount,
        refundUnrecoveredAmount: unrecovered,
      },
    });
    const financial = {
      refundAmount: amount.toFixed(2),
      deductedFromHold: fromHold.toFixed(2),
      recoveredFromWithdrawable: fromWithdrawable.toFixed(2),
      unrecovered: unrecovered.toFixed(2),
      restocked,
    };
    await this.closeWith(tx, dispute, decision, DisputeStatus.RESOLVED_BUYER_FAVOR, financial);

    const deducted = fromHold.plus(fromWithdrawable).greaterThan(0);
    return {
      walletAction: deducted ? 'REFUNDED' : 'NONE',
      stockAction: transition.stockAction,
      subOrderStatus: SubOrderStatus.REFUNDED,
      notice: { disputeId: dispute.id, mobile: dispute.raisedBy.mobile, subOrderNumber: dispute.subOrder.subOrderNumber, amount: amount.toFixed(0) },
    };
  }

  /** Vendor favour: package DELIVERED, frozen earnings released to WITHDRAWABLE, escrow marked released. */
  private async resolveForVendor(tx: Tx, dispute: LockedDispute, decision: Decision): Promise<Resolved> {
    let credited: WalletBalanceBucket | null = null;
    const transition = await this.lifecycle.applyDisputeOutcomeLocked(
      tx,
      dispute.subOrderId,
      SubOrderStatus.DELIVERED,
      { role: decision.role, note: decision.notes.slice(0, 500), actor: decision.actor },
      {
        restock: false,
        wallet: async (walletTx, pkg) => {
          credited = await this.ledger.releaseDisputeHold(walletTx, pkg, dispute, 'WITHDRAWABLE');
          await walletTx.subOrder.updateMany({ where: { id: pkg.id, escrowReleasedAt: null }, data: { escrowReleasedAt: new Date() } });
          return credited === null ? 'NONE' : 'DISPUTE_HOLD_RELEASED';
        },
        audit: { disputeId: dispute.id, decision: 'VENDOR_FAVOR' },
      },
    );
    await tx.dispute.update({
      where: { id: dispute.id },
      data: { status: DisputeStatus.RESOLVED_VENDOR_FAVOR, resolvedAt: new Date(), resolvedByUserId: decision.userId, resolutionNotes: decision.notes },
    });
    await this.closeWith(tx, dispute, decision, DisputeStatus.RESOLVED_VENDOR_FAVOR, {
      releasedToWithdrawable: credited === null ? '0.00' : dispute.holdAmount.toFixed(2),
    });
    return {
      walletAction: credited === null ? 'NONE' : 'RELEASED_TO_WITHDRAWABLE',
      stockAction: transition.stockAction,
      subOrderStatus: SubOrderStatus.DELIVERED,
      notice: null,
    };
  }

  private async closeWith(tx: Tx, dispute: LockedDispute, decision: Decision, status: DisputeStatus, financial: Record<string, unknown>): Promise<void> {
    await tx.disputeEvent.create({
      data: {
        disputeId: dispute.id,
        type: decision.event,
        actorUserId: decision.userId,
        actorRole: decision.role,
        fromStatus: dispute.status,
        toStatus: status,
        note: decision.notes.slice(0, 1000),
        data: financial as Prisma.InputJsonObject,
      },
    });
    await writeOrderAudit(tx, decision.actor, {
      action: AuditAction.DISPUTE_RESOLUTION,
      entityName: 'Dispute',
      entityId: dispute.id,
      oldValue: { status: dispute.status, subOrderStatus: dispute.subOrder.status },
      newValue: {
        status,
        decidedBy: decision.role,
        subOrderId: dispute.subOrderId,
        subOrderNumber: dispute.subOrder.subOrderNumber,
        holdSource: dispute.holdSource,
        holdAmount: dispute.holdAmount.toFixed(2),
        holdShortfall: dispute.holdShortfall.toFixed(2),
        ...financial,
      },
    });
  }

  // ─── helpers ──────────────────────────────────────────────────────────────

  private async finish(disputeId: string, done: Resolved): Promise<DisputeActionResultDto> {
    if (done.notice) {
      await this.notifier.refundNotice(done.notice);
    }
    return this.result(disputeId, done.walletAction, done.subOrderStatus, done.stockAction);
  }

  private async result(
    disputeId: string,
    walletAction: WalletResult,
    subOrderStatus: SubOrderStatus,
    stockAction: 'RESTOCKED' | 'NONE',
  ): Promise<DisputeActionResultDto> {
    return { dispute: await this.queries.shared(disputeId), walletAction, subOrderStatus, stockAction };
  }

  /** Parent order of a dispute the caller may act on; 404 otherwise (never reveals foreign disputes). */
  private async parentOf(where: Prisma.DisputeWhereInput): Promise<string> {
    const found = await this.prisma.dispute.findFirst({ where, select: { subOrder: { select: { parentOrderId: true } } } });
    if (!found) {
      throw new NotFoundException('Dispute not found');
    }
    return found.subOrder.parentOrderId;
  }

  private locked(tx: Tx, disputeId: string): Promise<LockedDispute> {
    return tx.dispute.findUniqueOrThrow({ where: { id: disputeId }, select: lockedSelect });
  }

  /**
   * Evidence URLs → the caller's own private `dispute_evidence` documents.
   * Anything else (someone else's file, a KYC document, a public image) is 400:
   * attaching it would expose it to the other party of the dispute.
   */
  private async resolveEvidence(urls: readonly string[], userId: string): Promise<EvidenceAsset[]> {
    if (urls.length === 0) return [];
    const ids = urls.map((url) => url.split('/').at(-2) ?? '');
    const assets = await this.prisma.mediaAsset.findMany({
      where: { id: { in: ids } },
      select: { id: true, ownerUserId: true, purpose: true, kind: true, isPublic: true, mimeType: true },
    });
    return urls.map((url, index) => {
      const asset = assets.find((candidate) => candidate.id === ids[index]);
      if (!asset || asset.ownerUserId !== userId || asset.purpose !== EVIDENCE_PURPOSE || asset.kind !== MediaKind.DOCUMENT || asset.isPublic) {
        throw badRequestWith(
          'EVIDENCE_NOT_ACCEPTED',
          `Evidence must be your own upload from POST /media/upload/document with purpose ${EVIDENCE_PURPOSE}`,
          { url },
        );
      }
      return { id: asset.id, url, mimeType: asset.mimeType };
    });
  }

  private async addEvidence(tx: Tx, disputeId: string, userId: string, evidence: readonly EvidenceAsset[]): Promise<void> {
    if (evidence.length === 0) return;
    const existing = await tx.disputeEvidence.findMany({
      where: { disputeId, mediaAssetId: { in: evidence.map((item) => item.id) } },
      select: { mediaAssetId: true },
    });
    const fresh = evidence.filter((item) => !existing.some((row) => row.mediaAssetId === item.id));
    if (fresh.length === 0) return;
    await tx.disputeEvidence.createMany({
      data: fresh.map((item) => ({ disputeId, uploadedByUserId: userId, mediaAssetId: item.id, fileUrl: item.url, fileType: item.mimeType.slice(0, 40) })),
    });
  }

  private async enforceDailyLimit(userId: string): Promise<void> {
    const key = disputeOpenCountKey(userId);
    const count = await this.redis.client.incr(key);
    if (count === 1) await this.redis.client.expire(key, DAY_SECONDS);
    if (count > MAX_DISPUTES_PER_DAY) {
      const ttl = await this.redis.client.ttl(key);
      throw new TooManyRequestsException('Too many disputes opened today; try again later', ttl > 0 ? ttl : DAY_SECONDS);
    }
  }
}
