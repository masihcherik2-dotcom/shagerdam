import { ForbiddenException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditAction } from '@prisma/client';
import { TooManyRequestsException } from '../../common/exceptions/too-many-requests.exception';
import type { EnvironmentVariables } from '../../config/env.validation';
import { hashPassword, verifyPassword } from '../../infra/security/password';
import { RedisService } from '../../infra/redis/redis.service';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import type { RequestContext } from '../../common/types/request-context';
import { toE164 } from '../../common/validators/iranian-mobile';
import { AuditLogService } from '../audit/audit-log.service';
import { SmsService } from '../sms/sms.service';
import { UsersService, type PublicUser } from '../users/users.service';
import { OtpService, OtpVerifyResult } from './otp.service';
import { TokenService, loginAttemptsKey, loginLockKey, type IssuedTokens } from './token.service';
import type { RequestOtpDto } from './dto/request-otp.dto';
import type { VerifyOtpDto } from './dto/verify-otp.dto';
import type { PasswordLoginDto } from './dto/password-login.dto';
import type {
  AuthTokensResponseDto,
  LogoutResponseDto,
  MeResponseDto,
  OtpRequestResponseDto,
  ProfileUpdateResponseDto,
} from './dto/auth-response.dto';
import { AuthUserDto, MeResponseDto as MeResponse } from './dto/auth-response.dto';
import type { UpdateProfileDto } from '../users/dto/update-profile.dto';

/** Purpose recorded with the OTP challenge; also used in SMS wording and metrics. */
const OTP_PURPOSE = 'login';

/**
 * The profile response plus the before/after snapshot the audit interceptor needs.
 * Returning it from here keeps the controller free of database reads and gives
 * `audit_logs` a real diff instead of a guess.
 */
export interface ProfileUpdateOutcome {
  response: ProfileUpdateResponseDto;
  audit: { entityId: string; oldValue: unknown; newValue: unknown };
}

/**
 * Orchestrates every authentication flow: OTP login, staff password login,
 * refresh rotation, logout and self-service profile management.
 *
 * Where the security decisions live:
 * - code generation, throttling and the attempt budget are in `OtpService`;
 * - token signing, session bookkeeping and rotation are in `TokenService`;
 * - this service owns the *policy*: what a verified number is allowed to do, when
 *   an account is refused, and what reaches the audit trail.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly maxLoginAttempts: number;
  private readonly lockSeconds: number;

  /**
   * A real Argon2id hash of a random value, verified against when the account
   * does not exist. Without it, "unknown e-mail" answers measurably faster than
   * "wrong password", which turns the login form into an account-enumeration
   * oracle.
   */
  private decoyHashPromise: Promise<string> | null = null;

  constructor(
    private readonly users: UsersService,
    private readonly otp: OtpService,
    private readonly tokens: TokenService,
    private readonly sms: SmsService,
    private readonly audit: AuditLogService,
    private readonly redis: RedisService,
    config: ConfigService<EnvironmentVariables, true>,
  ) {
    this.maxLoginAttempts = config.getOrThrow<number>('AUTH_MAX_LOGIN_ATTEMPTS');
    this.lockSeconds = config.getOrThrow<number>('AUTH_LOCK_SECONDS');
  }

  // ─── OTP flow ─────────────────────────────────────────────────────────────

  /**
   * Step 1 — generate a code and hand it to the SMS provider.
   *
   * Ordering matters: the challenge is stored **before** dispatch. If the
   * provider fails, the client receives `503`, the stored code expires unused
   * within its TTL, and the user retries — a code is never reported as sent when
   * it was not.
   */
  async requestOtp(dto: RequestOtpDto, context: RequestContext): Promise<OtpRequestResponseDto> {
    const { code, challenge } = await this.otp.createChallenge(dto.mobile, OTP_PURPOSE, context.ipAddress);

    const delivery = await this.sms.sendOtp(
      challenge.mobile,
      code,
      challenge.expiresInSeconds,
      OTP_PURPOSE,
    );

    return {
      status: 'sent',
      expiresInSeconds: challenge.expiresInSeconds,
      trackingId: delivery.referenceId,
    };
  }

  /**
   * Step 2 — verify the code and open a session.
   *
   * An unknown number becomes a `CUSTOMER` with an empty `CustomerProfile` at
   * this exact moment (never at step 1), so spamming codes cannot create rows in
   * the identity table.
   */
  async verifyOtp(dto: VerifyOtpDto, context: RequestContext): Promise<AuthTokensResponseDto> {
    const result = await this.otp.verify(dto.mobile, dto.code);

    switch (result) {
      case OtpVerifyResult.NotFound:
        await this.recordFailedLogin(null, 'otp_expired_or_unknown', context);
        throw new UnauthorizedException('The code has expired or was already used. Request a new one.');

      case OtpVerifyResult.Mismatch:
        await this.recordFailedLogin(null, 'otp_mismatch', context);
        throw new UnauthorizedException('Incorrect code.');

      case OtpVerifyResult.Exhausted: {
        const retryAfter = await this.otp.lockRemainingSeconds(dto.mobile);
        await this.recordFailedLogin(null, 'otp_attempts_exhausted', context);
        throw new TooManyRequestsException(
          'Too many incorrect codes. This number is temporarily locked.',
          retryAfter,
        );
      }

      case OtpVerifyResult.Match:
        break;
    }

    const identity = await this.users.ensureCustomer(dto.mobile);
    this.assertActive(identity.user.isActive);

    await this.otp.clear(dto.mobile);
    const tokens = await this.tokens.issue(identity.user, context);
    await this.users.touchLastLogin(identity.user.id);

    this.logger.log(`OTP login succeeded for user ${identity.user.id} (role ${identity.user.role})`);
    return this.toAuthResponse(tokens, identity.user);
  }

  // ─── Password flow (staff, vendors) ───────────────────────────────────────

  /**
   * Password login for accounts that have a password: super admin, admin,
   * support, financial officer and vendors.
   *
   * Failures are counted per identifier in Redis and lock that identifier for
   * `AUTH_LOCK_SECONDS` — not the source IP, so an attacker cannot lock the
   * legitimate owner out of their own account from a shared network, and cannot
   * keep grinding one account while other users stay unaffected.
   */
  async loginWithPassword(dto: PasswordLoginDto, context: RequestContext): Promise<AuthTokensResponseDto> {
    const identifier = normalizeIdentifier(dto.identifier);
    await this.assertNotLocked(identifier);

    const account = await this.users.findByIdentifier(identifier);

    // Always verify a hash, even for an unknown account: identical work, identical timing.
    const hash = account?.passwordHash ?? (await this.decoyHash());
    const passwordMatches = await verifyPassword(hash, dto.password);

    if (account === null || !passwordMatches || account.passwordHash === null) {
      await this.registerFailedLogin(identifier);
      await this.recordFailedLogin(account?.user.id ?? null, 'bad_credentials', context);
      throw new UnauthorizedException('Invalid credentials.');
    }

    this.assertActive(account.user.isActive);

    await this.redis.client.del(loginAttemptsKey(identifier));
    const tokens = await this.tokens.issue(account.user, context);
    await this.users.touchLastLogin(account.user.id);

    this.logger.log(`Password login succeeded for user ${account.user.id} (role ${account.user.role})`);
    return this.toAuthResponse(tokens, account.user);
  }

  // ─── Session lifecycle ────────────────────────────────────────────────────

  /**
   * Exchanges a refresh token for a new pair. The presented token is consumed
   * (rotated), so a leaked copy becomes useless as soon as the legitimate client
   * refreshes — and a *reused* copy revokes the whole session.
   */
  async refresh(refreshToken: string, context: RequestContext): Promise<AuthTokensResponseDto> {
    const sessionId = await this.tokens.sessionIdOfRefreshToken(refreshToken);
    const session = await this.tokens.getSession(sessionId);
    if (session === null) {
      throw new UnauthorizedException('Refresh token is no longer valid');
    }

    const identity = await this.users.getIdentity(session.userId);
    this.assertActive(identity.user.isActive);

    const tokens = await this.tokens.rotate(refreshToken, identity.user, context);
    return this.toAuthResponse(tokens, identity.user);
  }

  /**
   * Revokes the current session. When the client also sends its refresh token
   * (recommended, so the pair is destroyed even if the access token already
   * expired), that session is revoked too — but only when it belongs to the caller.
   */
  async logout(actor: AuthenticatedUser, refreshToken?: string): Promise<LogoutResponseDto> {
    let sessionsRevoked = 0;

    if (await this.tokens.revoke(actor.sessionId)) {
      sessionsRevoked += 1;
    }

    if (refreshToken !== undefined) {
      const sessionId = await this.tokens.sessionIdOfRefreshToken(refreshToken);
      const session = await this.tokens.getSession(sessionId);

      if (session !== null && session.userId === actor.id && sessionId !== actor.sessionId) {
        if (await this.tokens.revoke(sessionId)) {
          sessionsRevoked += 1;
        }
      }
    }

    return { revoked: true, sessionsRevoked };
  }

  // ─── Identity ─────────────────────────────────────────────────────────────

  async me(actor: AuthenticatedUser): Promise<MeResponseDto> {
    return MeResponse.from(await this.users.getIdentity(actor.id));
  }

  async updateProfile(actor: AuthenticatedUser, dto: UpdateProfileDto): Promise<ProfileUpdateOutcome> {
    const result = await this.users.updateProfile(actor.id, dto);
    const identity = await this.users.getIdentity(actor.id);

    return {
      response: { ...MeResponse.from(identity), updated: true },
      audit: { entityId: actor.id, oldValue: result.before, newValue: result.after },
    };
  }

  /** Honest report of the active SMS provider, so operators never have to guess. */
  smsProviderInfo(): { provider: string; isTestProvider: boolean } {
    return this.sms.describe();
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  private assertActive(isActive: boolean): void {
    if (!isActive) {
      throw new ForbiddenException('This account is deactivated. Contact support.');
    }
  }

  private async assertNotLocked(identifier: string): Promise<void> {
    const ttl = await this.redis.client.ttl(loginLockKey(identifier));
    if (ttl > 0) {
      throw new TooManyRequestsException('Too many failed attempts. Try again later.', ttl);
    }
  }

  /** Increments the failure counter and locks the identifier at the threshold. */
  private async registerFailedLogin(identifier: string): Promise<void> {
    const [[, attempts]] = (await this.redis.client
      .multi()
      .incr(loginAttemptsKey(identifier))
      .expire(loginAttemptsKey(identifier), this.lockSeconds, 'NX')
      .exec()) as [[Error | null, number], unknown];

    if (attempts >= this.maxLoginAttempts) {
      await this.redis.client.set(loginLockKey(identifier), '1', 'EX', this.lockSeconds);
      await this.redis.client.del(loginAttemptsKey(identifier));
      this.logger.warn(`Login locked for ${maskIdentifier(identifier)} after ${attempts} failed attempts`);
    }
  }

  private async recordFailedLogin(userId: string | null, reason: string, context: RequestContext): Promise<void> {
    await this.audit.record({
      userId,
      action: AuditAction.LOGIN,
      entityName: 'User',
      entityId: userId,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      newValue: { success: false, reason },
    });
  }

  private async decoyHash(): Promise<string> {
    this.decoyHashPromise ??= hashPassword(`decoy-${Date.now()}-${Math.random()}`);
    return this.decoyHashPromise;
  }

  private toAuthResponse(tokens: IssuedTokens, user: PublicUser): AuthTokensResponseDto {
    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresIn: tokens.expiresIn,
      refreshExpiresIn: tokens.refreshExpiresIn,
      sessionId: tokens.sessionId,
      user: AuthUserDto.from(user),
    };
  }
}

/**
 * Normalizes a login identifier so the failure counter cannot be split by
 * spelling: `ADMIN@x.ir`, `admin@x.ir ` and `admin@x.ir` share one bucket, and so
 * do `+989120000001` and `09120000001`.
 */
export function normalizeIdentifier(identifier: string): string {
  const trimmed = identifier.trim();
  const mobile = toE164(trimmed);
  return mobile ?? trimmed.toLowerCase();
}

/** Shows only the shape of an identifier in logs, never the whole value. */
function maskIdentifier(identifier: string): string {
  if (identifier.startsWith('+98')) {
    return `${identifier.slice(0, 6)}****${identifier.slice(-3)}`;
  }
  const [local, domain] = identifier.split('@');
  return domain === undefined ? '***' : `${(local ?? '').slice(0, 2)}***@${domain}`;
}
