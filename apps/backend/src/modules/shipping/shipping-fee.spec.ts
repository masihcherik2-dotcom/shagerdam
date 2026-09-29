import { Prisma } from '@prisma/client';
import { quoteShipping, type VendorShippingSettings } from './shipping-fee';

const d = (value: string | number): Prisma.Decimal => new Prisma.Decimal(value);
const policy = { defaultFeePerVendor: d(500_000), freeThresholdPerVendor: d(10_000_000) };
const noOverrides: VendorShippingSettings = { shippingFeeOverride: null, freeShippingThreshold: null };

describe('quoteShipping (TM-approved per-store rule)', () => {
  it('charges the platform default below the platform threshold', () => {
    const quote = quoteShipping(d(9_999_999), noOverrides, policy);
    expect(quote.fee.toFixed(2)).toBe('500000.00');
    expect(quote.isFree).toBe(false);
    expect(quote.remainingForFreeShipping?.toFixed(2)).toBe('1.00');
  });

  it('is free exactly at and above the threshold', () => {
    expect(quoteShipping(d(10_000_000), noOverrides, policy).fee.toFixed(2)).toBe('0.00');
    expect(quoteShipping(d(25_000_000), noOverrides, policy).isFree).toBe(true);
  });

  it('never makes shipping free when the threshold is 0 (disabled)', () => {
    const quote = quoteShipping(d(999_999_999), noOverrides, { ...policy, freeThresholdPerVendor: d(0) });
    expect(quote.fee.toFixed(2)).toBe('500000.00');
    expect(quote.remainingForFreeShipping).toBeNull();
  });

  it('prefers the store fee override over the platform default', () => {
    const quote = quoteShipping(d(1_000), { shippingFeeOverride: d(350_000), freeShippingThreshold: null }, policy);
    expect(quote.fee.toFixed(2)).toBe('350000.00');
  });

  it('prefers the store threshold over the platform threshold, in both directions', () => {
    const lower = { shippingFeeOverride: null, freeShippingThreshold: d(2_000_000) };
    expect(quoteShipping(d(2_000_000), lower, policy).isFree).toBe(true);

    const disabled = { shippingFeeOverride: null, freeShippingThreshold: d(0) };
    expect(quoteShipping(d(50_000_000), disabled, policy).fee.toFixed(2)).toBe('500000.00');
  });

  it('supports stores that always ship for free (override 0)', () => {
    const quote = quoteShipping(d(1), { shippingFeeOverride: d(0), freeShippingThreshold: null }, policy);
    expect(quote.fee.toFixed(2)).toBe('0.00');
    expect(quote.isFree).toBe(true);
  });
});
