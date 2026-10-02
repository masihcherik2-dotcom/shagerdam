import { VendorStatus } from '@prisma/client';
import { PUBLISH_DRAFTS_BATCH, publishableDraftWhere } from './products.service';

describe('publishableDraftWhere', () => {
  const RULES = { isBlockedByAdmin: false, vendor: { status: VendorStatus.APPROVED }, variants: { some: { isActive: true } } };

  it('applies the single-product publishing rules to the drafts of one store', () => {
    expect(publishableDraftWhere({ vendorId: 'store-1' })).toEqual({ AND: [{ isPublished: false, vendorId: 'store-1' }, RULES] });
  });

  it('covers every store when no store is given (staff only)', () => {
    expect(publishableDraftWhere({})).toEqual({ AND: [{ isPublished: false }, RULES] });
  });

  it('works in bounded batches', () => {
    expect(PUBLISH_DRAFTS_BATCH).toBeGreaterThan(0);
    expect(PUBLISH_DRAFTS_BATCH).toBeLessThanOrEqual(1000);
  });
});
