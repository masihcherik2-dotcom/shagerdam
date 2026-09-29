import { Prisma } from '@prisma/client';
import type { RedisService } from '../../../infra/redis/redis.service';
import { CreditProviderError } from './credit-provider.interface';
import { parseSandboxRules, SandboxBankProvider, sandboxCreditScore } from './sandbox-bank.provider';

const RULES = { minApprovalScore: '600', minRequestedLimit: '10000000', maxApprovedLimit: '500000000' };
/** Eligibility and applications never touch Redis (only reservations do; those are covered by the e2e suite against real Redis). */
const NO_REDIS = {} as RedisService;

describe('sandboxCreditScore', () => {
  it('is deterministic and within 300–850', () => {
    for (const code of ['0499370899', '0012345679', '1234567891', '9876543210']) {
      const score = sandboxCreditScore(code);
      expect(score).toBe(sandboxCreditScore(code));
      expect(score).toBeGreaterThanOrEqual(300);
      expect(score).toBeLessThanOrEqual(850);
    }
  });
});

describe('parseSandboxRules', () => {
  it('parses the seeded configuration', () => {
    const rules = parseSandboxRules(RULES);
    expect(rules.minApprovalScore).toBe(600);
    expect(rules.minRequestedLimit.toFixed(0)).toBe('10000000');
    expect(rules.maxApprovedLimit.toFixed(0)).toBe('500000000');
  });

  it.each([
    [null],
    [{}],
    [{ ...RULES, minApprovalScore: '200' }],
    [{ ...RULES, minApprovalScore: '900' }],
    [{ ...RULES, maxApprovedLimit: '5' }],
    [{ ...RULES, minRequestedLimit: 'abc' }],
  ])('refuses an invalid configuration %#', (config) => {
    expect(() => parseSandboxRules(config as Prisma.JsonValue)).toThrow(CreditProviderError);
  });
});

describe('SandboxBankProvider decisions', () => {
  const provider = new SandboxBankProvider(NO_REDIS, parseSandboxRules(RULES));

  it('marks itself as a sandbox provider', () => {
    expect(provider.isSandbox).toBe(true);
    expect(provider.code).toBe('SANDBOX_BANK');
  });

  it('eligibility follows the score threshold', async () => {
    const codes = ['0499370899', '0012345679', '1234567891', '9876543210', '1111111111', '2222222222'];
    for (const code of codes) {
      const result = await provider.inquireEligibility(code, '+989121234567');
      expect(result.score).toBe(sandboxCreditScore(code));
      expect(result.eligible).toBe(sandboxCreditScore(code) >= 600);
      expect(result.reason).toBe(result.eligible ? null : 'SCORE_BELOW_THRESHOLD');
      expect(result.inquiryRef).toMatch(/^SBXQ-[0-9A-F]{16}$/);
    }
  });

  it('approves the requested limit, capped at the maximum', async () => {
    const approved = await provider.submitApplication('11111111-1111-4111-8111-111111111111', new Prisma.Decimal(200_000_000), []);
    expect(approved.status).toBe('APPROVED');
    expect(approved.approvedLimit?.toFixed(0)).toBe('200000000');
    const capped = await provider.submitApplication('11111111-1111-4111-8111-111111111111', new Prisma.Decimal(900_000_000), []);
    expect(capped.approvedLimit?.toFixed(0)).toBe('500000000');
    expect(capped.reason).toBe('CAPPED_AT_MAXIMUM');
  });

  it('rejects a request below the minimum limit', async () => {
    const rejected = await provider.submitApplication('11111111-1111-4111-8111-111111111111', new Prisma.Decimal(9_999_999), []);
    expect(rejected.status).toBe('REJECTED');
    expect(rejected.approvedLimit).toBeNull();
    expect(rejected.reason).toBe('BELOW_MINIMUM_LIMIT');
  });

  it('refuses fractional reservation amounts before touching storage', async () => {
    await expect(provider.reserveCredit('acc', new Prisma.Decimal('10.5'), 'order')).rejects.toBeInstanceOf(CreditProviderError);
  });
});
