import { DisputeStatus, Prisma, SubOrderStatus } from '@prisma/client';
import { customerCanCancel, maskMobile, openRejection, refundDue, shouldRestock, staffCanArbitrate, vendorCanRespond } from './dispute-policy';

describe('dispute-policy', () => {
  describe('openRejection', () => {
    it('allows PROCESSING, SHIPPED and DELIVERED packages of paid orders', () => {
      for (const status of [SubOrderStatus.PROCESSING, SubOrderStatus.SHIPPED, SubOrderStatus.DELIVERED]) {
        expect(openRejection(true, status, [])).toBeNull();
      }
    });

    it('refuses unpaid orders and every other package status', () => {
      expect(openRejection(false, SubOrderStatus.SHIPPED, [])?.code).toBe('ORDER_NOT_PAID');
      for (const status of [SubOrderStatus.PENDING_APPROVAL, SubOrderStatus.CANCELLED, SubOrderStatus.REFUNDED]) {
        expect(openRejection(true, status, [])?.code).toBe('SUB_ORDER_NOT_DISPUTABLE');
      }
    });

    it('allows one active dispute per package, never re-opens a decided one, but allows a new one after a cancellation', () => {
      for (const status of [DisputeStatus.OPEN, DisputeStatus.VENDOR_RESPONDED, DisputeStatus.UNDER_ARBITRATION]) {
        expect(openRejection(true, SubOrderStatus.DELIVERED, [{ id: 'a', status }])).toEqual(expect.objectContaining({ code: 'DISPUTE_ALREADY_ACTIVE', disputeId: 'a' }));
      }
      for (const status of [DisputeStatus.RESOLVED_BUYER_FAVOR, DisputeStatus.RESOLVED_VENDOR_FAVOR]) {
        expect(openRejection(true, SubOrderStatus.DELIVERED, [{ id: 'b', status }])).toEqual(expect.objectContaining({ code: 'DISPUTE_ALREADY_DECIDED', disputeId: 'b' }));
      }
      expect(openRejection(true, SubOrderStatus.DELIVERED, [{ id: 'c', status: DisputeStatus.CANCELLED }])).toBeNull();
    });
  });

  it('lets the vendor answer only OPEN disputes; staff and customer act on any running dispute', () => {
    expect(vendorCanRespond(DisputeStatus.OPEN)).toBe(true);
    expect(vendorCanRespond(DisputeStatus.UNDER_ARBITRATION)).toBe(false);
    for (const status of [DisputeStatus.OPEN, DisputeStatus.VENDOR_RESPONDED, DisputeStatus.UNDER_ARBITRATION]) {
      expect(staffCanArbitrate(status)).toBe(true);
      expect(customerCanCancel(status)).toBe(true);
    }
    for (const status of [DisputeStatus.RESOLVED_BUYER_FAVOR, DisputeStatus.RESOLVED_VENDOR_FAVOR, DisputeStatus.CANCELLED]) {
      expect(staffCanArbitrate(status)).toBe(false);
      expect(customerCanCancel(status)).toBe(false);
      expect(vendorCanRespond(status)).toBe(false);
    }
  });

  it('restocks goods that never shipped, and shipped goods only when they came back', () => {
    expect(shouldRestock(SubOrderStatus.PROCESSING, undefined)).toBe(true);
    expect(shouldRestock(SubOrderStatus.SHIPPED, undefined)).toBe(false);
    expect(shouldRestock(SubOrderStatus.SHIPPED, false)).toBe(false);
    expect(shouldRestock(SubOrderStatus.DELIVERED, true)).toBe(true);
  });

  it('owes the customer the items and the shipping of the package', () => {
    expect(refundDue({ itemsSubtotal: new Prisma.Decimal('6000000.00'), shippingFee: new Prisma.Decimal('450000.00') }).toFixed(2)).toBe('6450000.00');
  });

  it('masks mobiles for the other party', () => {
    expect(maskMobile('+989121234567')).toBe('+98912***4567');
    expect(maskMobile('123')).toBe('***');
  });
});
