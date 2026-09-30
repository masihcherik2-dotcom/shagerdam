import { CreditTransactionType, Prisma } from '@prisma/client';

/** The four amounts of a credit line. Invariant: totalLimit = used + reserved + available. */
export interface CreditBalances {
  totalLimit: Prisma.Decimal;
  usedAmount: Prisma.Decimal;
  reservedAmount: Prisma.Decimal;
  availableAmount: Prisma.Decimal;
}

export class InsufficientCreditError extends Error {
  constructor(
    readonly bucket: 'available' | 'reserved' | 'used',
    readonly available: Prisma.Decimal,
    readonly requested: Prisma.Decimal,
  ) {
    super(`Insufficient ${bucket} credit: ${available.toFixed(2)} < ${requested.toFixed(2)}`);
    this.name = 'InsufficientCreditError';
  }
}

const ZERO = new Prisma.Decimal(0);

export function zeroBalances(): CreditBalances {
  return { totalLimit: ZERO, usedAmount: ZERO, reservedAmount: ZERO, availableAmount: ZERO };
}

/**
 * Applies one ledger movement (amount always positive; the type is the
 * direction) and returns the new balances. Throws `InsufficientCreditError`
 * instead of letting any amount go negative. Pure: the ledger service and the
 * reconciliation (`replayCreditLedger`) share it, so both read the ledger the
 * same way.
 *
 *   CREDIT_ALLOCATION              total +a, available +a
 *   PURCHASE_RESERVE_HOLD          available −a, reserved +a
 *   PURCHASE_COMMIT                reserved −a, used +a
 *   RESERVATION_RELEASE            reserved −a, available +a
 *   INSTALLMENT_REPAYMENT_RESTORE  used −a, available +a
 *   REFUND_RESTORE                 used −a, available +a
 */
export function applyCreditMovement(balances: CreditBalances, type: CreditTransactionType, amount: Prisma.Decimal): CreditBalances {
  if (!amount.greaterThan(0)) {
    throw new Error(`Credit movement amount must be positive, got ${amount.toFixed(2)}`);
  }
  const take = (bucket: 'available' | 'reserved' | 'used', from: Prisma.Decimal): Prisma.Decimal => {
    if (from.lessThan(amount)) throw new InsufficientCreditError(bucket, from, amount);
    return from.minus(amount);
  };
  const b = balances;
  switch (type) {
    case CreditTransactionType.CREDIT_ALLOCATION:
      return { ...b, totalLimit: b.totalLimit.plus(amount), availableAmount: b.availableAmount.plus(amount) };
    case CreditTransactionType.PURCHASE_RESERVE_HOLD:
      return { ...b, availableAmount: take('available', b.availableAmount), reservedAmount: b.reservedAmount.plus(amount) };
    case CreditTransactionType.PURCHASE_COMMIT:
      return { ...b, reservedAmount: take('reserved', b.reservedAmount), usedAmount: b.usedAmount.plus(amount) };
    case CreditTransactionType.RESERVATION_RELEASE:
      return { ...b, reservedAmount: take('reserved', b.reservedAmount), availableAmount: b.availableAmount.plus(amount) };
    case CreditTransactionType.INSTALLMENT_REPAYMENT_RESTORE:
    case CreditTransactionType.REFUND_RESTORE:
      return { ...b, usedAmount: take('used', b.usedAmount), availableAmount: b.availableAmount.plus(amount) };
  }
}

/** True when totalLimit = used + reserved + available and nothing is negative. */
export function holdsInvariant(b: CreditBalances): boolean {
  const nonNegative = [b.totalLimit, b.usedAmount, b.reservedAmount, b.availableAmount].every((value) => !value.lessThan(0));
  return nonNegative && b.totalLimit.equals(b.usedAmount.plus(b.reservedAmount).plus(b.availableAmount));
}

/** Rebuilds the balances from ledger rows in chronological order (reconciliation / audit). */
export function replayCreditLedger(rows: ReadonlyArray<{ type: CreditTransactionType; amount: Prisma.Decimal }>): CreditBalances {
  return rows.reduce((balances, row) => applyCreditMovement(balances, row.type, row.amount), zeroBalances());
}

export type ReservationState = 'NONE' | 'HELD' | 'COMMITTED' | 'RELEASED';

/** State of one reservation from the types of the ledger rows carrying its reference. */
export function reservationStateOf(types: ReadonlyArray<CreditTransactionType>): ReservationState {
  if (types.includes(CreditTransactionType.PURCHASE_COMMIT)) return 'COMMITTED';
  if (types.includes(CreditTransactionType.RESERVATION_RELEASE)) return 'RELEASED';
  if (types.includes(CreditTransactionType.PURCHASE_RESERVE_HOLD)) return 'HELD';
  return 'NONE';
}

/**
 * Split of an order between credit and card for a credit-bearing method
 * (TM brief §3). Returns `{ rejected }` when the method does not apply:
 * - BANK_CREDIT: 100 % credit, only if available ≥ payable;
 * - HYBRID: creditAmount = the whole-rial part of available, cash = the rest;
 *   only when 0 < creditAmount < payable (otherwise BANK_CREDIT or card applies).
 */
export function splitPayment(
  method: 'BANK_CREDIT' | 'HYBRID',
  payable: Prisma.Decimal,
  available: Prisma.Decimal,
): { creditAmount: Prisma.Decimal; cashAmount: Prisma.Decimal } | { rejected: 'INSUFFICIENT_CREDIT' | 'HYBRID_NOT_REQUIRED' | 'AMOUNT_NOT_WHOLE_RIALS' } {
  if (!payable.isInteger() || !payable.greaterThan(0)) {
    return { rejected: 'AMOUNT_NOT_WHOLE_RIALS' };
  }
  if (method === 'BANK_CREDIT') {
    return available.greaterThanOrEqualTo(payable) ? { creditAmount: payable, cashAmount: ZERO } : { rejected: 'INSUFFICIENT_CREDIT' };
  }
  if (available.greaterThanOrEqualTo(payable)) {
    return { rejected: 'HYBRID_NOT_REQUIRED' };
  }
  const creditAmount = available.floor();
  if (!creditAmount.greaterThan(0)) {
    return { rejected: 'INSUFFICIENT_CREDIT' };
  }
  return { creditAmount, cashAmount: payable.minus(creditAmount) };
}
