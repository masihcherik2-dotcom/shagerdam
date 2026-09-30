import { CreditTransactionType as T, Prisma } from '@prisma/client';
import { applyCreditMovement, holdsInvariant, InsufficientCreditError, replayCreditLedger, reservationStateOf, splitPayment, zeroBalances, type CreditBalances } from './credit-math';

const D = (value: string | number): Prisma.Decimal => new Prisma.Decimal(value);
const view = (b: CreditBalances): string[] => [b.totalLimit, b.usedAmount, b.reservedAmount, b.availableAmount].map((v) => v.toFixed(0));

describe('applyCreditMovement', () => {
  it('moves money between buckets and keeps total = used + reserved + available at every step', () => {
    let b = applyCreditMovement(zeroBalances(), T.CREDIT_ALLOCATION, D(10_000_000));
    expect(view(b)).toEqual(['10000000', '0', '0', '10000000']);
    b = applyCreditMovement(b, T.PURCHASE_RESERVE_HOLD, D(4_000_000));
    expect(view(b)).toEqual(['10000000', '0', '4000000', '6000000']);
    expect(holdsInvariant(b)).toBe(true);
    b = applyCreditMovement(b, T.PURCHASE_COMMIT, D(4_000_000));
    expect(view(b)).toEqual(['10000000', '4000000', '0', '6000000']);
    b = applyCreditMovement(b, T.PURCHASE_RESERVE_HOLD, D(1_000_000));
    b = applyCreditMovement(b, T.RESERVATION_RELEASE, D(1_000_000));
    expect(view(b)).toEqual(['10000000', '4000000', '0', '6000000']);
    b = applyCreditMovement(b, T.INSTALLMENT_REPAYMENT_RESTORE, D(1_333_333));
    expect(view(b)).toEqual(['10000000', '2666667', '0', '7333333']);
    b = applyCreditMovement(b, T.REFUND_RESTORE, D(2_666_667));
    expect(view(b)).toEqual(['10000000', '0', '0', '10000000']);
    expect(holdsInvariant(b)).toBe(true);
  });

  it('never lets a bucket go negative', () => {
    const b = applyCreditMovement(zeroBalances(), T.CREDIT_ALLOCATION, D(100));
    expect(() => applyCreditMovement(b, T.PURCHASE_RESERVE_HOLD, D(101))).toThrow(InsufficientCreditError);
    expect(() => applyCreditMovement(b, T.PURCHASE_COMMIT, D(1))).toThrow(InsufficientCreditError);
    expect(() => applyCreditMovement(b, T.RESERVATION_RELEASE, D(1))).toThrow(InsufficientCreditError);
    expect(() => applyCreditMovement(b, T.INSTALLMENT_REPAYMENT_RESTORE, D(1))).toThrow(InsufficientCreditError);
  });

  it('rejects zero and negative amounts', () => {
    expect(() => applyCreditMovement(zeroBalances(), T.CREDIT_ALLOCATION, D(0))).toThrow();
    expect(() => applyCreditMovement(zeroBalances(), T.CREDIT_ALLOCATION, D(-5))).toThrow();
  });
});

describe('holdsInvariant / replayCreditLedger / reservationStateOf', () => {
  it('detects a broken invariant or a negative bucket', () => {
    expect(holdsInvariant({ totalLimit: D(10), usedAmount: D(3), reservedAmount: D(3), availableAmount: D(3) })).toBe(false);
    expect(holdsInvariant({ totalLimit: D(0), usedAmount: D(-1), reservedAmount: D(0), availableAmount: D(1) })).toBe(false);
  });

  it('rebuilds balances from the ledger', () => {
    const rows = [
      { type: T.CREDIT_ALLOCATION, amount: D(500) },
      { type: T.PURCHASE_RESERVE_HOLD, amount: D(200) },
      { type: T.PURCHASE_COMMIT, amount: D(200) },
      { type: T.PURCHASE_RESERVE_HOLD, amount: D(50) },
    ];
    expect(view(replayCreditLedger(rows))).toEqual(['500', '200', '50', '250']);
  });

  it('derives the reservation state from its ledger rows', () => {
    expect(reservationStateOf([])).toBe('NONE');
    expect(reservationStateOf([T.PURCHASE_RESERVE_HOLD])).toBe('HELD');
    expect(reservationStateOf([T.PURCHASE_RESERVE_HOLD, T.PURCHASE_COMMIT])).toBe('COMMITTED');
    expect(reservationStateOf([T.PURCHASE_RESERVE_HOLD, T.RESERVATION_RELEASE])).toBe('RELEASED');
  });
});

describe('splitPayment', () => {
  it('BANK_CREDIT takes the whole amount only when available ≥ payable', () => {
    const ok = splitPayment('BANK_CREDIT', D(5_000_000), D(5_000_000));
    expect(ok).toEqual({ creditAmount: D(5_000_000), cashAmount: D(0) });
    expect(splitPayment('BANK_CREDIT', D(5_000_000), D(4_999_999))).toEqual({ rejected: 'INSUFFICIENT_CREDIT' });
  });

  it('HYBRID uses all available credit (whole rials) and the card for the rest', () => {
    const split = splitPayment('HYBRID', D(5_000_000), D('3000000.00'));
    expect('rejected' in split).toBe(false);
    if (!('rejected' in split)) {
      expect(split.creditAmount.toFixed(0)).toBe('3000000');
      expect(split.cashAmount.toFixed(0)).toBe('2000000');
    }
  });

  it('HYBRID is refused when credit covers everything or nothing', () => {
    expect(splitPayment('HYBRID', D(5_000_000), D(5_000_000))).toEqual({ rejected: 'HYBRID_NOT_REQUIRED' });
    expect(splitPayment('HYBRID', D(5_000_000), D(0))).toEqual({ rejected: 'INSUFFICIENT_CREDIT' });
    expect(splitPayment('HYBRID', D(5_000_000), D('0.50'))).toEqual({ rejected: 'INSUFFICIENT_CREDIT' });
  });

  it('refuses amounts that are not whole rials', () => {
    expect(splitPayment('BANK_CREDIT', D('100.50'), D(1000))).toEqual({ rejected: 'AMOUNT_NOT_WHOLE_RIALS' });
  });
});
