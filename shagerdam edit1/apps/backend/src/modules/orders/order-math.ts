import { Prisma } from '@prisma/client';

const ZERO = new Prisma.Decimal(0);
const HUNDRED = new Prisma.Decimal(100);

/**
 * Money arithmetic of the multi-vendor split. Pure and decimal-only: no floats
 * anywhere, and every rounding step is explicit (2 places, half-up) so the
 * identities the database also enforces hold by construction:
 *
 *   commission + earnings = itemsSubtotal          (per sub-order)
 *   Σ (itemsSubtotal + shippingFee) − discount = finalPayableAmount
 */

/** Vendor-specific rate wins; otherwise the category's default rate applies. */
export function effectiveCommissionRate(
  vendorOverride: Prisma.Decimal | null,
  categoryRate: Prisma.Decimal,
): Prisma.Decimal {
  return vendorOverride ?? categoryRate;
}

export function lineTotal(unitPrice: Prisma.Decimal, quantity: number, discount: Prisma.Decimal = ZERO): Prisma.Decimal {
  return unitPrice.mul(quantity).sub(discount);
}

/** Platform commission on one line, rounded to 2 places half-up. */
export function lineCommission(total: Prisma.Decimal, ratePercent: Prisma.Decimal): Prisma.Decimal {
  return total.mul(ratePercent).div(HUNDRED).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

export interface SplitLine {
  unitPrice: Prisma.Decimal;
  quantity: number;
  commissionRate: Prisma.Decimal;
}

export interface SubOrderTotals {
  itemsSubtotal: Prisma.Decimal;
  shippingFee: Prisma.Decimal;
  platformCommissionAmount: Prisma.Decimal;
  vendorEarningsAmount: Prisma.Decimal;
}

/**
 * Totals of one store package. Commission is summed from per-line commissions
 * (each line keeps its own category rate), and earnings are derived by
 * subtraction, so the two always add up to the subtotal exactly.
 */
export function subOrderTotals(lines: readonly SplitLine[], shippingFee: Prisma.Decimal): SubOrderTotals {
  let itemsSubtotal = ZERO;
  let commission = ZERO;
  for (const line of lines) {
    const total = lineTotal(line.unitPrice, line.quantity);
    itemsSubtotal = itemsSubtotal.add(total);
    commission = commission.add(lineCommission(total, line.commissionRate));
  }
  return {
    itemsSubtotal,
    shippingFee,
    platformCommissionAmount: commission,
    vendorEarningsAmount: itemsSubtotal.sub(commission),
  };
}

export interface ParentTotals {
  totalItemsAmount: Prisma.Decimal;
  totalShippingFee: Prisma.Decimal;
  totalDiscountAmount: Prisma.Decimal;
  finalPayableAmount: Prisma.Decimal;
}

export function parentTotals(subOrders: readonly SubOrderTotals[], discount: Prisma.Decimal = ZERO): ParentTotals {
  const totalItemsAmount = subOrders.reduce((sum, sub) => sum.add(sub.itemsSubtotal), ZERO);
  const totalShippingFee = subOrders.reduce((sum, sub) => sum.add(sub.shippingFee), ZERO);
  return {
    totalItemsAmount,
    totalShippingFee,
    totalDiscountAmount: discount,
    finalPayableAmount: totalItemsAmount.add(totalShippingFee).sub(discount),
  };
}

/** Groups items by a key, preserving first-seen order of keys and items. */
export function groupInOrder<T>(items: readonly T[], keyOf: (item: T) => string): Array<{ key: string; items: T[] }> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const bucket = groups.get(key);
    if (bucket) bucket.push(item);
    else groups.set(key, [item]);
  }
  return [...groups.entries()].map(([key, grouped]) => ({ key, items: grouped }));
}
