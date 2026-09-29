import { Prisma } from '@prisma/client';

import { maxDiscountPercent, startingCompareAtPrice } from './product-views';

interface TestVariant {
  price: Prisma.Decimal;
  compareAtPrice: Prisma.Decimal | null;
  isActive: boolean;
}

const variant = (price: number, compareAtPrice: number | null, isActive = true): TestVariant => ({
  price: new Prisma.Decimal(price),
  compareAtPrice: compareAtPrice === null ? null : new Prisma.Decimal(compareAtPrice),
  isActive,
});

describe('startingCompareAtPrice', () => {
  it('returns the compare-at price of the cheapest active variant', () => {
    expect(startingCompareAtPrice([variant(500_000, 600_000), variant(400_000, 480_000), variant(450_000, null)])).toBe('480000.00');
  });

  it('is null when the cheapest variant is not discounted, even if a dearer one is', () => {
    const variants = [variant(400_000, null), variant(500_000, 900_000)];
    expect(startingCompareAtPrice(variants)).toBeNull();
    // …while the badge still reports the best discount of the product.
    expect(maxDiscountPercent(variants)).toBe(44);
  });

  it('ignores inactive variants', () => {
    expect(startingCompareAtPrice([variant(100_000, 200_000, false), variant(300_000, 330_000)])).toBe('330000.00');
  });

  it('is null for a compare-at price that is not above the price, and for no active variant', () => {
    expect(startingCompareAtPrice([variant(300_000, 300_000)])).toBeNull();
    expect(startingCompareAtPrice([variant(300_000, 400_000, false)])).toBeNull();
    expect(startingCompareAtPrice([])).toBeNull();
  });
});
