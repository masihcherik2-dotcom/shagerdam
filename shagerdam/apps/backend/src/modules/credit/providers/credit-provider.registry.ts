import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import type { EnvironmentVariables } from '../../../config/env.validation';
import { NodeEnvironment } from '../../../config/env.validation';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { RedisService } from '../../../infra/redis/redis.service';
import { CreditProviderError, type CreditProviderAdapter } from './credit-provider.interface';
import { parseSandboxRules, SANDBOX_BANK_CODE, SandboxBankProvider } from './sandbox-bank.provider';

/** system_configs keys of the credit feature (seeded in Phase 2). */
export const CREDIT_CONFIG_KEYS = {
  enabled: 'credit.enabled',
  activeProvider: 'credits.activeProvider',
} as const;

export interface ProviderRow {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
  config: Prisma.JsonValue | null;
}

type AdapterFactory = (row: ProviderRow) => CreditProviderAdapter;

export function serviceUnavailable(code: string, message: string): HttpException {
  return new HttpException({ statusCode: HttpStatus.SERVICE_UNAVAILABLE, error: 'Service Unavailable', code, message }, HttpStatus.SERVICE_UNAVAILABLE);
}

/**
 * Resolves credit providers dynamically from the database (TM brief §1):
 * `credit_providers` rows (code, isActive, config) + the `credits.activeProvider`
 * system config name the active provider; this registry maps a provider code to
 * its adapter implementation. Switching provider is a data change.
 *
 * Only SANDBOX_BANK has an implementation. The real banks seeded in Phase 2
 * (SAMAN_BANK, BLUBANK, DIGIPAY) have no adapter yet — their APIs have not been
 * provided — so selecting one answers 503 CREDIT_PROVIDER_NOT_IMPLEMENTED rather
 * than pretending. The sandbox is refused in production.
 */
@Injectable()
export class CreditProviderRegistry {
  private readonly logger = new Logger(CreditProviderRegistry.name);
  private readonly production: boolean;
  private readonly factories: ReadonlyMap<string, AdapterFactory>;

  constructor(
    private readonly prisma: PrismaService,
    redis: RedisService,
    config: ConfigService<EnvironmentVariables, true>,
  ) {
    this.production = config.getOrThrow<NodeEnvironment>('NODE_ENV') === NodeEnvironment.Production;
    this.factories = new Map<string, AdapterFactory>([[SANDBOX_BANK_CODE, (row): CreditProviderAdapter => new SandboxBankProvider(redis, parseSandboxRules(row.config))]]);
  }

  /** Whether the credit feature is switched on (`credit.enabled = true`). */
  async isEnabled(): Promise<boolean> {
    const row = await this.prisma.systemConfig.findUnique({ where: { key: CREDIT_CONFIG_KEYS.enabled }, select: { value: true } });
    return row?.value.trim().toLowerCase() === 'true';
  }

  async assertEnabled(): Promise<void> {
    if (!(await this.isEnabled())) {
      throw serviceUnavailable('CREDIT_DISABLED', 'Credit purchases are currently disabled');
    }
  }

  /** The provider named by `credits.activeProvider`, if it exists and is active; null otherwise. */
  async findActiveProvider(): Promise<ProviderRow | null> {
    const setting = await this.prisma.systemConfig.findUnique({ where: { key: CREDIT_CONFIG_KEYS.activeProvider }, select: { value: true } });
    const code = setting?.value.trim();
    if (!code) return null;
    return this.prisma.creditProvider.findFirst({ where: { code, isActive: true }, select: providerSelect });
  }

  async requireActiveProvider(): Promise<ProviderRow> {
    const provider = await this.findActiveProvider();
    if (!provider) {
      throw serviceUnavailable('CREDIT_PROVIDER_UNAVAILABLE', 'No active credit provider is configured');
    }
    return provider;
  }

  async providerById(providerId: string): Promise<ProviderRow> {
    return this.prisma.creditProvider.findUniqueOrThrow({ where: { id: providerId }, select: providerSelect });
  }

  /** True when an adapter implementation exists for the code (and may be used in this environment). */
  isImplemented(code: string): boolean {
    return this.factories.has(code) && !(this.production && code === SANDBOX_BANK_CODE);
  }

  /** The adapter of a provider row; 503 when there is no implementation or its config is invalid. */
  adapterFor(row: ProviderRow): CreditProviderAdapter {
    if (this.production && row.code === SANDBOX_BANK_CODE) {
      throw serviceUnavailable('CREDIT_PROVIDER_NOT_ALLOWED', 'The SANDBOX_BANK credit provider cannot be used in production');
    }
    const factory = this.factories.get(row.code);
    if (!factory) {
      throw serviceUnavailable('CREDIT_PROVIDER_NOT_IMPLEMENTED', `No integration is implemented for credit provider ${row.code}`);
    }
    try {
      const adapter = factory(row);
      if (adapter.isSandbox) {
        this.logger.debug(`Credit provider ${row.code} is a sandbox: no real credit is granted and no money moves`);
      }
      return adapter;
    } catch (error) {
      if (error instanceof CreditProviderError) {
        this.logger.error(`Credit provider ${row.code} is misconfigured: ${error.message}`);
        throw serviceUnavailable('CREDIT_PROVIDER_MISCONFIGURED', `Credit provider ${row.code} is misconfigured`);
      }
      throw error;
    }
  }

  async adapterForProviderId(providerId: string): Promise<CreditProviderAdapter> {
    return this.adapterFor(await this.providerById(providerId));
  }
}

const providerSelect = { id: true, code: true, name: true, isActive: true, config: true } satisfies Prisma.CreditProviderSelect;
