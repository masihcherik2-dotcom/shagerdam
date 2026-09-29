import { SubOrderStatus as S } from '@prisma/client';
import { canStaffForce, canVendorTransition, paidStockEffect, vendorTransitionsFrom } from './sub-order-state-machine';

describe('sub-order state machine', () => {
  it('allows exactly the vendor transitions of the brief', () => {
    expect(canVendorTransition(S.PENDING_APPROVAL, S.PROCESSING)).toBe(true);
    expect(canVendorTransition(S.PROCESSING, S.SHIPPED)).toBe(true);
    expect(canVendorTransition(S.PENDING_APPROVAL, S.CANCELLED)).toBe(true);
    expect(canVendorTransition(S.PROCESSING, S.CANCELLED)).toBe(true);

    expect(canVendorTransition(S.PENDING_APPROVAL, S.SHIPPED)).toBe(false); // must process first
    expect(canVendorTransition(S.SHIPPED, S.CANCELLED)).toBe(false);
    expect(canVendorTransition(S.SHIPPED, S.DELIVERED)).toBe(false); // staff only
    expect(canVendorTransition(S.PROCESSING, S.REFUNDED)).toBe(false);
    expect(canVendorTransition(S.PROCESSING, S.PENDING_APPROVAL)).toBe(false); // no going back
  });

  it('treats DELIVERED, CANCELLED and REFUNDED as terminal for vendors', () => {
    for (const status of [S.SHIPPED, S.DELIVERED, S.CANCELLED, S.REFUNDED]) {
      expect(vendorTransitionsFrom(status)).toEqual([]);
    }
  });

  it('lets staff force DELIVERED only after the package is handed over or in preparation', () => {
    expect(canStaffForce(S.SHIPPED, S.DELIVERED)).toBe(true);
    expect(canStaffForce(S.PROCESSING, S.DELIVERED)).toBe(true);
    expect(canStaffForce(S.PENDING_APPROVAL, S.DELIVERED)).toBe(false);
    expect(canStaffForce(S.CANCELLED, S.DELIVERED)).toBe(false);
    expect(canStaffForce(S.DELIVERED, S.DELIVERED)).toBe(false);
  });

  it('lets staff refund anything not already refunded', () => {
    for (const from of [S.PENDING_APPROVAL, S.PROCESSING, S.SHIPPED, S.DELIVERED, S.CANCELLED]) {
      expect(canStaffForce(from, S.REFUNDED)).toBe(true);
    }
    expect(canStaffForce(S.REFUNDED, S.REFUNDED)).toBe(false);
  });

  it('restocks only goods that never left the store', () => {
    expect(paidStockEffect(S.PENDING_APPROVAL, S.CANCELLED)).toBe('RESTOCK');
    expect(paidStockEffect(S.PROCESSING, S.CANCELLED)).toBe('RESTOCK');
    expect(paidStockEffect(S.PROCESSING, S.REFUNDED)).toBe('RESTOCK');
    expect(paidStockEffect(S.SHIPPED, S.REFUNDED)).toBe('NONE');
    expect(paidStockEffect(S.DELIVERED, S.REFUNDED)).toBe('NONE');
    expect(paidStockEffect(S.CANCELLED, S.REFUNDED)).toBe('NONE'); // restocked when cancelled
    expect(paidStockEffect(S.PROCESSING, S.SHIPPED)).toBe('NONE');
  });
});
