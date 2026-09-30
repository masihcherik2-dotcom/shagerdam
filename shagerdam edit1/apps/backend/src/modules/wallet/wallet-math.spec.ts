import { Prisma, WalletBalanceBucket, WalletTransactionType } from '@prisma/client';
import { emptyBalances, escrowStateOf, InsufficientBalanceError, planEntries, sumByBucket, type EscrowRow } from './wallet-math';

const d = (value: string): Prisma.Decimal => new Prisma.Decimal(value);
const { PENDING, WITHDRAWABLE, SETTLEMENT_HOLD, DISPUTE_HOLD } = WalletBalanceBucket;

describe('wallet-math', () => {
  it('computes balanceAfter per bucket and the resulting balances', () => {
    const plan = planEntries(emptyBalances(), [
      { type: WalletTransactionType.CREDIT_SALE_ESCROW_HOLD, bucket: PENDING, amount: d('2590000.00'), description: 'hold' },
      { type: WalletTransactionType.ESCROW_RELEASE_TO_WITHDRAWABLE, bucket: PENDING, amount: d('-2590000.00'), description: 'out' },
      { type: WalletTransactionType.ESCROW_RELEASE_TO_WITHDRAWABLE, bucket: WITHDRAWABLE, amount: d('2590000.00'), description: 'in' },
    ]);
    expect(plan.entries.map((entry) => entry.balanceAfter.toFixed(2))).toEqual(['2590000.00', '0.00', '2590000.00']);
    expect(plan.balances[PENDING].toFixed(2)).toBe('0.00');
    expect(plan.balances[WITHDRAWABLE].toFixed(2)).toBe('2590000.00');
    expect(plan.balances[SETTLEMENT_HOLD].toFixed(2)).toBe('0.00');
  });

  it('refuses to take a bucket below zero, checked entry by entry', () => {
    const start = { ...emptyBalances(), [WITHDRAWABLE]: d('100.00') };
    expect(() =>
      planEntries(start, [
        { type: WalletTransactionType.SETTLEMENT_HOLD, bucket: WITHDRAWABLE, amount: d('-100.01'), description: 'x' },
        { type: WalletTransactionType.SETTLEMENT_HOLD, bucket: SETTLEMENT_HOLD, amount: d('100.01'), description: 'y' },
      ]),
    ).toThrow(InsufficientBalanceError);
    // A debit listed before the credit that would fund it is still refused.
    expect(() =>
      planEntries(emptyBalances(), [
        { type: WalletTransactionType.SETTLEMENT_PAYOUT, bucket: SETTLEMENT_HOLD, amount: d('-1.00'), description: 'x' },
        { type: WalletTransactionType.SETTLEMENT_HOLD, bucket: SETTLEMENT_HOLD, amount: d('1.00'), description: 'y' },
      ]),
    ).toThrow(InsufficientBalanceError);
  });

  it('rejects zero amounts and sub-rial precision', () => {
    expect(() => planEntries(emptyBalances(), [{ type: WalletTransactionType.CREDIT_SALE_ESCROW_HOLD, bucket: PENDING, amount: d('0'), description: 'x' }])).toThrow(/zero/);
    expect(() => planEntries(emptyBalances(), [{ type: WalletTransactionType.CREDIT_SALE_ESCROW_HOLD, bucket: PENDING, amount: d('1.001'), description: 'x' }])).toThrow(/decimals/);
  });

  it('reconciles: the sum of signed amounts per bucket equals the balances', () => {
    const plan = planEntries(emptyBalances(), [
      { type: WalletTransactionType.CREDIT_SALE_ESCROW_HOLD, bucket: PENDING, amount: d('500.00'), description: 'a' },
      { type: WalletTransactionType.ESCROW_RELEASE_TO_WITHDRAWABLE, bucket: PENDING, amount: d('-500.00'), description: 'b' },
      { type: WalletTransactionType.ESCROW_RELEASE_TO_WITHDRAWABLE, bucket: WITHDRAWABLE, amount: d('500.00'), description: 'c' },
      { type: WalletTransactionType.SETTLEMENT_HOLD, bucket: WITHDRAWABLE, amount: d('-300.00'), description: 'd' },
      { type: WalletTransactionType.SETTLEMENT_HOLD, bucket: SETTLEMENT_HOLD, amount: d('300.00'), description: 'e' },
      { type: WalletTransactionType.SETTLEMENT_PAYOUT, bucket: SETTLEMENT_HOLD, amount: d('-300.00'), description: 'f' },
    ]);
    const sums = sumByBucket(plan.entries);
    for (const bucket of [PENDING, WITHDRAWABLE, SETTLEMENT_HOLD]) {
      expect(sums[bucket].equals(plan.balances[bucket])).toBe(true);
    }
    expect(plan.balances[WITHDRAWABLE].toFixed(2)).toBe('200.00');
  });

  describe('escrowStateOf (net amount per bucket, order-independent)', () => {
    const E = '5550000.00';
    const row = (type: WalletTransactionType, bucket: WalletBalanceBucket, amount: string): EscrowRow => ({ type, bucket, amount: d(amount) });
    const { CREDIT_SALE_ESCROW_HOLD: HOLD, ESCROW_RELEASE_TO_WITHDRAWABLE: RELEASE, REFUND_DEDUCTION: REFUND, DISPUTE_HOLD_LOCK: LOCK, DISPUTE_HOLD_RELEASE: UNLOCK } = WalletTransactionType;
    const held = [row(HOLD, PENDING, E)];
    const released = [...held, row(RELEASE, PENDING, `-${E}`), row(RELEASE, WITHDRAWABLE, E)];
    const frozenFromPending = [...held, row(LOCK, PENDING, `-${E}`), row(LOCK, DISPUTE_HOLD, E)];

    it('covers the Phase 7 life cycle', () => {
      expect(escrowStateOf([])).toBe('NONE');
      expect(escrowStateOf(held)).toBe('HELD');
      expect(escrowStateOf(released)).toBe('RELEASED');
      expect(escrowStateOf([...held, row(REFUND, PENDING, `-${E}`)])).toBe('REVERSED');
      expect(escrowStateOf([...released, row(REFUND, WITHDRAWABLE, `-${E}`)])).toBe('REVERSED');
    });

    it('a dispute freezes the escrow; cancelling it returns to HELD; a vendor-favour decision releases it', () => {
      expect(escrowStateOf(frozenFromPending)).toBe('FROZEN');
      const cancelled = [...frozenFromPending, row(UNLOCK, DISPUTE_HOLD, `-${E}`), row(UNLOCK, PENDING, E)];
      expect(escrowStateOf(cancelled)).toBe('HELD');
      // a second dispute on the same package freezes it again
      expect(escrowStateOf([...cancelled, row(LOCK, PENDING, `-${E}`), row(LOCK, DISPUTE_HOLD, E)])).toBe('FROZEN');
      expect(escrowStateOf([...frozenFromPending, row(UNLOCK, DISPUTE_HOLD, `-${E}`), row(UNLOCK, WITHDRAWABLE, E)])).toBe('RELEASED');
    });

    it('freezing a delivered package takes from WITHDRAWABLE; a refund from the hold is terminal', () => {
      const frozenDelivered = [...released, row(LOCK, WITHDRAWABLE, '-1000000.00'), row(LOCK, DISPUTE_HOLD, '1000000.00')];
      expect(escrowStateOf(frozenDelivered)).toBe('FROZEN');
      expect(escrowStateOf([...frozenDelivered, row(REFUND, DISPUTE_HOLD, '-1000000.00')])).toBe('REVERSED');
    });

    it('does not depend on row order (rows of one transaction share a timestamp)', () => {
      expect(escrowStateOf([...frozenFromPending].reverse())).toBe('FROZEN');
      expect(escrowStateOf([...released].reverse())).toBe('RELEASED');
    });
  });
});
