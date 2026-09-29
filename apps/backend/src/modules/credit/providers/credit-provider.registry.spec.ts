import { HttpException, HttpStatus } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { EnvironmentVariables } from '../../../config/env.validation';
import { NodeEnvironment } from '../../../config/env.validation';
import type { PrismaService } from '../../../infra/prisma/prisma.service';
import type { RedisService } from '../../../infra/redis/redis.service';
import { CreditProviderRegistry, type ProviderRow } from './credit-provider.registry';
import { SANDBOX_BANK_CODE } from './sandbox-bank.provider';

/**
 * Environment guard of the credit provider registry (Phase 11): the SANDBOX_BANK
 * simulation must never grant credit in production, even when an operator
 * activates it in the database; real banks without an adapter answer 503.
 */
function registryFor(nodeEnv: NodeEnvironment): CreditProviderRegistry {
  const config = { getOrThrow: (): NodeEnvironment => nodeEnv } as unknown as ConfigService<EnvironmentVariables, true>;
  return new CreditProviderRegistry({} as PrismaService, {} as RedisService, config);
}

const SANDBOX_RULES = { minApprovalScore: 600, minRequestedLimit: '10000000', maxApprovedLimit: '500000000' };

function row(code: string, config: ProviderRow['config'] = null): ProviderRow {
  return { id: '00000000-0000-4000-8000-000000000001', code, name: code, isActive: true, config };
}

function errorCodeOf(action: () => unknown): { status: number; code: unknown } {
  try {
    action();
  } catch (error) {
    if (error instanceof HttpException) {
      return { status: error.getStatus(), code: (error.getResponse() as { code?: unknown }).code };
    }
    throw error;
  }
  throw new Error('expected an HttpException');
}

describe('CreditProviderRegistry environment guard', () => {
  it('refuses the SANDBOX_BANK adapter in production with 503 CREDIT_PROVIDER_NOT_ALLOWED', () => {
    const registry = registryFor(NodeEnvironment.Production);
    expect(errorCodeOf(() => registry.adapterFor(row(SANDBOX_BANK_CODE, SANDBOX_RULES)))).toEqual({
      status: HttpStatus.SERVICE_UNAVAILABLE,
      code: 'CREDIT_PROVIDER_NOT_ALLOWED',
    });
  });

  it('reports SANDBOX_BANK as not usable in production, so no plan is offered', () => {
    expect(registryFor(NodeEnvironment.Production).isImplemented(SANDBOX_BANK_CODE)).toBe(false);
  });

  it('allows SANDBOX_BANK in development as a flagged sandbox adapter', () => {
    const registry = registryFor(NodeEnvironment.Development);
    expect(registry.isImplemented(SANDBOX_BANK_CODE)).toBe(true);
    expect(registry.adapterFor(row(SANDBOX_BANK_CODE, SANDBOX_RULES)).isSandbox).toBe(true);
  });

  it('answers 503 CREDIT_PROVIDER_MISCONFIGURED when the sandbox rules are missing', () => {
    expect(errorCodeOf(() => registryFor(NodeEnvironment.Development).adapterFor(row(SANDBOX_BANK_CODE)))).toEqual({
      status: HttpStatus.SERVICE_UNAVAILABLE,
      code: 'CREDIT_PROVIDER_MISCONFIGURED',
    });
  });

  it.each(['SAMAN_BANK', 'BLUBANK', 'DIGIPAY'])('answers 503 CREDIT_PROVIDER_NOT_IMPLEMENTED for %s (no adapter exists)', (code) => {
    const registry = registryFor(NodeEnvironment.Production);
    expect(registry.isImplemented(code)).toBe(false);
    expect(errorCodeOf(() => registry.adapterFor(row(code)))).toEqual({
      status: HttpStatus.SERVICE_UNAVAILABLE,
      code: 'CREDIT_PROVIDER_NOT_IMPLEMENTED',
    });
  });
});
