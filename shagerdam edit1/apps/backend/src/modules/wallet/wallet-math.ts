import { Prisma, WalletBalanceBucket, type WalletTransactionType } from '@prisma/client';

const ZERO = new Prisma.Decimal(0);

/** Balance of every ledger bucket of one wallet. */
export type BucketBalances = Record<WalletBalanceBucket, Prisma.Decimal>;

/** One ledger movement in one bucket; `amount` is signed (negative = debit). */
export interface LedgerEntry {
  type: WalletTransactionType;
  bucket: WalletBalanceBucket;
  amount: Prisma.Decimal;
  subOrderId?: string | null;
  settlementRequestId?: string | null;
  disputeId?: string | null;
  description: string;
}

export interface PlannedEntry extends LedgerEntry {
  balanceAfter: Prisma.Decimal;
}

export interface LedgerPlan {
  balances: BucketBalances;
  entries: PlannedEntry[];
}

/** A bucket would go below zero; carries what was needed and what was there. */
export class InsufficientBalanceError extends Error {
  constructor(
    readonly bucket: WalletBalanceBucket,
    readonly available: Prisma.Decimal,
    readonly required: Prisma.Decimal,
  ) {
    super(`Insufficient ${bucket} balance: ${available.toFixed(2)} available, ${required.toFixed(2)} required`);
    this.name = 'InsufficientBalanceError';
  }
}

export function emptyBalances(): BucketBalances {
  return {
    [WalletBalanceBucket.PENDING]: ZERO,
    [WalletBalanceBucket.WITHDRAWABLE]: ZERO,
    [WalletBalanceBucket.SETTLEMENT_HOLD]: ZERO,
    [WalletBalanceBucket.DISPUTE_HOLD]: ZERO,
  };
}

/**
 * Applies entries in order and computes each row's `balanceAfter` (the balance
 * of that row's bucket). Pure: the caller persists the plan. Refuses zero
 * amounts, more than 2 decimals, and any bucket going negative — checked per
 * entry, so a debit cannot be "funded" by a credit listed after it.
 */
export function planEntries(current: BucketBalances, entries: readonly LedgerEntry[]): LedgerPlan {
  const balances: BucketBalances = { ...current };
  const planned: PlannedEntry[] = [];
  for (const entry of entries) {
    if (entry.amount.isZero()) {
      throw new Error(`Ledger entry ${entry.type}/${entry.bucket} has a zero amount`);
    }
    if (entry.amount.decimalPlaces() > 2) {
      throw new Error(`Ledger entry ${entry.type}/${entry.bucket} has more than 2 decimals`);
    }
    const after = balances[entry.bucket].plus(entry.amount);
    if (after.lessThan(0)) {
      throw new InsufficientBalanceError(entry.bucket, balances[entry.bucket], entry.amount.negated());
    }
    balances[entry.bucket] = after;
    planned.push({ ...entry, balanceAfter: after });
  }
  return { balances, entries: planned };
}

/** Sum of signed amounts per bucket — the reconciliation side of the invariant. */
export function sumByBucket(rows: ReadonlyArray<{ bucket: WalletBalanceBucket; amount: Prisma.Decimal }>): BucketBalances {
  const totals = emptyBalances();
  for (const row of rows) {
    totals[row.bucket] = totals[row.bucket].plus(row.amount);
  }
  return totals;
}

/**
 * Escrow position of one package, derived from its own ledger rows (the ledger
 * is the source of truth):
 *
 * - `NONE`     nothing was ever escrowed (unpaid, or zero earnings);
 * - `HELD`     the earnings sit in PENDING (paid, not delivered);
 * - `FROZEN`   the earnings sit in DISPUTE_HOLD (an open dispute, Phase 9);
 * - `RELEASED` the earnings left escrow to WITHDRAWABLE (delivered, or a dispute
 *              decided for the vendor);
 * - `REVERSED` the earnings were deducted by a refund (terminal).
 *
 * Computed from the **net** amount per bucket, not from row order: rows written
 * by one transaction share a timestamp, and a package can go HELD → FROZEN →
 * HELD (dispute cancelled) → FROZEN (new dispute) any number of times.
 */
export type EscrowState = 'NONE' | 'HELD' | 'FROZEN' | 'RELEASED' | 'REVERSED';

export interface EscrowRow {
  type: WalletTransactionType;
  bucket: WalletBalanceBucket;
  amount: Prisma.Decimal;
}

export function escrowStateOf(rows: ReadonlyArray<EscrowRow>): EscrowState {
  if (rows.some((row) => row.type === 'REFUND_DEDUCTION')) return 'REVERSED';
  if (!rows.some((row) => row.type === 'CREDIT_SALE_ESCROW_HOLD')) return 'NONE';
  const net = sumByBucket(rows);
  if (net[WalletBalanceBucket.DISPUTE_HOLD].greaterThan(0)) return 'FROZEN';
  if (net[WalletBalanceBucket.PENDING].greaterThan(0)) return 'HELD';
  return 'RELEASED';
}
