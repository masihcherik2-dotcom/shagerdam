import { ConfigService } from '@nestjs/config';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { AuditAction, type ConfigValueType } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { GLOBAL_API_PREFIX } from '../src/common/constants';
import { PrismaService } from '../src/infra/prisma/prisma.service';
import { RedisService } from '../src/infra/redis/redis.service';
import { normalizeIdentifier } from '../src/modules/auth/auth.service';
import { OtpKeys } from '../src/modules/auth/otp.service';
import { loginAttemptsKey, loginLockKey } from '../src/modules/auth/token.service';
import { SITE_INFO_CACHE_KEY, SITE_INFO_KEY_LIST } from '../src/modules/site-info/site-info-rules';
import { SMS_PROVIDER, type SmsProvider } from '../src/modules/sms/sms-provider.interface';
import type { SandboxSmsProvider } from '../src/modules/sms/providers/sandbox-sms.provider';
import { applyGlobalPolicies, buildOpenApiDocument } from '../src/setup/app.setup';

/**
 * Phase 0 trust layer against the live stack (PostgreSQL + Redis):
 * public status (no infrastructure leakage), business identity
 * (`system_configs`, cache purge, audit) and the contact form (storage, rate
 * limits, honeypot, support queue). Existing site-info rows are snapshotted
 * and restored; every message, user, audit row and Redis key the suite
 * creates is removed.
 */

const TEST_UA = 'shopino-trust-layer-e2e/1.0';
const CUSTOMER_MOBILE = '+989971142001';
const SEEDED_ADMIN_EMAIL = 'admin@shopino.local';
/** Contact-form senders used by this suite (all removed afterwards). */
const SENDER_MOBILES = ['09971142101', '09971142102', '09971142103', '09971142104', '09971142105', '09971142106', '09971142107'];
const SENDER_E164 = [...SENDER_MOBILES.map((mobile) => `+98${mobile.slice(1)}`), CUSTOMER_MOBILE];

interface HttpResult<T> {
  status: number;
  body: T;
  headers: Record<string, string | string[] | number | undefined>;
}
interface ErrorBody {
  code?: string;
  field?: string;
  message?: string | string[];
  retryAfterSeconds?: number;
}
type SiteInfo = Record<string, string | null>;
interface AdminSiteInfo extends SiteInfo {}
interface Receipt {
  id: string;
  reference: string;
  createdAt: string;
}
interface AdminMessage {
  id: string;
  reference: string;
  fullName: string;
  mobile: string;
  email: string | null;
  topic: string;
  subject: string;
  message: string;
  status: string;
  staffNote: string | null;
  sender: { id: string; fullName: string } | null;
  handledBy: { id: string; fullName: string } | null;
}
interface MessagePage {
  items: AdminMessage[];
  total: number;
  counts: Record<string, number>;
}

describe('Trust layer — public status, business identity, contact form (live stack)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let redis: RedisService;
  let adminToken: string;
  let adminId: string;
  let customerToken: string;
  let customerId: string;
  let snapshot: Array<{ key: string; value: string; valueType: ConfigValueType; description: string | null }> = [];

  const API = `/${GLOBAL_API_PREFIX}`;

  const request = async <T>(url: string, options: { method?: 'GET' | 'POST' | 'PATCH'; token?: string; body?: unknown; ip?: string } = {}): Promise<HttpResult<T>> => {
    const headers: Record<string, string> = { 'user-agent': TEST_UA };
    if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
    if (options.ip !== undefined) headers['x-forwarded-for'] = options.ip;
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    const response = await app.inject({
      method: options.method ?? 'GET',
      url: `${API}${url}`,
      headers,
      ...(options.body === undefined ? {} : { payload: JSON.stringify(options.body) }),
    });
    const isJson = String(response.headers['content-type'] ?? '').includes('json');
    return { status: response.statusCode, body: isJson && response.body.length > 0 ? (JSON.parse(response.body) as T) : (undefined as T), headers: response.headers };
  };

  const contact = (body: Record<string, unknown>, options: { token?: string; ip?: string } = {}): Promise<HttpResult<Receipt & ErrorBody>> =>
    request('/support/contact-messages', { method: 'POST', body, ...options });
  const validMessage = (mobile: string): Record<string, unknown> => ({
    fullName: 'آزمون اعتماد',
    mobile,
    email: 'Trust.E2E@Example.com',
    topic: 'ORDER',
    subject: 'پیگیری سفارش',
    message: 'سلام، سفارش من هنوز ارسال نشده است. لطفاً پیگیری کنید.',
  });

  async function resetKeys(): Promise<void> {
    await redis.client.del(
      SITE_INFO_CACHE_KEY,
      OtpKeys.challenge(CUSTOMER_MOBILE),
      OtpKeys.lock(CUSTOMER_MOBILE),
      OtpKeys.cooldown(CUSTOMER_MOBILE),
      OtpKeys.hourlyByMobile(CUSTOMER_MOBILE),
      loginAttemptsKey(normalizeIdentifier(SEEDED_ADMIN_EMAIL)),
      loginLockKey(normalizeIdentifier(SEEDED_ADMIN_EMAIL)),
    );
    const keys = [...(await redis.client.keys('auth:otp:hourly:ip:*')), ...(await redis.client.keys('support:contact:*'))];
    if (keys.length > 0) await redis.client.del(...keys);
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    applyGlobalPolicies(app, app.get(ConfigService));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = app.get(PrismaService);
    redis = app.get(RedisService);

    snapshot = await prisma.systemConfig.findMany({ where: { key: { in: SITE_INFO_KEY_LIST } }, select: { key: true, value: true, valueType: true, description: true } });
    await prisma.systemConfig.deleteMany({ where: { key: { in: SITE_INFO_KEY_LIST } } });
    await prisma.contactMessage.deleteMany({ where: { mobile: { in: SENDER_E164 } } });
    await resetKeys();

    const adminPassword = process.env['SUPER_ADMIN_PASSWORD'];
    if (adminPassword === undefined) throw new Error('This suite needs SUPER_ADMIN_PASSWORD from the root .env.');
    const admin = await request<{ accessToken: string; user: { id: string } }>('/auth/login/password', { method: 'POST', body: { identifier: SEEDED_ADMIN_EMAIL, password: adminPassword } });
    expect(admin.status).toBe(200);
    adminToken = admin.body.accessToken;
    adminId = admin.body.user.id;

    expect((await request('/auth/otp/request', { method: 'POST', body: { mobile: CUSTOMER_MOBILE } })).status).toBe(200);
    const code = (app.get<SmsProvider>(SMS_PROVIDER) as SandboxSmsProvider).latestOtpCode(CUSTOMER_MOBILE);
    const verified = await request<{ accessToken: string; user: { id: string } }>('/auth/otp/verify', { method: 'POST', body: { mobile: CUSTOMER_MOBILE, code } });
    expect(verified.status).toBe(200);
    customerToken = verified.body.accessToken;
    customerId = verified.body.user.id;
  }, 120_000);

  afterAll(async () => {
    if (prisma !== undefined) {
      await prisma.systemConfig.deleteMany({ where: { key: { in: SITE_INFO_KEY_LIST } } });
      for (const row of snapshot) await prisma.systemConfig.create({ data: row });
      await prisma.contactMessage.deleteMany({ where: { mobile: { in: SENDER_E164 } } });
      await prisma.auditLog.deleteMany({ where: { OR: [{ userAgent: TEST_UA }, ...(customerId ? [{ userId: customerId }] : [])] } });
      if (customerId) await prisma.user.delete({ where: { id: customerId } }).catch(() => undefined);
      await resetKeys();
    }
    await app?.close();
  }, 60_000);

  // ─── Public status ─────────────────────────────────────────────────────────

  describe('GET /health/status', () => {
    it('reports business capabilities only, never infrastructure details', async () => {
      const response = await request<{ status: string; checkedAt: string; modules: Array<{ key: string; status: string }> }>('/health/status');
      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toBe('public, max-age=10');
      expect(response.body.status).toBe('operational');
      expect(response.body.modules).toEqual([
        { key: 'storefront', status: 'operational' },
        { key: 'orders', status: 'operational' },
        { key: 'payments', status: 'operational' },
        { key: 'bnpl', status: 'operational' },
        { key: 'auth', status: 'operational' },
      ]);
      expect(Object.keys(response.body).sort()).toEqual(['checkedAt', 'modules', 'status']);
      expect(JSON.stringify(response.body)).not.toMatch(/database|redis|postgres|memory|heap|uptime|latency|started_at|\d+\.\d+\.\d+\.\d+/i);
    });

    it('is memoised: repeated calls inside the window return the same check', async () => {
      const first = await request<{ checkedAt: string }>('/health/status');
      const second = await request<{ checkedAt: string }>('/health/status');
      expect(second.body.checkedAt).toBe(first.body.checkedAt);
    });

    it('is documented in the OpenAPI contract next to the operator probe', () => {
      const paths = Object.keys(buildOpenApiDocument(app).paths);
      expect(paths).toEqual(expect.arrayContaining([`${API}/health`, `${API}/health/status`, `${API}/site-info`, `${API}/admin/site-info`, `${API}/support/contact-messages`, `${API}/admin/support/contact-messages`]));
    });
  });

  // ─── Business identity ────────────────────────────────────────────────────

  describe('site info', () => {
    it('starts empty: every public field is null', async () => {
      const response = await request<SiteInfo>('/site-info');
      expect(response.status).toBe(200);
      expect(Object.values(response.body).every((value) => value === null)).toBe(true);
      expect(Object.keys(response.body)).toHaveLength(12);
    });

    it('is managed by admins only', async () => {
      expect((await request('/admin/site-info')).status).toBe(401);
      expect((await request('/admin/site-info', { token: customerToken })).status).toBe(403);
      expect((await request('/admin/site-info', { method: 'PATCH', token: customerToken, body: { legalName: 'x' } })).status).toBe(403);
    });

    it('validates formats and seal hosts', async () => {
      const cases: Array<[Record<string, string>, string]> = [
        [{ nationalId: '123' }, 'nationalId'],
        [{ postalCode: '12345' }, 'postalCode'],
        [{ supportPhone: 'call me' }, 'supportPhone'],
        [{ supportEmail: 'nope' }, 'supportEmail'],
        [{ enamadImageUrl: 'https://evil.example/logo.aspx?id=1' }, 'enamadImageUrl'],
        [{ officeAddress: 'تهران <b>' }, 'officeAddress'],
      ];
      for (const [body, field] of cases) {
        const response = await request<ErrorBody>('/admin/site-info', { method: 'PATCH', token: adminToken, body });
        expect(response.status).toBe(400);
        expect(response.body.code).toBe('SITE_INFO_INVALID_FIELD');
        expect(response.body.field).toBe(field);
      }
      expect((await request('/admin/site-info', { method: 'PATCH', token: adminToken, body: { unknownField: 'x' } })).status).toBe(400);
    });

    it('saves normalised values, audits the change and purges the public cache', async () => {
      // Warm the cache with the empty state first.
      expect((await request<SiteInfo>('/site-info')).body.supportPhone).toBeNull();

      const response = await request<AdminSiteInfo & { auditLogId: string; updatedAt: Record<string, string | null>; history: Array<{ changedFields: string[] }> }>('/admin/site-info', {
        method: 'PATCH',
        token: adminToken,
        body: {
          legalName: 'شرکت آزمون اعتماد',
          nationalId: '۱۴۰۰۹۸۷۶۵۴۳',
          supportPhone: '۰۲۱-۹۱۰۰۰۰۰۰',
          supportEmail: 'Support@Shagerdam.IR',
          officeAddress: 'تهران،   خیابان آزمون',
          workingHours: 'شنبه تا چهارشنبه ۹ تا ۱۷',
          enamadLinkUrl: 'https://trustseal.enamad.ir/?id=123456&Code=TrustE2E',
        },
      });
      expect(response.status).toBe(200);
      expect(response.body.nationalId).toBe('14009876543');
      expect(response.body.supportPhone).toBe('021-91000000');
      expect(response.body.supportEmail).toBe('support@shagerdam.ir');
      expect(response.body.officeAddress).toBe('تهران، خیابان آزمون');
      expect(response.body.updatedAt['supportPhone']).not.toBeNull();
      expect(response.body.history[0]?.changedFields).toEqual(expect.arrayContaining(['legalName', 'nationalId', 'supportPhone']));

      const audit = await prisma.auditLog.findUnique({ where: { id: response.body.auditLogId } });
      expect(audit).toMatchObject({ userId: adminId, action: AuditAction.UPDATE, entityName: 'SiteInfo' });

      const published = await request<SiteInfo>('/site-info');
      expect(published.body.supportPhone).toBe('021-91000000');
      expect(published.body.legalName).toBe('شرکت آزمون اعتماد');
      // Seal link without its image is not published.
      expect(published.body.enamadLinkUrl).toBeNull();
    });

    it('publishes a seal once both URLs are set, and clears fields with null', async () => {
      await request('/admin/site-info', { method: 'PATCH', token: adminToken, body: { enamadImageUrl: 'https://trustseal.enamad.ir/logo.aspx?id=123456&Code=TrustE2E' } });
      let published = await request<SiteInfo>('/site-info');
      expect(published.body.enamadLinkUrl).toBe('https://trustseal.enamad.ir/?id=123456&Code=TrustE2E');
      expect(published.body.enamadImageUrl).toBe('https://trustseal.enamad.ir/logo.aspx?id=123456&Code=TrustE2E');

      await request('/admin/site-info', { method: 'PATCH', token: adminToken, body: { enamadImageUrl: null, workingHours: '' } });
      published = await request<SiteInfo>('/site-info');
      expect(published.body.enamadLinkUrl).toBeNull();
      expect(published.body.workingHours).toBeNull();
    });
  });

  // ─── Contact form ─────────────────────────────────────────────────────────

  describe('contact form', () => {
    it('stores an anonymous message with a reference code', async () => {
      const response = await contact(validMessage(SENDER_MOBILES[0]!), { ip: '198.51.100.10' });
      expect(response.status).toBe(201);
      expect(response.body.reference).toMatch(/^C-[0-9A-F]{8}$/);
      const row = await prisma.contactMessage.findUnique({ where: { id: response.body.id } });
      expect(row).toMatchObject({ mobile: '+989971142101', email: 'trust.e2e@example.com', topic: 'ORDER', status: 'NEW', userId: null, ipAddress: '198.51.100.10' });
    });

    it('links the message to a signed-in sender', async () => {
      const response = await contact({ ...validMessage(SENDER_MOBILES[1]!), topic: 'BNPL' }, { token: customerToken, ip: '198.51.100.11' });
      expect(response.status).toBe(201);
      const row = await prisma.contactMessage.findUnique({ where: { id: response.body.id } });
      expect(row?.userId).toBe(customerId);
    });

    it('cleans the text before storage', async () => {
      const response = await contact(
        { ...validMessage(SENDER_MOBILES[2]!), fullName: '  =علی\u0000   رضایی ', subject: '@پیگیری', message: 'خط اول\r\n\r\n\r\n\r\nخط دوم کافی است\u0007' },
        { ip: '198.51.100.12' },
      );
      expect(response.status).toBe(201);
      const row = await prisma.contactMessage.findUnique({ where: { id: response.body.id } });
      expect(row).toMatchObject({ fullName: 'علی رضایی', subject: 'پیگیری', message: 'خط اول\n\nخط دوم کافی است' });
    });

    it('rejects invalid input and the honeypot without storing anything', async () => {
      const before = await prisma.contactMessage.count({ where: { mobile: { in: SENDER_E164 } } });
      const invalid: Array<Record<string, unknown>> = [
        { ...validMessage('12345'), mobile: '12345' },
        { ...validMessage(SENDER_MOBILES[3]!), topic: 'SPAM' },
        { ...validMessage(SENDER_MOBILES[3]!), message: 'کوتاه' },
        { ...validMessage(SENDER_MOBILES[3]!), message: 'x'.repeat(2001) },
        { ...validMessage(SENDER_MOBILES[3]!), email: 'not-an-email' },
        { ...validMessage(SENDER_MOBILES[3]!), extra: 'field' },
      ];
      for (const body of invalid) {
        expect((await contact(body, { ip: '198.51.100.13' })).status).toBe(400);
      }
      const honeypot = await contact({ ...validMessage(SENDER_MOBILES[3]!), website: 'https://spam.example' }, { ip: '198.51.100.13' });
      expect(honeypot.status).toBe(400);
      expect(honeypot.body.code).toBe('CONTACT_REJECTED');
      expect(await prisma.contactMessage.count({ where: { mobile: { in: SENDER_E164 } } })).toBe(before);
    });

    it('limits messages per mobile (3/h) and per IP (5/h)', async () => {
      for (let i = 0; i < 3; i += 1) {
        expect((await contact(validMessage(SENDER_MOBILES[4]!), { ip: `198.51.100.${20 + i}` })).status).toBe(201);
      }
      const perMobile = await contact(validMessage(SENDER_MOBILES[4]!), { ip: '198.51.100.30' });
      expect(perMobile.status).toBe(429);
      expect(perMobile.body.retryAfterSeconds).toBeGreaterThan(0);

      const ip = '203.0.113.50';
      const mobiles = [SENDER_MOBILES[5]!, SENDER_MOBILES[5]!, SENDER_MOBILES[5]!, SENDER_MOBILES[6]!, SENDER_MOBILES[6]!];
      for (const mobile of mobiles) {
        expect((await contact(validMessage(mobile), { ip })).status).toBe(201);
      }
      expect((await contact(validMessage(SENDER_MOBILES[6]!), { ip })).status).toBe(429);
    });

    it('support queue: admin lists with counts, filters and updates with audit; customers are refused', async () => {
      expect((await request('/admin/support/contact-messages', { token: customerToken })).status).toBe(403);
      expect((await request('/admin/support/contact-messages')).status).toBe(401);

      const page = await request<MessagePage>('/admin/support/contact-messages?status=NEW&pageSize=100', { token: adminToken });
      expect(page.status).toBe(200);
      const ours = page.body.items.filter((item) => SENDER_E164.some((mobile) => `0${mobile.slice(3)}` === item.mobile));
      expect(ours.length).toBeGreaterThanOrEqual(10);
      expect(page.body.counts['NEW']).toBeGreaterThanOrEqual(ours.length);
      const linked = ours.find((item) => item.topic === 'BNPL');
      expect(linked?.sender?.id).toBe(customerId);
      expect(linked?.mobile).toBe(SENDER_MOBILES[1]);

      const target = ours[0]!;
      const updated = await request<AdminMessage>(`/admin/support/contact-messages/${target.id}`, { method: 'PATCH', token: adminToken, body: { status: 'RESOLVED', staffNote: 'با مشتری تماس گرفته شد.' } });
      expect(updated.status).toBe(200);
      expect(updated.body).toMatchObject({ status: 'RESOLVED', staffNote: 'با مشتری تماس گرفته شد.', handledBy: { id: adminId } });
      const audit = await prisma.auditLog.findFirst({ where: { entityName: 'ContactMessage', entityId: target.id } });
      expect(audit).toMatchObject({ action: AuditAction.STATUS_CHANGE, userId: adminId, newValue: { status: 'RESOLVED', staffNoteSet: true } });

      const resolved = await request<MessagePage>('/admin/support/contact-messages?status=RESOLVED&pageSize=100', { token: adminToken });
      expect(resolved.body.items.some((item) => item.id === target.id)).toBe(true);

      expect((await request(`/admin/support/contact-messages/${target.id}`, { method: 'PATCH', token: adminToken, body: {} })).status).toBe(400);
      expect((await request('/admin/support/contact-messages/6f1c0f4e-2b7a-4c1e-9a55-2c1b3f7d9e10', { method: 'PATCH', token: adminToken, body: { status: 'RESOLVED' } })).status).toBe(404);
      expect((await request(`/admin/support/contact-messages/${target.id}`, { method: 'PATCH', token: customerToken, body: { status: 'NEW' } })).status).toBe(403);
    });
  });
});
