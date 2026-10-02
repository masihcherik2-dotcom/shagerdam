import { createHash, randomBytes } from 'node:crypto';
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import type { RequestContext } from '../../../common/types/request-context';
import { normalizeEmail } from '../../../common/validators/email';
import { toE164 } from '../../../common/validators/iranian-mobile';
import { RedisService } from '../../../infra/redis/redis.service';
import { EmailService, emailError } from '../../mail/email.service';
import { SmsService } from '../../sms/sms.service';
import { UsersService, type PublicUser } from '../../users/users.service';
import { AuthService } from '../auth.service';
import type { AuthTokensResponseDto, OtpRequestResponseDto } from '../dto/auth-response.dto';
import { OtpService } from '../otp.service';

export const EMAIL_LOGIN_PURPOSE = 'email_login';
export const EMAIL_LINK_PURPOSE = 'email_link';
export const EMAIL_SIGNUP_TTL_SECONDS = 900;

export const EmailOtpKeys = {
  signup: (ticket: string): string => `auth:email-otp:signup:${createHash('sha256').update(ticket).digest('hex')}`,
};

const EMAIL_ROLES: readonly UserRole[] = [UserRole.CUSTOMER, UserRole.VENDOR];
const TICKET_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

interface StoredSignup {
  email: string;
  mobile: string | null;
}

export type EmailOtpVerifyResult =
  | { status: 'signed_in'; tokens: AuthTokensResponseDto }
  | { status: 'mobile_required'; ticket: string; expiresInSeconds: number; email: string };

/**
 * Sign-in and sign-up with a code sent by e-mail.
 *
 * 1. `request` e-mails a code to any address — whether or not an account
 *    exists, so the endpoint reveals nothing about registered addresses.
 * 2. `verify` checks it. An account whose address is *verified* signs in at
 *    once. Anything else (no account, or an address that was only typed into a
 *    profile) continues with a one-time mobile check, because the mobile number
 *    is the platform's primary identity:
 * 3. `requestSignupOtp` / `verifySignup` confirm a mobile by SMS. That account
 *    (or a new customer account) receives the now-proven address.
 *
 * Staff accounts keep signing in with their password.
 */
@Injectable()
export class EmailOtpService {
  private readonly logger = new Logger(EmailOtpService.name);

  constructor(
    private readonly email: EmailService,
    private readonly otp: OtpService,
    private readonly auth: AuthService,
    private readonly users: UsersService,
    private readonly sms: SmsService,
    private readonly redis: RedisService,
  ) {}

  status(): { enabled: boolean; isTestProvider: boolean } {
    const info = this.email.describe();
    return { enabled: info.enabled, isTestProvider: info.isTestProvider };
  }

  async request(rawEmail: string, context: RequestContext): Promise<OtpRequestResponseDto> {
    this.assertEnabled();
    const email = this.normalize(rawEmail);
    const { code, challenge } = await this.otp.createEmailChallenge(email, EMAIL_LOGIN_PURPOSE, context.ipAddress);
    try {
      const delivery = await this.email.sendOtp(email, code, challenge.expiresInSeconds, EMAIL_LOGIN_PURPOSE);
      return { status: 'sent', expiresInSeconds: challenge.expiresInSeconds, trackingId: delivery.messageId };
    } catch (error) {
      // Nothing was delivered: let the user retry now instead of waiting out the cooldown.
      await this.otp.releaseEmailChallenge(email);
      throw error;
    }
  }

  async verify(rawEmail: string, code: string, context: RequestContext): Promise<EmailOtpVerifyResult> {
    this.assertEnabled();
    const email = this.normalize(rawEmail);
    await this.auth.assertEmailOtpMatches(email, code, context);
    await this.otp.clearEmail(email);

    const owner = await this.users.findByEmailForSignIn(email);
    if (owner !== null && owner.emailVerifiedAt !== null) {
      return { status: 'signed_in', tokens: await this.signIn(owner.user, context, { linked: 'verified_email' }) };
    }

    const ticket = randomBytes(32).toString('base64url');
    const stored: StoredSignup = { email, mobile: null };
    await this.redis.client.set(EmailOtpKeys.signup(ticket), JSON.stringify(stored), 'EX', EMAIL_SIGNUP_TTL_SECONDS);
    return { status: 'mobile_required', ticket, expiresInSeconds: EMAIL_SIGNUP_TTL_SECONDS, email };
  }

  async getSignup(ticket: unknown): Promise<{ email: string; mobile: string | null; expiresInSeconds: number }> {
    const { signup, key } = await this.loadSignup(ticket);
    const ttl = await this.redis.client.ttl(key);
    return { email: signup.email, mobile: signup.mobile, expiresInSeconds: ttl > 0 ? ttl : 0 };
  }

  async requestSignupOtp(ticket: unknown, mobile: string, context: RequestContext): Promise<OtpRequestResponseDto> {
    const { signup, key } = await this.loadSignup(ticket);
    const { code, challenge } = await this.otp.createChallenge(toE164(mobile) ?? mobile, EMAIL_LINK_PURPOSE, context.ipAddress);
    // Bind the ticket to this number before dispatch, keeping the ticket's own expiry.
    await this.redis.client.set(key, JSON.stringify({ ...signup, mobile: challenge.mobile } satisfies StoredSignup), 'KEEPTTL');
    const delivery = await this.sms.sendOtp(challenge.mobile, code, challenge.expiresInSeconds, EMAIL_LINK_PURPOSE);
    return { status: 'sent', expiresInSeconds: challenge.expiresInSeconds, trackingId: delivery.referenceId };
  }

  async verifySignup(ticket: unknown, mobile: string, code: string, context: RequestContext): Promise<AuthTokensResponseDto> {
    const { signup, key } = await this.loadSignup(ticket);
    const normalized = toE164(mobile) ?? mobile;
    if (signup.mobile === null || signup.mobile !== normalized) {
      throw emailError(HttpStatus.BAD_REQUEST, 'EMAIL_OTP_SIGNUP_MOBILE_MISMATCH', 'Request a code for this mobile number first.');
    }
    await this.auth.assertOtpMatches(normalized, code, context);

    const byMobile = await this.users.findByMobileForEmailLink(normalized);
    let user: PublicUser;
    const detail: Record<string, unknown> = {};
    if (byMobile !== null) {
      await this.assertMayUseEmail(byMobile.user, context);
      if (byMobile.user.email === signup.email) {
        user = byMobile.emailVerifiedAt === null ? await this.users.markEmailVerified(byMobile.user.id) : byMobile.user;
        detail.linked = 'confirmed_email';
      } else {
        if (byMobile.user.email !== null && byMobile.emailVerifiedAt !== null) {
          await this.auth.recordRefusedExternalLogin(byMobile.user.id, 'email_otp_mobile_has_other_verified_email', context);
          throw emailError(HttpStatus.CONFLICT, 'EMAIL_OTP_MOBILE_HAS_OTHER_EMAIL', 'The account of this mobile number already has another verified e-mail.');
        }
        const attached = await this.users.attachProvenEmail({ userId: byMobile.user.id }, signup.email);
        user = attached.user;
        detail.linked = 'verified_mobile';
        if (attached.detachedFrom !== null) detail.emailRemovedFromUserId = attached.detachedFrom;
      }
    } else {
      const created = await this.users.attachProvenEmail({ newCustomerMobile: normalized }, signup.email);
      user = created.user;
      detail.linked = 'new_account';
      if (created.detachedFrom !== null) detail.emailRemovedFromUserId = created.detachedFrom;
    }

    await this.otp.clear(normalized);
    await this.redis.client.del(key);
    return this.signIn(user, context, detail);
  }

  // ─── internals ────────────────────────────────────────────────────────────

  private async signIn(user: PublicUser, context: RequestContext, detail: Record<string, unknown>): Promise<AuthTokensResponseDto> {
    await this.assertMayUseEmail(user, context);
    return this.auth.completeExternalLogin(user, 'email_otp', context, detail);
  }

  private async assertMayUseEmail(user: PublicUser, context: RequestContext): Promise<void> {
    if (!EMAIL_ROLES.includes(user.role)) {
      await this.auth.recordRefusedExternalLogin(user.id, 'email_otp_staff_account', context);
      this.logger.warn(`E-mail code sign-in refused for staff account ${user.id} (role ${user.role})`);
      throw emailError(HttpStatus.FORBIDDEN, 'EMAIL_OTP_STAFF_NOT_ALLOWED', 'Staff accounts sign in with their password.');
    }
  }

  private async loadSignup(ticket: unknown): Promise<{ signup: StoredSignup; key: string }> {
    if (typeof ticket !== 'string' || !TICKET_PATTERN.test(ticket)) {
      throw emailError(HttpStatus.UNAUTHORIZED, 'EMAIL_OTP_SIGNUP_EXPIRED', 'This step has expired. Request a new e-mail code.');
    }
    const key = EmailOtpKeys.signup(ticket);
    const raw = await this.redis.client.get(key);
    let signup: StoredSignup | null = null;
    try {
      signup = raw === null ? null : (JSON.parse(raw) as StoredSignup);
    } catch {
      signup = null;
    }
    if (signup === null || typeof signup.email !== 'string') {
      throw emailError(HttpStatus.UNAUTHORIZED, 'EMAIL_OTP_SIGNUP_EXPIRED', 'This step has expired. Request a new e-mail code.');
    }
    return { signup, key };
  }

  private normalize(raw: string): string {
    const email = normalizeEmail(raw);
    if (email === null) {
      throw emailError(HttpStatus.BAD_REQUEST, 'EMAIL_INVALID', 'Invalid e-mail address.');
    }
    return email;
  }

  private assertEnabled(): void {
    if (!this.email.enabled) {
      throw emailError(HttpStatus.SERVICE_UNAVAILABLE, 'EMAIL_NOT_CONFIGURED', 'Sign-in by e-mail is not enabled on this server.');
    }
  }
}

