import { Prisma } from '@prisma/client';
import { effectiveCommissionRate, groupInOrder, lineCommission, parentTotals, subOrderTotals } from './order-math';

const d = (value: string | number): Prisma.Decimal => new Prisma.Decimal(value);

describe('order math', () => {
  it('uses the store override before the category rate', () => {
    expect(effectiveCommissionRate(d('7.50'), d('12.00')).toFixed(2)).toBe('7.50');
    expect(effectiveCommissionRate(null, d('12.00')).toFixed(2)).toBe('12.00');
  });

  it('rounds each line commission half-up to 2 places', () => {
    expect(lineCommission(d('333.33'), d('12.5')).toFixed(2)).toBe('41.67'); // 41.66625
    expect(lineCommission(d('100.10'), d('5')).toFixed(2)).toBe('5.01'); // 5.005
  });

  it('keeps commission + earnings = subtotal exactly, with mixed category rates', () => {
    const totals = subOrderTotals(
      [
        { unitPrice: d('42500000'), quantity: 1, commissionRate: d('6.25') },
        { unitPrice: d('333.33'), quantity: 3, commissionRate: d('12.5') },
        { unitPrice: d('890000'), quantity: 2, commissionRate: d('9.75') },
      ],
      d('500000'),
    );
    expect(totals.itemsSubtotal.toFixed(2)).toBe('44280999.99');
    expect(totals.platformCommissionAmount.add(totals.vendorEarningsAmount).eq(totals.itemsSubtotal)).toBe(true);
    expect(totals.platformCommissionAmount.toFixed(2)).toBe('2829925.00'); // 2656250 + 125.00 + 173550
  });

  it('adds sub-orders up to the payable amount', () => {
    const a = subOrderTotals([{ unitPrice: d('1000000'), quantity: 2, commissionRate: d('10') }], d('500000'));
    const b = subOrderTotals([{ unitPrice: d('12000000'), quantity: 1, commissionRate: d('8') }], d('0'));
    const parent = parentTotals([a, b]);
    expect(parent.totalItemsAmount.toFixed(2)).toBe('14000000.00');
    expect(parent.totalShippingFee.toFixed(2)).toBe('500000.00');
    expect(parent.finalPayableAmount.toFixed(2)).toBe('14500000.00');
    expect(parentTotals([a, b], d('100000')).finalPayableAmount.toFixed(2)).toBe('14400000.00');
  });

  it('groups in first-seen order', () => {
    const groups = groupInOrder(['b1', 'a1', 'b2', 'c1', 'a2'], (value) => value[0]!);
    expect(groups.map((group) => group.key)).toEqual(['b', 'a', 'c']);
    expect(groups[0]!.items).toEqual(['b1', 'b2']);
  });
});
