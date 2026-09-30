import { Prisma } from '@prisma/client';

/** Platform-wide shipping settings in effect for one calculation. */
export interface ShippingPolicy {
  /** Fee charged per store package when shipping is not free. */
  defaultFeePerVendor: Prisma.Decimal;
  /** Package subtotal at which shipping becomes free; `0` = free shipping disabled. */
  freeThresholdPerVendor: Prisma.Decimal;
  /** Where each value came from, reported so operators can see what is active. */
  source: { defaultFeePerVendor: ShippingSettingSource; freeThresholdPerVendor: ShippingSettingSource };
}

export type ShippingSettingSource = 'system_config' | 'env';

/** A store's own settings; `null` means "use the platform policy". */
export interface VendorShippingSettings {
  shippingFeeOverride: Prisma.Decimal | null;
  freeShippingThreshold: Prisma.Decimal | null;
}

export interface ShippingQuote {
  fee: Prisma.Decimal;
  isFree: boolean;
  /** Threshold that applied to this package (`0` = none). */
  freeThreshold: Prisma.Decimal;
  /** Amount still missing to reach free shipping, `null` when not applicable. */
  remainingForFreeShipping: Prisma.Decimal | null;
}

const ZERO = new Prisma.Decimal(0);

/**
 * Shipping fee for one store package (the TM-approved rule):
 *
 * ```
 * freeThreshold = vendor.freeShippingThreshold ?? platform.freeThresholdPerVendor
 * fee = (freeThreshold > 0 && subtotal >= freeThreshold)
 *         ? 0
 *         : vendor.shippingFeeOverride ?? platform.defaultFeePerVendor
 * ```
 *
 * Pure: no I/O, no rounding surprises (all arithmetic is decimal).
 */
export function quoteShipping(
  packageSubtotal: Prisma.Decimal,
  vendor: VendorShippingSettings,
  policy: Pick<ShippingPolicy, 'defaultFeePerVendor' | 'freeThresholdPerVendor'>,
): ShippingQuote {
  const freeThreshold = vendor.freeShippingThreshold ?? policy.freeThresholdPerVendor;
  const thresholdActive = freeThreshold.gt(ZERO);

  if (thresholdActive && packageSubtotal.gte(freeThreshold)) {
    return { fee: ZERO, isFree: true, freeThreshold, remainingForFreeShipping: ZERO };
  }

  const fee = vendor.shippingFeeOverride ?? policy.defaultFeePerVendor;
  return {
    fee,
    isFree: fee.eq(ZERO),
    freeThreshold,
    remainingForFreeShipping: thresholdActive ? freeThreshold.sub(packageSubtotal) : null,
  };
}
