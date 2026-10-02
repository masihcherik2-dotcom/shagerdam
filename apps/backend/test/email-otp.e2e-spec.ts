import { ConfigService } from '@nestjs/config';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { UserRole } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { GLOBAL_API_PREFIX } from '../src/common/constants';
import { PrismaService } from '../src/infra/prisma/prisma.service';
import { RedisService } from '../src/infra/redis/redis.service';
import { EMAIL_SIGNUP_TICKET_HEADER } from '../src/modules/auth/email-otp/email-otp.dto';
import { EmailOtpKeys } from '../src/modules/auth/email-otp/email-otp.service';
import { OtpKeys, emailOtpSubject } from '../src/modules/auth/otp.service';
import { MAIL_PROVIDER, MailDeliveryError, type MailProvider } from '../src/modules/mail/mail-provider.interface';
import type { SandboxMailProvider } from '../src/modules/mail/providers/sandbox-mail.provider';
import { SMS_PROVIDER, type SmsProvider } from '../src/modules/sms/sms-provider.interface';
import type { SandboxSmsProvider } from '../src/modules/sms/providers/sandbox-sms.provider';
import { applyGlobalPolicies } from '../src/setup/app.setup';

/**
 * Sign-in / sign-up with a code sent by e-mail, end to end against the real
 * stack (PostgreSQL, Redis, OTP limits, token service, audit). Mail goes through
 * the sandbox mail provider (MAIL_PROVIDER=sandbox in test), whose in-memory
 * outbox is where the "user" reads the code; SMS through the sandbox SMS provider.
 * The SMTP provider itself is covered against a real SMTP server in
 * `src/modules/mail/mail.spec.ts`.
 */

const RUN = Date.now().toString(36);
const TEST_UA = `email-otp-e2e/${RUN}`;

const MOBILES = {
  newUser: '+989127771001',
  existing: '+989127771002',
  profileOwner: '+989127771003',
  claimant: '+989127771004',
  admin: '+989127771005',
  adminUnverified: '+989127771006',
  verifiedOther: '+989127771007',
  selfConfirm: '+989127771008',
  fresh: '+989127771009',
};
const SUITE_MOBILES = Object.values(MOBILES);
const EMAILS = {
  newUser: `e-new-${RUN}@gmail.com`,
  existing: `e-existing-${RUN}@gmail.com`,
  profileOwner: `e-profile-${RUN}@gmail.com`,
  admin: `e-admin-${RUN}@shagerdam.ir`,
  adminUnverified: `e-admin-unv-${RUN}@shagerdam.ir`,
  verifiedOther: `e-verified-${RUN}@gmail.com`,
  stranger: `e-stranger-${RUN}@gmail.com`,
  selfConfirm: `e-self-${RUN}@gmail.com`,
  changed: `e-changed-${RUN}@gmail.com`,
  failing: `e-failing-${RUN}@gmail.com`,
  otherClaim: `e-other-claim-${RUN}@gmail.com`,
  adminBind: `e-admin-bind-${RUN}@gmail.com`,
};
const SUITE_EMAILS = Object.values(EMAILS);

type ErrorBody = { statusCode: number; code?: string; message: string };
type Tokens = { accessToken: string; refreshToken: string; user: { id: string; role: string; mobile: string; email: string | null; fullName: string } };
type Verify = { status: 'signed_in' | 'mobile_required'; tokens?: Tokens; ticket?: string; expiresInSeconds?: number; email?: string };

describe('Sign-in with an e-mailed code (live stack, sandbox mail + SMS)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let redis: RedisService;
  const API = `/${GLOBAL_API_PREFIX}`;

  const request = async <T>(url: string, options: { method?: 'GET' | 'POST' | 'PATCH'; body?: unknown; ticket?: string; token?: string } = {}): Promise<{ status: number; body: T }> => {
    const headers: Record<string, string> = { 'user-agent': TEST_UA };
    if (options.ticket !== undefined) headers[EMAIL_SIGNUP_TICKET_HEADER] = options.ticket;
    if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    const response = await app.inject({ method: options.method ?? 'GET', url: `${API}${url}`, headers, ...(options.body === undefined ? {} : { payload: JSON.stringify(options.body) }) });
    return { status: response.statusCode, body: response.body.length > 0 ? (JSON.parse(response.body) as T) : (undefined as T) };
  };

  const mail = (): SandboxMailProvider => app.get<MailProvider>(MAIL_PROVIDER) as SandboxMailProvider;
  const mailedCode = (email: string): string => mail().latestCode(email) ?? '';
  const smsCode = (mobile: string): string => (app.get<SmsProvider>(SMS_PROVIDER) as SandboxSmsProvider).latestOtpCode(mobile) ?? '';

  /** Request a code for the address and type it in, like the user would. */
  /** Every scenario stands for a different visitor: the shared per-IP hourly cap (20) is not what is under test here. */
  const freshVisitor = async (): Promise<void> => {
    const keys = await redis.client.keys('auth:otp:hourly:ip:*');
    if (keys.length > 0) await redis.client.del(...keys);
  };

  const signInWithEmail = async (email: string): Promise<{ status: number; body: Verify & ErrorBody }> => {
    await freshVisitor();
    await redis.client.del(OtpKeys.cooldown(emailOtpSubject(email.trim().toLowerCase()))); // stands in for waiting out the 120 s cooldown
    const sent = await request<{ status: string }>('/auth/email-otp/request', { method: 'POST', body: { email } });
    expect(sent.status).toBe(200);
    return request('/auth/email-otp/verify', { method: 'POST', body: { email, code: mailedCode(email.trim().toLowerCase()) } });
  };

  const bindMobile = async (ticket: string, mobile: string): Promise<{ status: number; body: Tokens & ErrorBody }> => {
    await freshVisitor();
    await redis.client.del(OtpKeys.cooldown(mobile));
    await new Promise((resolve) => setTimeout(resolve, 250)); // the sandbox SMS provider throttles itself to 5/s
    const sent = await request<{ status: string }>('/auth/email-otp/signup/otp', { method: 'POST', ticket, body: { mobile } });
    expect(sent.status).toBe(200);
    return request('/auth/email-otp/signup/verify', { method: 'POST', ticket, body: { mobile, code: smsCode(mobile) } });
  };

  const lastLogin = async (userId: string): Promise<Record<string, unknown> | undefined> =>
    (await prisma.auditLog.findFirst({ where: { userId, action: 'LOGIN' }, orderBy: { createdAt: 'desc' } }))?.newValue as Record<string, unknown> | undefined;

  async function resetKeys(): Promise<void> {
    const subjects = SUITE_EMAILS.map((email) => emailOtpSubject(email));
    const keys = [
      ...(await redis.client.keys('auth:otp:hourly:ip:*')),
      ...[...SUITE_MOBILES, ...subjects].flatMap((id) => [OtpKeys.challenge(id), OtpKeys.lock(id), OtpKeys.cooldown(id), OtpKeys.hourlyByMobile(id)]),
      ...subjects.map((subject) => OtpKeys.hourlyByEmail(subject)),
    ];
    if (keys.length > 0) await redis.client.del(...keys);
  }

  async function cleanup(): Promise<void> {
    const users = await prisma.user.findMany({ where: { OR: [{ mobile: { in: SUITE_MOBILES } }, { email: { in: SUITE_EMAILS } }] }, select: { id: true } });
    const ids = users.map((user) => user.id);
    await prisma.auditLog.deleteMany({ where: { OR: [{ userId: { in: ids } }, { userAgent: TEST_UA }] } });
    await prisma.customerProfile.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    applyGlobalPolicies(app, app.get(ConfigService));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = app.get(PrismaService);
    redis = app.get(RedisService);
    await cleanup();
    await resetKeys();

    const verifiedAt = new Date();
    await prisma.user.create({ data: { mobile: MOBILES.existing, fullName: 'مشتری قدیمی', role: UserRole.CUSTOMER, customerProfile: { create: {} } } });
    // E-mail typed into the profile, never proven.
    await prisma.user.create({ data: { mobile: MOBILES.profileOwner, email: EMAILS.profileOwner, fullName: 'ایمیل تأییدنشده', role: UserRole.CUSTOMER, customerProfile: { create: {} } } });
    await prisma.user.create({ data: { mobile: MOBILES.selfConfirm, email: EMAILS.selfConfirm, fullName: 'تأیید توسط خودش', role: UserRole.VENDOR } });
    await prisma.user.create({ data: { mobile: MOBILES.admin, email: EMAILS.admin, emailVerifiedAt: verifiedAt, fullName: 'ادمین آزمون', role: UserRole.ADMIN } });
    await prisma.user.create({ data: { mobile: MOBILES.adminUnverified, email: EMAILS.adminUnverified, fullName: 'پشتیبان آزمون', role: UserRole.SUPPORT } });
    await prisma.user.create({ data: { mobile: MOBILES.verifiedOther, email: EMAILS.verifiedOther, emailVerifiedAt: verifiedAt, fullName: 'ایمیل تأییدشده', role: UserRole.CUSTOMER, customerProfile: { create: {} } } });
  }, 120_000);

  afterAll(async () => {
    jest.restoreAllMocks();
    if (prisma !== undefined) {
      await cleanup();
      await resetKeys();
    }
    await app?.close();
  });

  describe('request', () => {
    it('reports that e-mail sign-in is on, through the test provider', async () => {
      expect((await request('/auth/email-otp/status')).body).toEqual({ enabled: true, isTestProvider: true });
    });

    it('rejects malformed addresses', async () => {
      const response = await request<ErrorBody>('/auth/email-otp/request', { method: 'POST', body: { email: 'not-an-email' } });
      expect(response.status).toBe(400);
    });

    it('sends a code to any valid address without revealing whether it has an account, then enforces the cooldown', async () => {
      const sent = await request<{ status: string; expiresInSeconds: number; trackingId: string }>('/auth/email-otp/request', { method: 'POST', body: { email: `  E-Stranger-${RUN}@Gmail.com ` } });
      expect(sent.status).toBe(200);
      expect(sent.body).toMatchObject({ status: 'sent', expiresInSeconds: 120 });
      expect(sent.body.trackingId).toMatch(/^MAIL-SBX-/);
      const delivered = mail().recent(1, EMAILS.stranger)[0];
      expect(delivered?.subject).toBe('کد ورود به شاگردم');
      expect(mailedCode(EMAILS.stranger)).toMatch(/^\d{5}$/);
      // Only a hash of the address is used in Redis keys.
      expect(await redis.client.exists(OtpKeys.challenge(emailOtpSubject(EMAILS.stranger)))).toBe(1);
      expect((await redis.client.keys(`*${EMAILS.stranger}*`)).length).toBe(0);

      const again = await request<ErrorBody>('/auth/email-otp/request', { method: 'POST', body: { email: EMAILS.stranger } });
      expect(again.status).toBe(429);

      const known = await request<{ status: string }>('/auth/email-otp/request', { method: 'POST', body: { email: EMAILS.verifiedOther } });
      expect(Object.keys(known.body).sort()).toEqual(Object.keys(sent.body).sort());
    });

    it('releases the cooldown when the mail server fails, so the user can retry at once', async () => {
      const spy = jest.spyOn(mail(), 'send').mockRejectedValueOnce(new MailDeliveryError('sandbox', 'unavailable', 'connection refused'));
      const failed = await request<ErrorBody>('/auth/email-otp/request', { method: 'POST', body: { email: EMAILS.failing } });
      expect(failed.status).toBe(502);
      expect(failed.body.code).toBe('EMAIL_DELIVERY_FAILED');
      expect(await redis.client.exists(OtpKeys.cooldown(emailOtpSubject(EMAILS.failing)))).toBe(0);
      spy.mockRestore();
      const retried = await request<{ status: string }>('/auth/email-otp/request', { method: 'POST', body: { email: EMAILS.failing } });
      expect(retried.status).toBe(200);
    });
  });

  describe('new account', () => {
    let ticket = '';

    it('refuses a wrong code and asks for a mobile number after the right one', async () => {
      await request('/auth/email-otp/request', { method: 'POST', body: { email: EMAILS.newUser } });
      const code = mailedCode(EMAILS.newUser);
      const wrong = await request<ErrorBody>('/auth/email-otp/verify', { method: 'POST', body: { email: EMAILS.newUser, code: code === '00000' ? '11111' : '00000' } });
      expect(wrong.status).toBe(401);

      const verified = await request<Verify>('/auth/email-otp/verify', { method: 'POST', body: { email: EMAILS.newUser, code } });
      expect(verified.status).toBe(200);
      expect(verified.body).toMatchObject({ status: 'mobile_required', email: EMAILS.newUser, expiresInSeconds: 900 });
      ticket = verified.body.ticket ?? '';
      expect(ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(await redis.client.ttl(EmailOtpKeys.signup(ticket))).toBeGreaterThan(890);

      // The e-mail code is single use.
      const replay = await request<ErrorBody>('/auth/email-otp/verify', { method: 'POST', body: { email: EMAILS.newUser, code } });
      expect(replay.status).toBe(401);
    });

    it('rejects missing or unknown tickets', async () => {
      expect((await request<ErrorBody>('/auth/email-otp/signup')).body.code).toBe('EMAIL_OTP_SIGNUP_EXPIRED');
      const unknown = await request<ErrorBody>('/auth/email-otp/signup', { ticket: 'x'.repeat(43) });
      expect(unknown.status).toBe(401);
      expect(unknown.body.code).toBe('EMAIL_OTP_SIGNUP_EXPIRED');
    });

    it('binds the ticket to the mobile that received the SMS code', async () => {
      expect((await request('/auth/email-otp/signup', { ticket })).body).toMatchObject({ email: EMAILS.newUser, mobile: null });
      const early = await request<ErrorBody>('/auth/email-otp/signup/verify', { method: 'POST', ticket, body: { mobile: MOBILES.newUser, code: '12345' } });
      expect(early.body.code).toBe('EMAIL_OTP_SIGNUP_MOBILE_MISMATCH');

      expect((await request('/auth/email-otp/signup/otp', { method: 'POST', ticket, body: { mobile: '09127771001' } })).status).toBe(200);
      expect((await request('/auth/email-otp/signup', { ticket })).body).toMatchObject({ mobile: MOBILES.newUser });
      const other = await request<ErrorBody>('/auth/email-otp/signup/verify', { method: 'POST', ticket, body: { mobile: MOBILES.claimant, code: smsCode(MOBILES.newUser) } });
      expect(other.status).toBe(400);
      expect(other.body.code).toBe('EMAIL_OTP_SIGNUP_MOBILE_MISMATCH');
    });

    it('creates a customer with the proven e-mail and signs in', async () => {
      const verified = await request<Tokens>('/auth/email-otp/signup/verify', { method: 'POST', ticket, body: { mobile: MOBILES.newUser, code: smsCode(MOBILES.newUser) } });
      expect(verified.status).toBe(200);
      expect(verified.body.user).toMatchObject({ role: 'CUSTOMER', mobile: MOBILES.newUser, email: EMAILS.newUser, fullName: 'کاربر 09127771001' });
      expect((await request('/auth/me', { token: verified.body.accessToken })).status).toBe(200);

      const row = await prisma.user.findUniqueOrThrow({ where: { mobile: MOBILES.newUser }, include: { customerProfile: true } });
      expect(row.emailVerifiedAt).not.toBeNull();
      expect(row.customerProfile).not.toBeNull();
      expect(await redis.client.exists(EmailOtpKeys.signup(ticket))).toBe(0);
      expect(await lastLogin(row.id)).toMatchObject({ success: true, method: 'email_otp', linked: 'new_account' });
    });

    it('signs the same address in directly next time (address matched case-insensitively)', async () => {
      const again = await signInWithEmail(EMAILS.newUser.toUpperCase());
      expect(again.status).toBe(200);
      expect(again.body.status).toBe('signed_in');
      expect(again.body.tokens?.user.mobile).toBe(MOBILES.newUser);
      expect(await lastLogin(again.body.tokens?.user.id ?? '')).toMatchObject({ method: 'email_otp', linked: 'verified_email' });
    });

    it('changing the e-mail in the profile drops its verified status', async () => {
      const session = await signInWithEmail(EMAILS.newUser);
      const updated = await request('/auth/profile', { method: 'PATCH', token: session.body.tokens?.accessToken, body: { email: EMAILS.changed } });
      expect(updated.status).toBe(200);
      expect((await prisma.user.findUniqueOrThrow({ where: { mobile: MOBILES.newUser } })).emailVerifiedAt).toBeNull();
      // The new address is not trusted for sign-in until proven together with the mobile.
      const viaNew = await signInWithEmail(EMAILS.changed);
      expect(viaNew.body.status).toBe('mobile_required');
      const bound = await bindMobile(viaNew.body.ticket ?? '', MOBILES.newUser);
      expect(bound.status).toBe(200);
      expect(await lastLogin(bound.body.user.id)).toMatchObject({ linked: 'confirmed_email' });
      expect((await prisma.user.findUniqueOrThrow({ where: { mobile: MOBILES.newUser } })).emailVerifiedAt).not.toBeNull();
    });
  });

  describe('existing accounts', () => {
    it('attaches the e-mail to the existing account of the verified mobile (no duplicate)', async () => {
      const before = await prisma.user.findUniqueOrThrow({ where: { mobile: MOBILES.existing } });
      const response = await signInWithEmail(EMAILS.existing);
      expect(response.body.status).toBe('mobile_required');
      const bound = await bindMobile(response.body.ticket ?? '', MOBILES.existing);
      expect(bound.status).toBe(200);
      expect(bound.body.user.id).toBe(before.id);
      const after = await prisma.user.findUniqueOrThrow({ where: { id: before.id } });
      expect(after).toMatchObject({ email: EMAILS.existing, fullName: 'مشتری قدیمی' });
      expect(after.emailVerifiedAt).not.toBeNull();
      expect(await prisma.user.count({ where: { mobile: MOBILES.existing } })).toBe(1);
      expect(await lastLogin(before.id)).toMatchObject({ linked: 'verified_mobile' });
    });

    it('lets the owner of an unverified profile e-mail confirm it with their own mobile (vendor accounts too)', async () => {
      const owner = await prisma.user.findUniqueOrThrow({ where: { mobile: MOBILES.selfConfirm } });
      const response = await signInWithEmail(EMAILS.selfConfirm);
      expect(response.body.status).toBe('mobile_required');
      const bound = await bindMobile(response.body.ticket ?? '', MOBILES.selfConfirm);
      expect(bound.status).toBe(200);
      expect(bound.body.user).toMatchObject({ id: owner.id, role: 'VENDOR' });
      expect((await prisma.user.findUniqueOrThrow({ where: { id: owner.id } })).emailVerifiedAt).not.toBeNull();
    });

    it('never signs into an account through an e-mail that was only typed into its profile', async () => {
      const victim = await prisma.user.findUniqueOrThrow({ where: { mobile: MOBILES.profileOwner } });
      const response = await signInWithEmail(EMAILS.profileOwner);
      expect(response.status).toBe(200);
      expect(response.body.status).toBe('mobile_required');
      expect(response.body.tokens).toBeUndefined();

      // Whoever proves the mailbox (and a mobile of their own) gets the address; the unproven copy is removed.
      const bound = await bindMobile(response.body.ticket ?? '', MOBILES.claimant);
      expect(bound.status).toBe(200);
      expect(bound.body.user.id).not.toBe(victim.id);
      expect(bound.body.user.email).toBe(EMAILS.profileOwner);
      expect(await prisma.user.findUniqueOrThrow({ where: { id: victim.id } })).toMatchObject({ email: null, emailVerifiedAt: null });
      expect(await lastLogin(bound.body.user.id)).toMatchObject({ linked: 'new_account', emailRemovedFromUserId: victim.id });
    });

    it('refuses to bind a mobile whose account already has another verified e-mail', async () => {
      const response = await signInWithEmail(EMAILS.otherClaim);
      expect(response.body.status).toBe('mobile_required');
      const bound = await bindMobile(response.body.ticket ?? '', MOBILES.verifiedOther);
      expect(bound.status).toBe(409);
      expect(bound.body.code).toBe('EMAIL_OTP_MOBILE_HAS_OTHER_EMAIL');
      expect((await prisma.user.findUniqueOrThrow({ where: { mobile: MOBILES.verifiedOther } })).email).toBe(EMAILS.verifiedOther);
    });
  });

  describe('staff accounts', () => {
    it('refuses e-mail sign-in for staff, even with a verified address', async () => {
      const admin = await prisma.user.findUniqueOrThrow({ where: { mobile: MOBILES.admin } });
      const response = await signInWithEmail(EMAILS.admin);
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('EMAIL_OTP_STAFF_NOT_ALLOWED');
      expect(await lastLogin(admin.id)).toMatchObject({ success: false });
    });

    it('refuses binding a staff mobile', async () => {
      const response = await signInWithEmail(EMAILS.adminBind);
      expect(response.body.status).toBe('mobile_required');
      const bound = await bindMobile(response.body.ticket ?? '', MOBILES.admin);
      expect(bound.status).toBe(403);
      expect(bound.body.code).toBe('EMAIL_OTP_STAFF_NOT_ALLOWED');
      expect((await prisma.user.findUniqueOrThrow({ where: { mobile: MOBILES.admin } })).email).toBe(EMAILS.admin);
    });

    it('never moves an e-mail away from a staff account, verified or not', async () => {
      const response = await signInWithEmail(EMAILS.adminUnverified);
      expect(response.body.status).toBe('mobile_required');
      const bound = await bindMobile(response.body.ticket ?? '', MOBILES.fresh);
      expect(bound.status).toBe(409);
      expect(bound.body.code).toBe('EMAIL_OTP_EMAIL_TAKEN');
      expect((await prisma.user.findUniqueOrThrow({ where: { mobile: MOBILES.adminUnverified } })).email).toBe(EMAILS.adminUnverified);
      expect(await prisma.user.count({ where: { mobile: MOBILES.fresh } })).toBe(0); // the whole transaction rolled back
    });
  });
});
