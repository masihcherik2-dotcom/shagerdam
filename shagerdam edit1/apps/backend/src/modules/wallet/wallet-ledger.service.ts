import { Injectable } from '@nestjs/common';
import { Prisma, WalletBalanceBucket, WalletTransactionType } from '@prisma/client';
import { conflictWith } from '../../common/http-errors';
import { InsufficientBalanceError, escrowStateOf, planEntries, type BucketBalances, type EscrowState, type LedgerEntry } from './wallet-math';

type Tx = Prisma.TransactionClient;

const { PENDING, WITHDRAWABLE, SETTLEMENT_HOLD, DISPUTE_HOLD } = WalletBalanceBucket;
const ZERO = new Prisma.Decimal(0);

/** Package fields the escrow operations need. */
export interface EscrowSubOrder {
  id: string;
  vendorId: string;
  subOrderNumber: string;
  vendorEarningsAmount: Prisma.Decimal;
}

interface LockedWallet {
  id: string;
  balances: BucketBalances;
  totalEarned: Prisma.Decimal;
  totalWithdrawn: Prisma.Decimal;
}

interface WalletRow {
  id: string;
  pending_balance: Prisma.Decimal;
  withdrawable_balance: Prisma.Decimal;
  settlement_hold_balance: Prisma.Decimal;
  dispute_hold_balance: Prisma.Decimal;
  total_earned_balance: Prisma.Decimal;
  total_withdrawn_amount: Prisma.Decimal;
}

export type ReverseOutcome = 'NONE' | 'FROM_PENDING' | 'FROM_WITHDRAWABLE';

/** What opening a dispute froze (Phase 9). `source` is null when nothing could be frozen. */
export interface DisputeFreeze {
  source: typeof PENDING | typeof WITHDRAWABLE | null;
  amount: Prisma.Decimal;
  /** Delivered packages only: earnings the vendor had already moved out of WITHDRAWABLE. */
  shortfall: Prisma.Decimal;
}

/** The frozen position of a dispute, as recorded on the dispute row. */
export interface DisputeHoldPosition {
  id: string;
  holdSource: WalletBalanceBucket | null;
  holdAmount: Prisma.Decimal;
  holdShortfall: Prisma.Decimal;
}

export interface DisputeRefund {
  fromHold: Prisma.Decimal;
  /** Part of the shortfall recovered from the vendor's current WITHDRAWABLE balance. */
  fromWithdrawable: Prisma.Decimal;
  /** Earnings that could not be recovered at all (vendor debt, reported to staff). */
  unrecovered: Prisma.Decimal;
}

/**
 * The only writer of vendor wallets. Every method runs inside the caller's
 * transaction, locks the wallet row (`SELECT … FOR UPDATE`, creating the wallet
 * on first use), appends ledger rows and updates the balance projection in the
 * same statement set — so the ledger and the balances commit or roll back
 * together, and concurrent writers to one wallet are serialised.
 *
 * Lock order is always parent order → wallet(s) sorted by vendor id →
 * settlement request, which keeps concurrent payments, deliveries and
 * settlements deadlock-free.
 *
 * Idempotency: package operations derive the package's escrow state from its
 * own ledger rows (`escrowStateOf`) and do nothing when the step already
 * happened; the partial unique indexes of migration phase7_finance reject a
 * duplicate movement even if this check were bypassed.
 */
@Injectable()
export class WalletLedgerService {
  /** Sale confirmed: the vendor's earnings enter escrow (PENDING). Returns false if already held or nothing to hold. */
  async holdSaleEscrow(tx: Tx, sub: EscrowSubOrder): Promise<boolean> {
    if (!sub.vendorEarningsAmount.greaterThan(0)) return false;
    const wallet = await this.lock(tx, sub.vendorId);
    if ((await this.escrowState(tx, sub.id)) !== 'NONE') return false;
    await this.post(tx, wallet, [
      {
        type: WalletTransactionType.CREDIT_SALE_ESCROW_HOLD,
        bucket: PENDING,
        amount: sub.vendorEarningsAmount,
        subOrderId: sub.id,
        description: `Escrow hold for package ${sub.subOrderNumber}`,
      },
    ]);
    return true;
  }

  /** Package delivered: escrow moves to WITHDRAWABLE once. Returns false if there is nothing held to release. */
  async releaseEscrow(tx: Tx, sub: EscrowSubOrder): Promise<boolean> {
    const wallet = await this.lock(tx, sub.vendorId);
    const state = await this.escrowState(tx, sub.id);
    if (state === 'FROZEN') throw frozenError(sub);
    if (state !== 'HELD') return false;
    const description = `Escrow released on delivery of package ${sub.subOrderNumber}`;
    await this.post(
      tx,
      wallet,
      [
        { type: WalletTransactionType.ESCROW_RELEASE_TO_WITHDRAWABLE, bucket: PENDING, amount: sub.vendorEarningsAmount.negated(), subOrderId: sub.id, description },
        { type: WalletTransactionType.ESCROW_RELEASE_TO_WITHDRAWABLE, bucket: WITHDRAWABLE, amount: sub.vendorEarningsAmount, subOrderId: sub.id, description },
      ],
      { earned: sub.vendorEarningsAmount },
    );
    return true;
  }

  /**
   * Package cancelled or refunded: the vendor's earnings leave the wallet.
   * Before delivery they come out of escrow; after delivery out of the
   * withdrawable balance (409 INSUFFICIENT_WALLET_BALANCE if the vendor already
   * requested it — balances never go negative). No-op when nothing was ever
   * held (e.g. zero earnings) or it was already reversed.
   */
  async reverseEscrow(tx: Tx, sub: EscrowSubOrder, reason: string): Promise<ReverseOutcome> {
    const wallet = await this.lock(tx, sub.vendorId);
    const state = await this.escrowState(tx, sub.id);
    if (state === 'FROZEN') throw frozenError(sub);
    if (state === 'NONE' || state === 'REVERSED') return 'NONE';
    const fromWithdrawable = state === 'RELEASED';
    await this.post(
      tx,
      wallet,
      [
        {
          type: WalletTransactionType.REFUND_DEDUCTION,
          bucket: fromWithdrawable ? WITHDRAWABLE : PENDING,
          amount: sub.vendorEarningsAmount.negated(),
          subOrderId: sub.id,
          description: `Refund of package ${sub.subOrderNumber}: ${reason}`.slice(0, 255),
        },
      ],
      fromWithdrawable ? { earned: sub.vendorEarningsAmount.negated() } : {},
    );
    return fromWithdrawable ? 'FROM_WITHDRAWABLE' : 'FROM_PENDING';
  }

  // ─── disputes (Phase 9) ─────────────────────────────────────────────────

  /**
   * A dispute was opened: the package's earnings move into DISPUTE_HOLD, where
   * no delivery confirmation, cancellation or settlement can touch them.
   *
   * - Not delivered (escrow HELD): the full earnings, PENDING → DISPUTE_HOLD.
   *   They leave escrow here, so `totalEarned` grows by the same amount — this
   *   keeps `totalEarned ≥ withdrawn + withdrawable + disputeHold` exact.
   * - Delivered (escrow RELEASED): `min(earnings, withdrawable)`, WITHDRAWABLE →
   *   DISPUTE_HOLD; the rest is the shortfall the vendor already requested or
   *   withdrew. `totalEarned` is unchanged (the money was already counted).
   * - Zero earnings (nothing was escrowed): nothing to freeze.
   */
  async freezeForDispute(tx: Tx, sub: EscrowSubOrder, disputeId: string): Promise<DisputeFreeze> {
    const wallet = await this.lock(tx, sub.vendorId);
    const state = await this.escrowState(tx, sub.id);
    const earnings = sub.vendorEarningsAmount;
    const description = `Frozen by a dispute on package ${sub.subOrderNumber}`;
    if (state === 'NONE') return { source: null, amount: ZERO, shortfall: ZERO };
    if (state === 'HELD') {
      await this.post(
        tx,
        wallet,
        [
          { type: WalletTransactionType.DISPUTE_HOLD_LOCK, bucket: PENDING, amount: earnings.negated(), subOrderId: sub.id, disputeId, description },
          { type: WalletTransactionType.DISPUTE_HOLD_LOCK, bucket: DISPUTE_HOLD, amount: earnings, subOrderId: sub.id, disputeId, description },
        ],
        { earned: earnings },
      );
      return { source: PENDING, amount: earnings, shortfall: ZERO };
    }
    if (state === 'RELEASED') {
      const available = wallet.balances[WITHDRAWABLE];
      const amount = Prisma.Decimal.min(earnings, available);
      const shortfall = earnings.minus(amount);
      if (!amount.greaterThan(0)) return { source: null, amount: ZERO, shortfall };
      await this.post(tx, wallet, [
        { type: WalletTransactionType.DISPUTE_HOLD_LOCK, bucket: WITHDRAWABLE, amount: amount.negated(), subOrderId: sub.id, disputeId, description },
        { type: WalletTransactionType.DISPUTE_HOLD_LOCK, bucket: DISPUTE_HOLD, amount, subOrderId: sub.id, disputeId, description },
      ]);
      return { source: WITHDRAWABLE, amount, shortfall };
    }
    throw conflictWith('ESCROW_NOT_FREEZABLE', `The earnings of package ${sub.subOrderNumber} are ${state.toLowerCase()} and cannot be frozen`, { escrowState: state });
  }

  /**
   * Buyer-favour resolution: the frozen amount is deducted (REFUND_DEDUCTION on
   * DISPUTE_HOLD). A shortfall recorded at opening is recovered from whatever
   * WITHDRAWABLE balance the vendor has now; anything left is returned as
   * `unrecovered` (balances never go negative). `totalEarned` shrinks by all
   * that was deducted.
   */
  async refundDisputeHold(tx: Tx, sub: EscrowSubOrder, dispute: DisputeHoldPosition, reason: string): Promise<DisputeRefund> {
    const wallet = await this.lock(tx, sub.vendorId);
    const state = await this.escrowState(tx, sub.id);
    if (dispute.holdAmount.greaterThan(0) && state !== 'FROZEN') {
      throw conflictWith('ESCROW_NOT_FROZEN', `The earnings of package ${sub.subOrderNumber} are not frozen (${state})`, { escrowState: state });
    }
    const description = `Refund of package ${sub.subOrderNumber} (dispute): ${reason}`.slice(0, 255);
    const entries: LedgerEntry[] = [];
    if (dispute.holdAmount.greaterThan(0)) {
      entries.push({ type: WalletTransactionType.REFUND_DEDUCTION, bucket: DISPUTE_HOLD, amount: dispute.holdAmount.negated(), subOrderId: sub.id, disputeId: dispute.id, description });
    }
    const fromWithdrawable = Prisma.Decimal.min(dispute.holdShortfall, wallet.balances[WITHDRAWABLE]);
    if (fromWithdrawable.greaterThan(0)) {
      entries.push({ type: WalletTransactionType.REFUND_DEDUCTION, bucket: WITHDRAWABLE, amount: fromWithdrawable.negated(), subOrderId: sub.id, disputeId: dispute.id, description });
    }
    const deducted = dispute.holdAmount.plus(fromWithdrawable);
    if (entries.length > 0) {
      await this.post(tx, wallet, entries, { earned: deducted.negated() });
    }
    return { fromHold: dispute.holdAmount, fromWithdrawable, unrecovered: dispute.holdShortfall.minus(fromWithdrawable) };
  }

  /**
   * The frozen amount leaves DISPUTE_HOLD (DISPUTE_HOLD_RELEASE):
   * - `WITHDRAWABLE`: vendor-favour resolution — released to the vendor;
   * - `SOURCE`: the customer cancelled — back where it came from (PENDING for a
   *   package not delivered yet, which un-counts it from `totalEarned`, or
   *   WITHDRAWABLE for a delivered one).
   * Returns the bucket credited, or null when nothing was frozen.
   */
  async releaseDisputeHold(tx: Tx, sub: EscrowSubOrder, dispute: DisputeHoldPosition, to: 'WITHDRAWABLE' | 'SOURCE'): Promise<WalletBalanceBucket | null> {
    if (!dispute.holdAmount.greaterThan(0) || dispute.holdSource === null) return null;
    const wallet = await this.lock(tx, sub.vendorId);
    const state = await this.escrowState(tx, sub.id);
    if (state !== 'FROZEN') {
      throw conflictWith('ESCROW_NOT_FROZEN', `The earnings of package ${sub.subOrderNumber} are not frozen (${state})`, { escrowState: state });
    }
    const target = to === 'WITHDRAWABLE' ? WITHDRAWABLE : dispute.holdSource;
    const amount = dispute.holdAmount;
    const description =
      target === WITHDRAWABLE ? `Dispute on package ${sub.subOrderNumber} closed: earnings released` : `Dispute on package ${sub.subOrderNumber} cancelled: back to escrow`;
    await this.post(
      tx,
      wallet,
      [
        { type: WalletTransactionType.DISPUTE_HOLD_RELEASE, bucket: DISPUTE_HOLD, amount: amount.negated(), subOrderId: sub.id, disputeId: dispute.id, description },
        { type: WalletTransactionType.DISPUTE_HOLD_RELEASE, bucket: target, amount, subOrderId: sub.id, disputeId: dispute.id, description },
      ],
      target === PENDING ? { earned: amount.negated() } : {},
    );
    return target;
  }

  /** Settlement requested: the amount moves WITHDRAWABLE → SETTLEMENT_HOLD. */
  async holdForSettlement(tx: Tx, vendorId: string, settlementRequestId: string, amount: Prisma.Decimal): Promise<void> {
    const wallet = await this.lock(tx, vendorId);
    const description = 'Held for settlement request';
    await this.post(tx, wallet, [
      { type: WalletTransactionType.SETTLEMENT_HOLD, bucket: WITHDRAWABLE, amount: amount.negated(), settlementRequestId, description },
      { type: WalletTransactionType.SETTLEMENT_HOLD, bucket: SETTLEMENT_HOLD, amount, settlementRequestId, description },
    ]);
  }

  /** Settlement rejected: the held amount returns to WITHDRAWABLE. */
  async releaseSettlementHold(tx: Tx, vendorId: string, settlementRequestId: string, amount: Prisma.Decimal): Promise<void> {
    const wallet = await this.lock(tx, vendorId);
    const description = 'Settlement request rejected; amount returned';
    await this.post(tx, wallet, [
      { type: WalletTransactionType.SETTLEMENT_HOLD_RELEASE, bucket: SETTLEMENT_HOLD, amount: amount.negated(), settlementRequestId, description },
      { type: WalletTransactionType.SETTLEMENT_HOLD_RELEASE, bucket: WITHDRAWABLE, amount, settlementRequestId, description },
    ]);
  }

  /** Settlement paid by PAYA: the held amount leaves the wallet. */
  async payoutSettlement(tx: Tx, vendorId: string, settlementRequestId: string, amount: Prisma.Decimal, payaReference: string): Promise<void> {
    const wallet = await this.lock(tx, vendorId);
    await this.post(
      tx,
      wallet,
      [
        {
          type: WalletTransactionType.SETTLEMENT_PAYOUT,
          bucket: SETTLEMENT_HOLD,
          amount: amount.negated(),
          settlementRequestId,
          description: `Paid by PAYA, reference ${payaReference}`.slice(0, 255),
        },
      ],
      { withdrawn: amount },
    );
  }

  /** Locks (creating on first use) the wallet of a vendor. Callers locking several wallets must go in vendor-id order. */
  async lock(tx: Tx, vendorId: string): Promise<LockedWallet> {
    await tx.$executeRaw(
      Prisma.sql`INSERT INTO vendor_wallets (id, vendor_id, updated_at) VALUES (gen_random_uuid(), ${vendorId}::uuid, now()) ON CONFLICT (vendor_id) DO NOTHING`,
    );
    const rows = await tx.$queryRaw<WalletRow[]>(
      Prisma.sql`SELECT id, pending_balance, withdrawable_balance, settlement_hold_balance, dispute_hold_balance, total_earned_balance, total_withdrawn_amount
                 FROM vendor_wallets WHERE vendor_id = ${vendorId}::uuid FOR UPDATE`,
    );
    const row = rows[0];
    if (!row) {
      throw new Error(`Wallet of vendor ${vendorId} could not be created`);
    }
    return {
      id: row.id,
      balances: {
        [PENDING]: new Prisma.Decimal(row.pending_balance),
        [WITHDRAWABLE]: new Prisma.Decimal(row.withdrawable_balance),
        [SETTLEMENT_HOLD]: new Prisma.Decimal(row.settlement_hold_balance),
        [DISPUTE_HOLD]: new Prisma.Decimal(row.dispute_hold_balance),
      },
      totalEarned: new Prisma.Decimal(row.total_earned_balance),
      totalWithdrawn: new Prisma.Decimal(row.total_withdrawn_amount),
    };
  }

  private async escrowState(tx: Tx, subOrderId: string): Promise<EscrowState> {
    const rows = await tx.walletTransaction.findMany({
      where: {
        subOrderId,
        type: {
          in: [
            WalletTransactionType.CREDIT_SALE_ESCROW_HOLD,
            WalletTransactionType.ESCROW_RELEASE_TO_WITHDRAWABLE,
            WalletTransactionType.REFUND_DEDUCTION,
            WalletTransactionType.DISPUTE_HOLD_LOCK,
            WalletTransactionType.DISPUTE_HOLD_RELEASE,
          ],
        },
      },
      select: { type: true, bucket: true, amount: true },
    });
    return escrowStateOf(rows);
  }

  private async post(
    tx: Tx,
    wallet: LockedWallet,
    entries: readonly LedgerEntry[],
    totals: { earned?: Prisma.Decimal; withdrawn?: Prisma.Decimal } = {},
  ): Promise<void> {
    let plan;
    try {
      plan = planEntries(wallet.balances, entries);
    } catch (error) {
      if (error instanceof InsufficientBalanceError) {
        throw conflictWith('INSUFFICIENT_WALLET_BALANCE', `The ${error.bucket.toLowerCase()} balance is not enough for this operation`, {
          bucket: error.bucket,
          available: error.available.toFixed(2),
          required: error.required.toFixed(2),
        });
      }
      throw error;
    }
    await tx.walletTransaction.createMany({
      data: plan.entries.map((entry) => ({
        walletId: wallet.id,
        type: entry.type,
        bucket: entry.bucket,
        amount: entry.amount,
        balanceAfter: entry.balanceAfter,
        subOrderId: entry.subOrderId ?? null,
        settlementRequestId: entry.settlementRequestId ?? null,
        disputeId: entry.disputeId ?? null,
        description: entry.description,
      })),
    });
    const totalEarned = wallet.totalEarned.plus(totals.earned ?? 0);
    const totalWithdrawn = wallet.totalWithdrawn.plus(totals.withdrawn ?? 0);
    await tx.vendorWallet.update({
      where: { id: wallet.id },
      data: {
        pendingBalance: plan.balances[PENDING],
        withdrawableBalance: plan.balances[WITHDRAWABLE],
        settlementHoldBalance: plan.balances[SETTLEMENT_HOLD],
        disputeHoldBalance: plan.balances[DISPUTE_HOLD],
        totalEarnedBalance: totalEarned,
        totalWithdrawnAmount: totalWithdrawn,
      },
    });
    // Keep the in-memory copy current for a second call within the same transaction.
    wallet.balances = plan.balances;
    wallet.totalEarned = totalEarned;
    wallet.totalWithdrawn = totalWithdrawn;
  }
}

function frozenError(sub: EscrowSubOrder): Error {
  return conflictWith('ESCROW_FROZEN_BY_DISPUTE', `The earnings of package ${sub.subOrderNumber} are frozen by an open dispute`, { subOrderId: sub.id });
}
