import { createHash, randomBytes } from 'node:crypto';
import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { TooManyRequestsException } from '../../../common/exceptions/too-many-requests.exception';
import type { RequestContext } from '../../../common/types/request-context';
import { toE164 } from '../../../common/validators/iranian-mobile';
import { RedisService } from '../../../infra/redis/redis.service';
import { SmsService } from '../../sms/sms.service';
import { UsersService, type PublicUser } from '../../users/users.service';
import { AuthService } from '../auth.service';
import type { AuthTokensResponseDto, OtpRequestResponseDto } from '../dto/auth-response.dto';
import { OtpService } from '../otp.service';
import { GoogleIdTokenError, type GoogleProfile } from './google-id-token';
import { GoogleOAuthClient, GoogleOAuthError } from './google-oauth.client';

/** OTP purpose of the mobile binding step (SMS wording, metrics). */
export const GOOGLE_OTP_PURPOSE = 'google_link';

export const GOOGLE_STATE_TTL_SECONDS = 600;
export const GOOGLE_SIGNUP_TTL_SECONDS = 900;
/** Sign-in attempts one client IP may start per hour (each one stores a Redis record). */
export const GOOGLE_START_LIMIT_PER_HOUR = 30;

export const GoogleKeys = {
  state: (state: string): string => `auth:google:state:${state}`,
  /** Keyed by the SHA-256 of the ticket: a Redis dump does not reveal usable tickets. */
  signup: (ticket: string): string => `auth:google:signup:${createHash('sha256').update(ticket).digest('hex')}`,
  startByIp: (ip: string): string => `auth:google:start:ip:${ip}`,
};

/** Roles that may use Google sign-in. Staff accounts keep password login only. */
const GOOGLE_ROLES: readonly UserRole[] = [UserRole.CUSTOMER, UserRole.VENDOR];

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

interface StoredState {
  verifier: string;
  nonce: string;
  next: string | null;
}

interface StoredSignup {
  profile: GoogleProfile;
  next: string | null;
  /** The mobile the binding code was sent to; the code is accepted only for it. */
  mobile: string | null;
}

export interface GoogleStartResult {
  authorizationUrl: string;
  state: string;
  expiresInSeconds: number;
}

export type GoogleCallbackResult =
  | { status: 'signed_in'; next: string | null; tokens: AuthTokensResponseDto }
  | { status: 'mobile_required'; next: string | null; ticket: string; expiresInSeconds: number; profile: GoogleSignupProfile };

export interface GoogleSignupProfile {
  email: string | null;
  name: string | null;
  picture: string | null;
}

/**
 * Sign-in with Google, completed by a verified mobile number (architect's
 * decision: "method 1 — verify the mobile by SMS after Google").
 *
 * 1. `start`    — state + PKCE verifier + nonce stored in Redis (10 min); the
 *                 caller sends the browser to Google.
 * 2. `callback` — the state is consumed (single use), the code is exchanged
 *                 server-to-server, the ID token validated. Then:
 *                 • subject already linked                → session;
 *                 • verified Google e-mail of an account   → link + session;
 *                 • otherwise                              → signup ticket (15 min):
 * 3. `requestSignupOtp` / `verifySignup` — the user proves a mobile number by
 *                 OTP; an account with that mobile gets the Google account linked,
 *                 otherwise a CUSTOMER account is created. Then → session.
 *
 * Only CUSTOMER and VENDOR accounts may sign in with Google; staff accounts are
 * refused (they use password login).
 */
@Injectable()
export class GoogleAuthService {
  private readonly logger = new Logger(GoogleAuthService.name);

  constructor(
    private readonly google: GoogleOAuthClient,
    private readonly auth: AuthService,
    private readonly users: UsersService,
    private readonly otp: OtpService,
    private readonly sms: SmsService,
    private readonly redis: RedisService,
  ) {}

  get enabled(): boolean {
    return this.google.isConfigured;
  }

  async start(rawNext: unknown, context: RequestContext): Promise<GoogleStartResult> {
    this.assertEnabled();
    if (context.ipAddress !== null) {
      const key = GoogleKeys.startByIp(context.ipAddress);
      const count = await this.redis.client.incr(key);
      if (count === 1) await this.redis.client.expire(key, 3600);
      if (count > GOOGLE_START_LIMIT_PER_HOUR) {
        const ttl = await this.redis.client.ttl(key);
        throw new TooManyRequestsException('Too many Google sign-in attempts from this network. Try again later.', ttl > 0 ? ttl : 3600);
      }
    }

    const state = randomToken(32);
    const verifier = randomToken(48);
    const nonce = randomToken(24);
    const stored: StoredState = { verifier, nonce, next: sanitizeNextPath(rawNext) };
    await this.redis.client.set(GoogleKeys.state(state), JSON.stringify(stored), 'EX', GOOGLE_STATE_TTL_SECONDS);
    const codeChallenge = createHash('sha256').update(verifier).digest('base64url');
    return { authorizationUrl: this.google.authorizationUrl({ state, codeChallenge, nonce }), state, expiresInSeconds: GOOGLE_STATE_TTL_SECONDS };
  }

  async callback(code: string, state: string, context: RequestContext): Promise<GoogleCallbackResult> {
    this.assertEnabled();
    if (!TOKEN_PATTERN.test(state) || typeof code !== 'string' || code.length === 0 || code.length > 2048) {
      throw googleError(HttpStatus.BAD_REQUEST, 'GOOGLE_STATE_INVALID', 'The sign-in link is invalid or has expired. Start again.');
    }
    const raw = await this.redis.client.getdel(GoogleKeys.state(state));
    const stored = parseJson<StoredState>(raw);
    if (stored === null) {
      throw googleError(HttpStatus.BAD_REQUEST, 'GOOGLE_STATE_INVALID', 'The sign-in link is invalid or has expired. Start again.');
    }

    const profile = await this.exchange(code, stored);

    const linked = await this.users.findByGoogleSubject(profile.subject);
    if (linked !== null) {
      return { status: 'signed_in', next: stored.next, tokens: await this.signIn(linked.user, context, { linked: 'existing' }) };
    }

    if (profile.email !== null && profile.emailVerified) {
      const byEmail = await this.users.findByEmailForGoogle(profile.email);
      if (byEmail !== null) {
        await this.assertMayUseGoogle(byEmail.user, context);
        if (byEmail.googleSubject !== null) {
          await this.auth.recordRefusedExternalLogin(byEmail.user.id, 'google_email_linked_to_other_subject', context);
          throw googleError(HttpStatus.CONFLICT, 'GOOGLE_ACCOUNT_CONFLICT', 'The account with this e-mail is linked to another Google account.');
        }
        const user = await this.users.linkGoogleAccount(byEmail.user.id, profile);
        return { status: 'signed_in', next: stored.next, tokens: await this.signIn(user, context, { linked: 'verified_email' }) };
      }
    }

    const ticket = randomToken(32);
    const signup: StoredSignup = { profile, next: stored.next, mobile: null };
    await this.redis.client.set(GoogleKeys.signup(ticket), JSON.stringify(signup), 'EX', GOOGLE_SIGNUP_TTL_SECONDS);
    return { status: 'mobile_required', next: stored.next, ticket, expiresInSeconds: GOOGLE_SIGNUP_TTL_SECONDS, profile: publicProfile(profile) };
  }

  async getSignup(ticket: unknown): Promise<GoogleSignupProfile & { next: string | null; expiresInSeconds: number; mobile: string | null }> {
    const { signup, key } = await this.loadSignup(ticket);
    const ttl = await this.redis.client.ttl(key);
    return { ...publicProfile(signup.profile), next: signup.next, mobile: signup.mobile, expiresInSeconds: ttl > 0 ? ttl : 0 };
  }

  async requestSignupOtp(ticket: unknown, mobile: string, context: RequestContext): Promise<OtpRequestResponseDto> {
    const { signup, key } = await this.loadSignup(ticket);
    const normalized = toE164(mobile) ?? mobile;
    const { code, challenge } = await this.otp.createChallenge(normalized, GOOGLE_OTP_PURPOSE, context.ipAddress);
    // Bind the ticket to this number before dispatch, keeping the ticket's own expiry.
    await this.redis.client.set(key, JSON.stringify({ ...signup, mobile: challenge.mobile } satisfies StoredSignup), 'KEEPTTL');
    const delivery = await this.sms.sendOtp(challenge.mobile, code, challenge.expiresInSeconds, GOOGLE_OTP_PURPOSE);
    return { status: 'sent', expiresInSeconds: challenge.expiresInSeconds, trackingId: delivery.referenceId };
  }

  async verifySignup(ticket: unknown, mobile: string, code: string, context: RequestContext): Promise<{ next: string | null; tokens: AuthTokensResponseDto }> {
    const { signup, key } = await this.loadSignup(ticket);
    const normalized = toE164(mobile) ?? mobile;
    if (signup.mobile === null || signup.mobile !== normalized) {
      throw googleError(HttpStatus.BAD_REQUEST, 'GOOGLE_SIGNUP_MOBILE_MISMATCH', 'Request a code for this mobile number first.');
    }
    await this.auth.assertOtpMatches(normalized, code, context);

    const { profile } = signup;
    let user: PublicUser;
    let detail: Record<string, unknown>;
    const bySubject = await this.users.findByGoogleSubject(profile.subject);
    const byMobile = await this.users.findByMobileForGoogle(normalized);
    if (bySubject !== null && bySubject.user.mobile !== normalized) {
      // Linked to another account while this ticket was open.
      await this.auth.recordRefusedExternalLogin(bySubject.user.id, 'google_subject_linked_elsewhere', context);
      throw googleError(HttpStatus.CONFLICT, 'GOOGLE_ACCOUNT_CONFLICT', 'This Google account is already linked to another mobile number.');
    }
    if (byMobile !== null) {
      await this.assertMayUseGoogle(byMobile.user, context);
      if (byMobile.googleSubject !== null && byMobile.googleSubject !== profile.subject) {
        await this.auth.recordRefusedExternalLogin(byMobile.user.id, 'google_mobile_linked_to_other_subject', context);
        throw googleError(HttpStatus.CONFLICT, 'GOOGLE_MOBILE_LINKED_ELSEWHERE', 'This mobile number belongs to an account linked to another Google account.');
      }
      user = byMobile.googleSubject === null ? await this.users.linkGoogleAccount(byMobile.user.id, profile) : byMobile.user;
      detail = { linked: 'verified_mobile' };
    } else {
      user = await this.users.createGoogleCustomer(normalized, { ...profile, name: profile.name });
      detail = { linked: 'new_account' };
    }

    await this.otp.clear(normalized);
    await this.redis.client.del(key);
    return { next: signup.next, tokens: await this.signIn(user, context, detail) };
  }

  // ─── internals ────────────────────────────────────────────────────────────

  private async exchange(code: string, stored: StoredState): Promise<GoogleProfile> {
    try {
      return await this.google.exchangeCode(code, stored.verifier, stored.nonce);
    } catch (error) {
      if (error instanceof GoogleOAuthError && error.reason === 'unavailable') {
        throw googleError(HttpStatus.BAD_GATEWAY, 'GOOGLE_UNAVAILABLE', 'Google could not be reached. Try again in a moment.');
      }
      if (error instanceof GoogleOAuthError || error instanceof GoogleIdTokenError) {
        throw googleError(HttpStatus.UNAUTHORIZED, 'GOOGLE_EXCHANGE_FAILED', 'Google did not confirm this sign-in. Start again.');
      }
      throw error;
    }
  }

  private async signIn(user: PublicUser, context: RequestContext, detail: Record<string, unknown>): Promise<AuthTokensResponseDto> {
    await this.assertMayUseGoogle(user, context);
    return this.auth.completeExternalLogin(user, 'google', context, detail);
  }

  private async assertMayUseGoogle(user: PublicUser, context: RequestContext): Promise<void> {
    if (!GOOGLE_ROLES.includes(user.role)) {
      await this.auth.recordRefusedExternalLogin(user.id, 'google_staff_account', context);
      this.logger.warn(`Google sign-in refused for staff account ${user.id} (role ${user.role})`);
      throw googleError(HttpStatus.FORBIDDEN, 'GOOGLE_STAFF_NOT_ALLOWED', 'Staff accounts sign in with their password.');
    }
  }

  private async loadSignup(ticket: unknown): Promise<{ signup: StoredSignup; key: string }> {
    if (typeof ticket !== 'string' || !TOKEN_PATTERN.test(ticket)) {
      throw googleError(HttpStatus.UNAUTHORIZED, 'GOOGLE_SIGNUP_EXPIRED', 'The Google sign-in has expired. Start again.');
    }
    const key = GoogleKeys.signup(ticket);
    const signup = parseJson<StoredSignup>(await this.redis.client.get(key));
    if (signup === null) {
      throw googleError(HttpStatus.UNAUTHORIZED, 'GOOGLE_SIGNUP_EXPIRED', 'The Google sign-in has expired. Start again.');
    }
    return { signup, key };
  }

  private assertEnabled(): void {
    if (!this.google.isConfigured) {
      throw googleError(HttpStatus.SERVICE_UNAVAILABLE, 'GOOGLE_NOT_CONFIGURED', 'Google sign-in is not enabled on this server.');
    }
  }
}

/**
 * Accepts only a same-site path for the post-login redirect: starts with one
 * "/", no scheme-relative "//", no backslash, no control characters, ≤ 512.
 */
export function sanitizeNextPath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) return null;
  // eslint-disable-next-line no-control-regex
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\') || /[\u0000-\u001f\u007f]/.test(value)) return null;
  return value;
}

function randomToken(bytes: number): string {
  return randomBytes(bytes).toString('base64url');
}

function parseJson<T>(raw: string | null): T | null {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function publicProfile(profile: GoogleProfile): GoogleSignupProfile {
  return { email: profile.email, name: profile.name, picture: profile.picture };
}

const REASONS: Readonly<Record<number, string>> = {
  [HttpStatus.BAD_REQUEST]: 'Bad Request',
  [HttpStatus.UNAUTHORIZED]: 'Unauthorized',
  [HttpStatus.FORBIDDEN]: 'Forbidden',
  [HttpStatus.CONFLICT]: 'Conflict',
  [HttpStatus.BAD_GATEWAY]: 'Bad Gateway',
  [HttpStatus.SERVICE_UNAVAILABLE]: 'Service Unavailable',
};

/** HTTP error with a machine-readable `code` the storefront maps to Persian copy. */
function googleError(status: HttpStatus, code: string, message: string): HttpException {
  return new HttpException({ statusCode: status, error: REASONS[status] ?? 'Error', code, message }, status);
}
