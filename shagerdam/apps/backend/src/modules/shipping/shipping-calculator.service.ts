import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import type { EnvironmentVariables } from '../../config/env.validation';
import { PrismaService } from '../../infra/prisma/prisma.service';
import {
  quoteShipping,
  type ShippingPolicy,
  type ShippingQuote,
  type ShippingSettingSource,
  type VendorShippingSettings,
} from './shipping-fee';

/** `system_configs` keys that override the environment fallbacks. */
export const SHIPPING_CONFIG_KEYS = {
  defaultFeePerVendor: 'shipping.default_fee_per_vendor',
  freeThresholdPerVendor: 'shipping.free_threshold_per_vendor',
} as const;

const MONEY_PATTERN = /^\d{1,13}(\.\d{1,2})?$/;

/**
 * Resolves the shipping policy and prices store packages.
 *
 * Precedence, per value: store override → `system_configs` → environment. The
 * policy is read from the database on every call (two indexed key lookups), so
 * an operator's change applies to the next checkout without a restart and no
 * cache can serve a stale price.
 *
 * A `system_configs` value that is not a valid non-negative amount fails the
 * calculation (503) instead of silently falling back: charging a fee nobody
 * configured is worse than refusing to quote.
 */
@Injectable()
export class ShippingCalculatorService {
  private readonly logger = new Logger(ShippingCalculatorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<EnvironmentVariables, true>,
  ) {}

  async loadPolicy(executor: Pick<Prisma.TransactionClient, 'systemConfig'> = this.prisma): Promise<ShippingPolicy> {
    const rows = await executor.systemConfig.findMany({
      where: { key: { in: Object.values(SHIPPING_CONFIG_KEYS) } },
      select: { key: true, value: true },
    });
    const stored = new Map(rows.map((row) => [row.key, row.value]));

    const defaultFee = this.resolve(
      stored.get(SHIPPING_CONFIG_KEYS.defaultFeePerVendor),
      SHIPPING_CONFIG_KEYS.defaultFeePerVendor,
      this.config.get('SHIPPING_DEFAULT_FEE_PER_VENDOR', { infer: true }),
    );
    const freeThreshold = this.resolve(
      stored.get(SHIPPING_CONFIG_KEYS.freeThresholdPerVendor),
      SHIPPING_CONFIG_KEYS.freeThresholdPerVendor,
      this.config.get('SHIPPING_FREE_THRESHOLD_PER_VENDOR', { infer: true }),
    );

    return {
      defaultFeePerVendor: defaultFee.value,
      freeThresholdPerVendor: freeThreshold.value,
      source: { defaultFeePerVendor: defaultFee.source, freeThresholdPerVendor: freeThreshold.source },
    };
  }

  quote(packageSubtotal: Prisma.Decimal, vendor: VendorShippingSettings, policy: ShippingPolicy): ShippingQuote {
    return quoteShipping(packageSubtotal, vendor, policy);
  }

  private resolve(
    stored: string | undefined,
    key: string,
    fallback: number,
  ): { value: Prisma.Decimal; source: ShippingSettingSource } {
    if (stored === undefined) {
      return { value: new Prisma.Decimal(fallback), source: 'env' };
    }
    const trimmed = stored.trim();
    if (!MONEY_PATTERN.test(trimmed)) {
      this.logger.error(`system_configs "${key}" holds an invalid amount (${JSON.stringify(stored)})`);
      throw new ServiceUnavailableException(
        'Shipping is temporarily unavailable: the shipping configuration is invalid',
      );
    }
    return { value: new Prisma.Decimal(trimmed), source: 'system_config' };
  }
}
