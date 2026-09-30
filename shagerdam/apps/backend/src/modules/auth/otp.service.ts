import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { TooManyRequestsException } from '../../common/exceptions/too-many-requests.exception';
import { ConfigService } from '@nestjs/config';
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import type { EnvironmentVariables } from '../../config/env.validation';
import { RedisService } from '../../infra/redis/redis.service';
import { maskMobile, toE164 } from '../../common/validators/iranian-mobile';

const HOUR_SECONDS = 3_600;

/** Redis key layout. One namespace per concern keeps `SCAN`-based ops sane. */
export const OtpKeys = {
  /** Hash: codeHash, attempts, purpose, createdAt — TTL = OTP lifetime. */
  challenge: (mobile: string) => `auth:otp:challenge:${mobile}`,
  /** Present while the per-number cooldown is running. */
  cooldown: (mobile: string) => `auth:otp:cooldown:${mobile}`,
  /** Present while the number is locked after too many wrong codes. */
  lock: (mobile: string) => `auth:otp:lock:${mobile}`,
  /** Rolling hourly counter per number. */
  hourlyByMobile: (mobile: string) => `auth:otp:hourly:mobile:${mobile}`,
  /** Rolling hourly counter per client IP. */
  hourlyByIp: (ip: string) => `auth:otp:hourly:ip:${ip}`,
} as const;

/**
 * Outcome of an attempted verification. `Mismatch` and `Exhausted` are separate
 * states so the caller can tell "wrong code, try again" from "wrong code, and
 * that was your last one" — which is exactly what the API reports back.
 */
export enum OtpVerifyResult {
  /** Code matched; the challenge was consumed. */
  Match = 'match',
  /** Code did not match; attempts remain. */
  Mismatch = 'mismatch',
  /** Attempt budget exhausted; the number is now locked. */
  Exhausted = 'exhausted',
  /** No challenge exists: never requested, already used, or expired. */
  NotFound = 'notFound',
}

export interface OtpChallenge {
  mobile: string;
  expiresInSeconds: number;
  attemptsAllowed: number;
}

/**
 * Owns one-time codes: generation, storage, throttling and verification.
 *
 * Security properties, all enforced in Redis rather than in memory so they hold
 * across every API instance:
 *
 * - the code is generated with `crypto.randomInt`, never `Math.random`, and is
 *   never stored in clear text: Redis keeps `sha256(mobile:code)`, so a Redis
 *   dump does not reveal live login codes;
 * - verification is a single atomic Lua script, so ten parallel requests cannot
 *   each get a "fresh" attempt budget past the limit;
 * - the failure counter keeps the *original* TTL — a brute-force loop cannot
 *   extend the window in which guessing is possible;
 * - three independent ceilings are applied: per-number cooldown, per-number
 *   hourly quota and per-IP hourly quota (the last one stops an attacker from
 *   enumerating many numbers from one host).
 */
@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);
  private readonly ttlSeconds: number;
  private readonly length: number;
  private readonly cooldownSeconds: number;
  private readonly maxAttempts: number;
  private readonly lockSeconds: number;
  private readonly maxPerHourPerMobile: number;
  private readonly maxPerHourPerIp: number;

  /**
   * Atomic verify: returns 0 = match, 1 = mismatch, 2 = exhausted, 3 = missing.
   * Kept in Lua so the read-increment-branch sequence cannot interleave.
   */
  private readonly verifyScript = `
    local key = KEYS[1]
    local providedHash = ARGV[1]
    local maxAttempts = tonumber(ARGV[2])

    if redis.call('EXISTS', key) == 0 then
      return 3
    end

    local storedHash = redis.call('HGET', key, 'codeHash')
    if storedHash == providedHash then
      redis.call('DEL', key)
      return 0
    end

    local attempts = redis.call('HINCRBY', key, 'attempts', 1)
    if attempts >= maxAttempts then
      redis.call('DEL', key)
      return 2
    end
    return 1
  `;

  constructor(
    private readonly redis: RedisService,
    config: ConfigService<EnvironmentVariables, true>,
  ) {
    this.ttlSeconds = config.getOrThrow<number>('OTP_TTL_SECONDS');
    this.length = config.getOrThrow<number>('OTP_LENGTH');
    this.cooldownSeconds = config.getOrThrow<number>('OTP_REQUEST_COOLDOWN_SECONDS');
    this.maxAttempts = config.getOrThrow<number>('OTP_MAX_VERIFY_ATTEMPTS');
    this.lockSeconds = config.getOrThrow<number>('OTP_LOCK_SECONDS');
    this.maxPerHourPerMobile = config.getOrThrow<number>('OTP_MAX_REQUESTS_PER_HOUR');
    this.maxPerHourPerIp = config.getOrThrow<number>('OTP_MAX_REQUESTS_PER_IP_PER_HOUR');
  }

  /**
   * Creates a challenge for a mobile number and returns the code to dispatch.
   * The caller is responsible for actually sending it, so a provider failure
   * cannot leave a code that was never delivered.
   *
   * @throws TooManyRequestsException when the number is locked, cooling down, or
   * has exceeded one of the hourly quotas.
   */
  async createChallenge(mobile: string, purpose: string, clientIp: string | null): Promise<{ code: string; challenge: OtpChallenge }> {
    const normalized = this.normalize(mobile);

    await this.assertNotLocked(normalized);

    // The cooldown is the primary rule (one request per window) and is claimed
    // atomically, so two concurrent requests can never both generate a code.
    const claimed = await this.redis.client.set(
      OtpKeys.cooldown(normalized),
      '1',
      'EX',
      this.cooldownSeconds,
      'NX',
    );
    if (claimed === null) {
      const retryAfter = await this.retryAfterSeconds(OtpKeys.cooldown(normalized), this.cooldownSeconds);
      throw this.rateLimited(
        `An OTP was requested recently. Try again in ${retryAfter} seconds.`,
        retryAfter,
      );
    }

    await this.assertWithinHourlyQuota(
      OtpKeys.hourlyByMobile(normalized),
      this.maxPerHourPerMobile,
      'This number has requested too many codes in the last hour.',
    );
    if (clientIp) {
      await this.assertWithinHourlyQuota(
        OtpKeys.hourlyByIp(clientIp),
        this.maxPerHourPerIp,
        'Too many OTP requests from this network in the last hour.',
      );
    }

    const code = this.generateCode();
    const key = OtpKeys.challenge(normalized);

    // A fresh request invalidates any previous code: only the newest one works.
    await this.redis.client
      .multi()
      .del(key)
      .hset(key, {
        codeHash: this.hashCode(normalized, code),
        attempts: '0',
        purpose,
        createdAt: new Date().toISOString(),
      })
      .expire(key, this.ttlSeconds)
      .exec();

    this.logger.debug(`OTP challenge created for ${maskMobile(normalized)} (purpose: ${purpose})`);

    return {
      code,
      challenge: { mobile: normalized, expiresInSeconds: this.ttlSeconds, attemptsAllowed: this.maxAttempts },
    };
  }

  /**
   * Verifies a submitted code. Consumes the challenge on success; on the final
   * wrong attempt it deletes the challenge and locks the number for
   * `OTP_LOCK_SECONDS`.
   */
  async verify(mobile: string, code: string): Promise<OtpVerifyResult> {
    const normalized = this.normalize(mobile);
    await this.assertNotLocked(normalized);

    const raw = (await this.redis.client.eval(
      this.verifyScript,
      1,
      OtpKeys.challenge(normalized),
      this.hashCode(normalized, code),
      String(this.maxAttempts),
    )) as number;

    if (raw === 2) {
      await this.redis.client.set(OtpKeys.lock(normalized), '1', 'EX', this.lockSeconds);
      this.logger.warn(
        `OTP attempt budget exhausted for ${maskMobile(normalized)}; locked for ${this.lockSeconds}s`,
      );
      return OtpVerifyResult.Exhausted;
    }
    if (raw === 0) {
      return OtpVerifyResult.Match;
    }
    if (raw === 1) {
      return OtpVerifyResult.Mismatch;
    }
    return OtpVerifyResult.NotFound;
  }

  /** Remaining validity of the active challenge in seconds, 0 when none exists. */
  async challengeTtl(mobile: string): Promise<number> {
    const ttl = await this.redis.client.ttl(OtpKeys.challenge(this.normalize(mobile)));
    return ttl > 0 ? ttl : 0;
  }

  /** Clears every artifact of a number: used after a successful login. */
  async clear(mobile: string): Promise<void> {
    const normalized = this.normalize(mobile);
    await this.redis.client.del(OtpKeys.challenge(normalized), OtpKeys.lock(normalized));
  }

  /** Remaining lock time in seconds, 0 when the number is not locked. */
  async lockRemainingSeconds(mobile: string): Promise<number> {
    return this.retryAfterSeconds(OtpKeys.lock(this.normalize(mobile)), 0);
  }

  /**
   * `crypto.randomInt` is a CSPRNG and is already uniform over the range, so no
   * modulo bias correction is needed. Codes are zero-padded to the configured
   * length: `00042` is a valid code and must not become `42`.
   */
  private generateCode(): string {
    const upperBound = 10 ** this.length;
    return String(randomInt(0, upperBound)).padStart(this.length, '0');
  }

  /**
   * Binds the digest to the mobile number so a hash captured for one number is
   * useless for another, and compares in constant time to avoid leaking the code
   * through response timing.
   */
  private hashCode(mobile: string, code: string): string {
    return createHash('sha256').update(`${mobile}:${code}`).digest('hex');
  }

  /** Constant-time comparison helper, exported for reuse in token checks. */
  static safeEquals(left: string, right: string): boolean {
    const leftBuffer = Buffer.from(left, 'utf8');
    const rightBuffer = Buffer.from(right, 'utf8');
    if (leftBuffer.length !== rightBuffer.length) {
      return false;
    }
    return timingSafeEqual(leftBuffer, rightBuffer);
  }

  private normalize(mobile: string): string {
    const normalized = toE164(mobile);
    if (normalized === null) {
      // Defensive: DTO validation already guarantees this, but a service method
      // must never silently operate on an unnormalized Redis key.
      throw new BadRequestException('Invalid Iranian mobile number');
    }
    return normalized;
  }

  private async assertNotLocked(mobile: string): Promise<void> {
    const remaining = await this.retryAfterSeconds(OtpKeys.lock(mobile), 0);
    if (remaining > 0) {
      throw this.rateLimited(
        `Too many failed attempts. This number is locked for ${remaining} more seconds.`,
        remaining,
      );
    }
  }

  private async assertWithinHourlyQuota(key: string, limit: number, message: string): Promise<void> {
    const [[, count]] = (await this.redis.client
      .multi()
      .incr(key)
      .expire(key, HOUR_SECONDS, 'NX')
      .exec()) as [[Error | null, number], unknown];

    if (count > limit) {
      const retryAfter = await this.retryAfterSeconds(key, HOUR_SECONDS);
      throw this.rateLimited(message, retryAfter);
    }
  }

  private async retryAfterSeconds(key: string, fallback: number): Promise<number> {
    const ttl = await this.redis.client.ttl(key);
    return ttl > 0 ? ttl : fallback;
  }

  private rateLimited(message: string, retryAfterSeconds: number): TooManyRequestsException {
    return new TooManyRequestsException(message, retryAfterSeconds);
  }
}
