import { ConfigService } from '@nestjs/config';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { UserRole, VendorStatus } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { GLOBAL_API_PREFIX } from '../src/common/constants';
import { normalizeIdentifier } from '../src/modules/auth/auth.service';
import { OtpKeys } from '../src/modules/auth/otp.service';
import { loginAttemptsKey, loginLockKey } from '../src/modules/auth/token.service';
import { PrismaService } from '../src/infra/prisma/prisma.service';
import { RedisService } from '../src/infra/redis/redis.service';
import { SMS_PROVIDER, type SmsProvider } from '../src/modules/sms/sms-provider.interface';
import type { SandboxSmsProvider } from '../src/modules/sms/providers/sandbox-sms.provider';
import { applyGlobalPolicies } from '../src/setup/app.setup';

/**
 * Phase 1 (TM) against the real stack (PostgreSQL, Redis, sandbox SMS):
 *
 * - `POST /admin/vendors`: staff open an APPROVED store (wallet + audit row with
 *   kycBy=ADMIN_CREATED); the seller signs in with the owner mobile via OTP.
 * - `POST /admin/vendors/:id/products`: staff create and publish a product in
 *   the store's name; it is listed publicly under the store.
 * - `GET /products?onSaleOnly=true`: only discounted variants match.
 * - `googleVerificationTag` on `/admin/site-info` ↔ public `/site-info`.
 *
 * Own mobiles / slugs; everything created is removed in afterAll.
 */

const TEST_UA = 'shopino-phase1-e2e/1.0';
const RUN = Date.now().toString(36);
const OWNER_MOBILE = '+989971130001';
const SECOND_MOBILE = '+989971130002';
const SUITE_MOBILES = [OWNER_MOBILE, SECOND_MOBILE];
const IBAN = 'IR820540102680020817909002';
const SEEDED_ADMIN_EMAIL = 'admin@shopino.local';
const SEEDED_SUPPORT_EMAIL = 'support@shopino.local';
const GSC_TOKEN = 'e2eGscToken_0123456789abcdefghijklmnopqrstu';

interface HttpResult<T> {
  status: number;
  body: T;
}

interface CreatedVendor {
  profile: { id: string; userId: string; storeSlug: string; status: VendorStatus; verifiedAt: string | null; commissionRateOverride: string | null };
  ownerCreated: boolean;
  auditLogId: string;
}

describe('Phase 1 — admin-created stores, admin catalogue, on-sale filter, GSC tag', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let adminToken: string;
  let supportToken: string;
  let vendorId: string;
  let categoryId: string;
  let previousGsc: string | null = null;
  const storeSlug = `e2e-p1-${RUN}`;
  const API = `/${GLOBAL_API_PREFIX}`;

  const request = async <T>(url: string, options: { method?: 'GET' | 'POST' | 'PATCH'; token?: string; body?: unknown } = {}): Promise<HttpResult<T>> => {
    const headers: Record<string, string> = { 'user-agent': TEST_UA };
    if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    const response = await app.inject({
      method: options.method ?? 'GET',
      url: `${API}${url}`,
      headers,
      ...(options.body === undefined ? {} : { payload: JSON.stringify(options.body) }),
    });
    return { status: response.statusCode, body: response.body.length > 0 ? (JSON.parse(response.body) as T) : (undefined as T) };
  };

  const loginWithPassword = async (identifier: string, password: string): Promise<string> => {
    const response = await request<{ accessToken: string }>('/auth/login/password', { method: 'POST', body: { identifier, password } });
    expect(response.status).toBe(200);
    return response.body.accessToken;
  };

  const loginWithOtp = async (mobile: string): Promise<{ token: string; role: UserRole }> => {
    expect((await request('/auth/otp/request', { method: 'POST', body: { mobile } })).status).toBe(200);
    const code = (app.get<SmsProvider>(SMS_PROVIDER) as SandboxSmsProvider).latestOtpCode(mobile);
    const verified = await request<{ accessToken: string; user: { role: UserRole } }>('/auth/otp/verify', { method: 'POST', body: { mobile, code } });
    expect(verified.status).toBe(200);
    return { token: verified.body.accessToken, role: verified.body.user.role };
  };

  const vendorBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    storeName: 'فروشگاه آزمون فاز یک',
    storeSlug,
    ownerMobile: '09971130001',
    ownerFullName: 'مالک آزمون',
    bankIban: IBAN,
    commissionRateOverride: 7.5,
    instagramHandle: '@e2e.phase1',
    bio: 'ساخته‌شده توسط آزمون',
    ...overrides,
  });

  async function resetAuthKeys(): Promise<void> {
    const redis = app.get(RedisService);
    const keys = [
      ...(await redis.client.keys('auth:otp:hourly:ip:*')),
      ...SUITE_MOBILES.flatMap((mobile) => [OtpKeys.challenge(mobile), OtpKeys.lock(mobile), OtpKeys.cooldown(mobile), OtpKeys.hourlyByMobile(mobile)]),
      ...[SEEDED_ADMIN_EMAIL, SEEDED_SUPPORT_EMAIL].flatMap((identifier) => [loginAttemptsKey(normalizeIdentifier(identifier)), loginLockKey(normalizeIdentifier(identifier))]),
    ];
    if (keys.length > 0) await redis.client.del(...keys);
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    applyGlobalPolicies(app, app.get(ConfigService));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = app.get(PrismaService);
    await resetAuthKeys();

    const adminPassword = process.env['SUPER_ADMIN_PASSWORD'];
    const staffPassword = process.env['SEED_STAFF_PASSWORD'];
    if (adminPassword === undefined || staffPassword === undefined) throw new Error('Needs SUPER_ADMIN_PASSWORD and SEED_STAFF_PASSWORD (root .env).');
    adminToken = await loginWithPassword(SEEDED_ADMIN_EMAIL, adminPassword);
    supportToken = await loginWithPassword(SEEDED_SUPPORT_EMAIL, staffPassword);

    const category = await prisma.category.findFirst({ where: { slug: 'power-tools', isActive: true }, select: { id: true } });
    if (category === null) throw new Error('Seeded category "power-tools" is missing — run the seed.');
    categoryId = category.id;

    const current = await request<{ googleVerificationTag: string | null }>('/admin/site-info', { token: adminToken });
    previousGsc = current.body.googleVerificationTag;
  }, 60_000);

  afterAll(async () => {
    if (prisma !== undefined) {
      const users = await prisma.user.findMany({ where: { mobile: { in: SUITE_MOBILES } }, select: { id: true } });
      const userIds = users.map((user) => user.id);
      const vendors = await prisma.vendor.findMany({ where: { OR: [{ storeSlug: { startsWith: 'e2e-p1-' } }, { userId: { in: userIds } }] }, select: { id: true } });
      const vendorIds = vendors.map((vendor) => vendor.id);
      const products = await prisma.product.findMany({ where: { vendorId: { in: vendorIds } }, select: { id: true } });
      const productIds = products.map((product) => product.id);
      await prisma.productMedia.deleteMany({ where: { productId: { in: productIds } } });
      await prisma.productVariant.deleteMany({ where: { productId: { in: productIds } } });
      await prisma.product.deleteMany({ where: { id: { in: productIds } } });
      await prisma.auditLog.deleteMany({ where: { OR: [{ userId: { in: userIds } }, { entityId: { in: [...vendorIds, ...productIds] } }, { userAgent: TEST_UA }] } });
      await prisma.vendorWallet.deleteMany({ where: { vendorId: { in: vendorIds } } });
      await prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      if (adminToken !== undefined) {
        await request('/admin/site-info', { method: 'PATCH', token: adminToken, body: { googleVerificationTag: previousGsc } });
      }
      await resetAuthKeys();
    }
    await app?.close();
  }, 60_000);

  describe('POST /admin/vendors', () => {
    it('is limited to SUPER_ADMIN/ADMIN', async () => {
      expect((await request('/admin/vendors', { method: 'POST', body: vendorBody() })).status).toBe(401);
      expect((await request('/admin/vendors', { method: 'POST', token: supportToken, body: vendorBody() })).status).toBe(403);
    });

    it('validates SHEBA, mobile, slug and commission', async () => {
      const invalid = await request<{ message: string | string[] }>('/admin/vendors', {
        method: 'POST',
        token: adminToken,
        body: vendorBody({ bankIban: 'IR000000000000000000000000', ownerMobile: '02112345678', storeSlug: 'Bad Slug', commissionRateOverride: 120 }),
      });
      expect(invalid.status).toBe(400);
      const text = JSON.stringify(invalid.body.message);
      for (const field of ['bankIban', 'ownerMobile', 'storeSlug', 'commissionRateOverride']) expect(text).toContain(field);
    });

    it('creates an APPROVED store with owner, wallet and an ADMIN_CREATED audit row', async () => {
      const created = await request<CreatedVendor>('/admin/vendors', { method: 'POST', token: adminToken, body: vendorBody() });
      expect(created.status).toBe(201);
      expect(created.body.ownerCreated).toBe(true);
      expect(created.body.profile).toMatchObject({ storeSlug, status: 'APPROVED', commissionRateOverride: '7.50' });
      expect(created.body.profile.verifiedAt).not.toBeNull();
      vendorId = created.body.profile.id;

      const row = await prisma.vendor.findUniqueOrThrow({ where: { id: vendorId }, select: { status: true, bankIban: true, bankAccountHolder: true, user: { select: { mobile: true, role: true, fullName: true } }, wallet: { select: { id: true } } } });
      expect(row).toMatchObject({ status: VendorStatus.APPROVED, bankIban: IBAN, bankAccountHolder: 'مالک آزمون', user: { mobile: OWNER_MOBILE, role: UserRole.VENDOR, fullName: 'مالک آزمون' } });
      expect(row.wallet).not.toBeNull();

      const audit = await prisma.auditLog.findUniqueOrThrow({ where: { id: created.body.auditLogId }, select: { entityName: true, entityId: true, newValue: true } });
      expect(audit).toMatchObject({ entityName: 'Vendor', entityId: vendorId });
      expect(audit.newValue).toMatchObject({ kycBy: 'ADMIN_CREATED', status: 'APPROVED' });
      expect(JSON.stringify(audit.newValue)).not.toContain(IBAN);
    });

    it('refuses a duplicate slug and a mobile that already owns a store', async () => {
      expect((await request('/admin/vendors', { method: 'POST', token: adminToken, body: vendorBody({ ownerMobile: '09971130002' }) })).status).toBe(409);
      expect((await request('/admin/vendors', { method: 'POST', token: adminToken, body: vendorBody({ storeSlug: `${storeSlug}-b` }) })).status).toBe(409);
    });

    it('lets the seller sign in with the owner mobile (OTP) and see the approved store', async () => {
      const owner = await loginWithOtp(OWNER_MOBILE);
      expect(owner.role).toBe(UserRole.VENDOR);
      const profile = await request<{ id: string; status: VendorStatus }>('/vendors/me', { token: owner.token });
      expect(profile.status).toBe(200);
      expect(profile.body).toMatchObject({ id: vendorId, status: 'APPROVED' });
    });
  });

  describe('staff catalogue work for a store', () => {
    const productBody = (slugSuffix: string, variant: Record<string, unknown>): Record<string, unknown> => ({
      title: `دریل آزمون فاز یک ${slugSuffix}`,
      slug: `e2e-p1-${RUN}-${slugSuffix}`,
      categoryId,
      basePrice: 25_000_000,
      isPublished: true,
      variants: [{ sku: `E2E-P1-${RUN}-${slugSuffix}`.toUpperCase(), price: 25_000_000, stockQuantity: 5, ...variant }],
    });

    it('is limited to SUPER_ADMIN/ADMIN', async () => {
      expect((await request(`/admin/vendors/${vendorId}/products`, { method: 'POST', token: supportToken, body: productBody('x', {}) })).status).toBe(403);
      expect((await request(`/admin/vendors/${vendorId}/products/import/extract-spec`, { method: 'POST', token: supportToken, body: { url: 'https://www.digikala.com/product/dkp-1/' } })).status).toBe(403);
    });

    it('creates and publishes products in the store’s name', async () => {
      const onSale = await request<{ id: string; isPublished: boolean }>(`/admin/vendors/${vendorId}/products`, { method: 'POST', token: adminToken, body: productBody('sale', { compareAtPrice: 30_000_000 }) });
      expect(onSale.status).toBe(201);
      expect(onSale.body.isPublished).toBe(true);
      const regular = await request(`/admin/vendors/${vendorId}/products`, { method: 'POST', token: adminToken, body: productBody('full', {}) });
      expect(regular.status).toBe(201);

      const stored = await prisma.product.findUniqueOrThrow({ where: { id: onSale.body.id }, select: { vendorId: true } });
      expect(stored.vendorId).toBe(vendorId);
      const audit = await prisma.auditLog.findFirst({ where: { entityId: onSale.body.id, entityName: 'Product' }, select: { userId: true } });
      expect(audit?.userId).toBeDefined();
      expect(audit?.userId).not.toBe((await prisma.vendor.findUniqueOrThrow({ where: { id: vendorId }, select: { userId: true } })).userId);
    });

    it('404s for an unknown store', async () => {
      expect((await request('/admin/vendors/00000000-0000-4000-8000-000000000000/products', { method: 'POST', token: adminToken, body: productBody('404', {}) })).status).toBe(404);
    });

    it('lists the store products publicly, and onSaleOnly keeps only discounted ones', async () => {
      const all = await request<{ total: number; items: Array<{ slug: string }> }>(`/products?vendorSlug=${storeSlug}`);
      expect(all.status).toBe(200);
      expect(all.body.items.map((item) => item.slug).sort()).toEqual([`e2e-p1-${RUN}-full`, `e2e-p1-${RUN}-sale`]);

      const sale = await request<{ total: number; items: Array<{ slug: string; maxDiscountPercent: number | null }> }>(`/products?vendorSlug=${storeSlug}&onSaleOnly=true`);
      expect(sale.status).toBe(200);
      expect(sale.body.items.map((item) => item.slug)).toEqual([`e2e-p1-${RUN}-sale`]);
      expect(sale.body.items[0]?.maxDiscountPercent).toBeGreaterThan(0);
    });
  });

  describe('Google Search Console tag', () => {
    it('accepts the whole meta tag, stores the token and publishes it', async () => {
      const saved = await request<{ googleVerificationTag: string | null }>('/admin/site-info', {
        method: 'PATCH',
        token: adminToken,
        body: { googleVerificationTag: `<meta name="google-site-verification" content="${GSC_TOKEN}" />` },
      });
      expect(saved.status).toBe(200);
      expect(saved.body.googleVerificationTag).toBe(GSC_TOKEN);
      const published = await request<{ googleVerificationTag: string | null }>('/site-info');
      expect(published.body.googleVerificationTag).toBe(GSC_TOKEN);
    });

    it('rejects markup that is not a verification token', async () => {
      const rejected = await request('/admin/site-info', { method: 'PATCH', token: adminToken, body: { googleVerificationTag: '"><script>alert(1)</script>' } });
      expect(rejected.status).toBe(400);
    });

    it('is not writable by support staff', async () => {
      expect((await request('/admin/site-info', { method: 'PATCH', token: supportToken, body: { googleVerificationTag: GSC_TOKEN } })).status).toBe(403);
    });
  });
});
