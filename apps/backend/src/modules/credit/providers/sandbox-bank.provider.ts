import { Prisma } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import type { RedisService } from '../../../infra/redis/redis.service';
import {
  CreditProviderError,
  type ApplicationDecision,
  type ApplicationDocument,
  type CreditProviderAdapter,
  type CreditReservation,
  type EligibilityResult,
} from './credit-provider.interface';

export const SANDBOX_BANK_CODE = 'SANDBOX_BANK';

/** Reservations live longer than any payment window and callback grace. */
export const SANDBOX_RESERVATION_TTL_SECONDS = 30 * 24 * 60 * 60;

export const sandboxReservationKey = (ref: string): string => `credit:sandbox:reservation:${ref}`;

/** Decision rules of the simulated bank, read from `credit_providers.config` (never hard-coded). */
export interface SandboxBankRules {
  minApprovalScore: number;
  minRequestedLimit: Prisma.Decimal;
  maxApprovedLimit: Prisma.Decimal;
}

/** Parses and validates the sandbox rules; a missing or invalid rule is a configuration error (503 upstream). */
export function parseSandboxRules(config: Prisma.JsonValue | null): SandboxBankRules {
  const object = typeof config === 'object' && config !== null && !Array.isArray(config) ? config : {};
  const score = Number(object['minApprovalScore']);
  const min = decimalOrNull(object['minRequestedLimit']);
  const max = decimalOrNull(object['maxApprovedLimit']);
  if (!Number.isInteger(score) || score < 300 || score > 850 || min === null || max === null || !min.greaterThan(0) || max.lessThan(min)) {
    throw new CreditProviderError(
      'SANDBOX_BANK config must define minApprovalScore (300–850), minRequestedLimit and maxApprovedLimit (whole rials, max ≥ min)',
      'PROVIDER_MISCONFIGURED',
      false,
    );
  }
  return { minApprovalScore: score, minRequestedLimit: min, maxApprovedLimit: max };
}

/**
 * Deterministic simulated credit score (300–850) of a national code: the same
 * person always gets the same answer, so development and tests can reproduce
 * both an approval and a rejection.
 */
export function sandboxCreditScore(nationalCode: string): number {
  const digest = createHash('sha256').update(`shopino-sandbox-credit:${nationalCode}`).digest();
  return 300 + (digest.readUInt32BE(0) % 551);
}

type ReservationStatus = 'RESERVED' | 'COMMITTED' | 'RELEASED';

interface SandboxReservation {
  reservationRef: string;
  creditAccountId: string;
  parentOrderId: string;
  amount: string;
  status: ReservationStatus;
  createdAt: string;
  updatedAt: string;
}

/**
 * Atomic status transition of a reservation (the sandbox "bank core"). Returns
 * the previous status, `MISSING`, or `CONFLICT:<status>` when the requested
 * transition is not allowed (committing a released hold or vice versa).
 */
const TRANSITION_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 'MISSING' end
local r = cjson.decode(raw)
if r.status == ARGV[1] then return r.status end
if r.status ~= 'RESERVED' then return 'CONFLICT:' .. r.status end
r.status = ARGV[1]
r.updatedAt = ARGV[2]
redis.call('SET', KEYS[1], cjson.encode(r), 'KEEPTTL')
return 'RESERVED'
`;

/**
 * DEVELOPMENT / TEST ONLY — `credit_providers.code = SANDBOX_BANK`.
 *
 * A self-contained simulated bank that answers instantly:
 * - eligibility: deterministic score from the national code
 *   (`sandboxCreditScore`), eligible when ≥ `minApprovalScore`;
 * - application: approves min(requestedLimit, maxApprovedLimit), rejects a
 *   request below `minRequestedLimit`;
 * - reservations: kept in Redis with an atomic RESERVED → COMMITTED | RELEASED
 *   state machine; commit/release are idempotent, and crossing them fails.
 *
 * No money and no real credit exist behind it. The registry refuses to use it
 * when NODE_ENV=production.
 */
export class SandboxBankProvider implements CreditProviderAdapter {
  readonly code = SANDBOX_BANK_CODE;
  readonly isSandbox = true;

  constructor(
    private readonly redis: RedisService,
    private readonly rules: SandboxBankRules,
  ) {}

  inquireEligibility(nationalCode: string, mobile: string): Promise<EligibilityResult> {
    const score = sandboxCreditScore(nationalCode);
    const eligible = score >= this.rules.minApprovalScore;
    return Promise.resolve({
      eligible,
      score,
      maxEligibleLimit: eligible ? this.rules.maxApprovedLimit : null,
      inquiryRef: `SBXQ-${randomBytes(8).toString('hex').toUpperCase()}`,
      reason: eligible ? null : 'SCORE_BELOW_THRESHOLD',
      details: {
        provider: SANDBOX_BANK_CODE,
        sandbox: true,
        score,
        minApprovalScore: this.rules.minApprovalScore,
        mobileSuffix: mobile.slice(-4),
      },
    });
  }

  submitApplication(userId: string, requestedLimit: Prisma.Decimal, docs: readonly ApplicationDocument[]): Promise<ApplicationDecision> {
    const trackingCode = `SBXA-${randomBytes(8).toString('hex').toUpperCase()}`;
    const details = { provider: SANDBOX_BANK_CODE, sandbox: true, documentsReceived: docs.length, applicantRef: userId.slice(0, 8) };
    if (requestedLimit.lessThan(this.rules.minRequestedLimit)) {
      return Promise.resolve({
        status: 'REJECTED',
        approvedLimit: null,
        trackingCode,
        reason: 'BELOW_MINIMUM_LIMIT',
        details: { ...details, minRequestedLimit: this.rules.minRequestedLimit.toFixed(0) },
      });
    }
    const approvedLimit = Prisma.Decimal.min(requestedLimit, this.rules.maxApprovedLimit).floor();
    return Promise.resolve({
      status: 'APPROVED',
      approvedLimit,
      trackingCode,
      reason: approvedLimit.lessThan(requestedLimit) ? 'CAPPED_AT_MAXIMUM' : null,
      details: { ...details, maxApprovedLimit: this.rules.maxApprovedLimit.toFixed(0) },
    });
  }

  async reserveCredit(creditAccountId: string, amount: Prisma.Decimal, parentOrderId: string): Promise<CreditReservation> {
    if (!amount.isInteger() || !amount.greaterThan(0)) {
      throw new CreditProviderError(`Reservation amount must be a positive whole number of rials, got ${amount.toFixed(2)}`, 'INVALID_AMOUNT', false);
    }
    const reservationRef = `SBXR-${randomBytes(12).toString('hex').toUpperCase()}`;
    const now = new Date().toISOString();
    const record: SandboxReservation = { reservationRef, creditAccountId, parentOrderId, amount: amount.toFixed(0), status: 'RESERVED', createdAt: now, updatedAt: now };
    await this.redis.client.set(sandboxReservationKey(reservationRef), JSON.stringify(record), 'EX', SANDBOX_RESERVATION_TTL_SECONDS, 'NX');
    return { reservationRef, details: { provider: SANDBOX_BANK_CODE, sandbox: true } };
  }

  async commitCredit(reservationRef: string): Promise<void> {
    await this.transition(reservationRef, 'COMMITTED');
  }

  async releaseCredit(reservationRef: string): Promise<void> {
    await this.transition(reservationRef, 'RELEASED');
  }

  /** Current sandbox state of a reservation (tests and diagnostics). */
  async reservationStatus(reservationRef: string): Promise<ReservationStatus | null> {
    const raw = await this.redis.client.get(sandboxReservationKey(reservationRef));
    return raw ? (JSON.parse(raw) as SandboxReservation).status : null;
  }

  private async transition(reservationRef: string, target: 'COMMITTED' | 'RELEASED'): Promise<void> {
    const result = String(await this.redis.client.eval(TRANSITION_SCRIPT, 1, sandboxReservationKey(reservationRef), target, new Date().toISOString()));
    if (result === 'MISSING') {
      throw new CreditProviderError(`Unknown reservation ${reservationRef}`, 'RESERVATION_NOT_FOUND', false);
    }
    if (result.startsWith('CONFLICT:')) {
      throw new CreditProviderError(`Reservation ${reservationRef} is already ${result.slice('CONFLICT:'.length)}`, 'RESERVATION_STATE_CONFLICT', false);
    }
  }
}

function decimalOrNull(value: unknown): Prisma.Decimal | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  try {
    const decimal = new Prisma.Decimal(value);
    return decimal.isFinite() && decimal.isInteger() ? decimal : null;
  } catch {
    return null;
  }
}
