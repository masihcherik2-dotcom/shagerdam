import { describe, expect, it } from 'vitest';

import { EMPTY_ADMIN_VENDOR_FORM, validateAdminVendor } from './admin-vendor-form';

const VALID = {
  ...EMPTY_ADMIN_VENDOR_FORM,
  storeName: 'فروشگاه نمونه',
  storeSlug: 'Sample-Store',
  ownerMobile: '۰۹۱۲ ۱۲۳ ۴۵۶۷',
  ownerFullName: 'علی رضایی',
  bankIban: 'ir82 0540 1026 8002 0817 9090 02',
  commission: '۷.۵',
  instagramHandle: '@sample.store',
};

describe('validateAdminVendor', () => {
  it('normalises digits, case and spacing into the API payload', () => {
    const { errors, payload } = validateAdminVendor(VALID);
    expect(errors).toEqual({});
    expect(payload).toEqual({
      storeName: 'فروشگاه نمونه',
      storeSlug: 'sample-store',
      ownerMobile: '09121234567',
      ownerFullName: 'علی رضایی',
      bankIban: 'IR820540102680020817909002',
      commissionRateOverride: 7.5,
      instagramHandle: 'sample.store',
    });
  });

  it('sends null commission when left empty (category rates apply)', () => {
    expect(validateAdminVendor({ ...VALID, commission: '' }).payload?.commissionRateOverride).toBeNull();
  });

  it('reports every invalid field', () => {
    const { errors, payload } = validateAdminVendor({ ...VALID, storeSlug: 'bad slug', ownerMobile: '0212345678', bankIban: 'IR000', commission: '150' });
    expect(payload).toBeNull();
    expect(Object.keys(errors).sort()).toEqual(['bankIban', 'commission', 'ownerMobile', 'storeSlug']);
  });
});
