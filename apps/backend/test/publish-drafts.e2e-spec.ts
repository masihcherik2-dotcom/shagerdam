import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { AuditAction, UserRole, VendorStatus } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { GLOBAL_API_PREFIX } from '../src/common/constants';
import { PrismaService } from '../src/infra/prisma/prisma.service';
import { RedisService } from '../src/infra/redis/redis.service';
import { OtpKeys } from '../src/modules/auth/otp.service';
import { PUBLISH_DRAFTS_BATCH } from '../src/modules/products/products.service';
import { SMS_PROVIDER, type SmsProvider } from '../src/modules/sms/sms-provider.interface';
import type { SandboxSmsProvider } from '../src/modules/sms/providers/sandbox-sms.provider';
import { applyGlobalPolicies } from '../src/setup/app.setup';

/**
 * «انتشار همه محصولات پیش‌نویس» end to end (PostgreSQL, Redis, auth, audit):
 * the vendor publishes the drafts of its own store, staff publish one store's
 * (or every store's) drafts. Same rules as publishing one product: blocked
 * products, products of non-approved stores and products without an active
 * variant stay unpublished and are reported.
 *
 * The "every store" POST is not exercised here because it would also publish
 * drafts belonging to other suites / seed data in the shared test database; its
 * filter is the same as the per-store one minus the store condition.
 */

const RUN = Date.now().toString(36);
const TEST_UA = `publish-drafts-e2e/${RUN}`;
const MOBILES = { a: '+989971140001', b: '+989971140002', c: '+989971140003' };
const SUITE_MOBILES = Object.values(MOBILES);
const SEEDED_ADMIN_EMAIL = 'admin@shopino.local';
const SEEDED_SUPPORT_EMAIL = 'support@shopino.local';
const BULK_EXTRA = PUBLISH_DRAFTS_BATCH + 20; // forces a second batch

type Summary = { publishable: number; blocked: number; noActiveVariant: number; storeNotApproved: number };
type Result = { published: number; remaining: Summary };

describe('Bulk publish of draft products (live stack)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let redis: RedisService;
  const API = `/${GLOBAL_API_PREFIX}`;
  let vendorAToken = '';
  let adminToken = '';
  let supportToken = '';
  let categoryId = '';
  const vendorIds: Record<'a' | 'b' | 'c', string> = { a: '', b: '', c: '' };
  const slugs = { a: `pd-a-${RUN}`, b: `pd-b-${RUN}`, c: `pd-c-${RUN}` };
  const products: Record<string, string> = {};

  const request = async <T>(url: string, options: { method?: 'GET' | 'POST'; token?: string; body?: unknown } = {}): Promise<{ status: number; body: T }> => {
    const headers: Record<string, string> = { 'user-agent': TEST_UA };
    if (options.token) headers.authorization = `Bearer ${options.token}`;
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    const response = await app.inject({ method: options.method ?? 'GET', url: `${API}${url}`, headers, ...(options.body === undefined ? {} : { payload: JSON.stringify(options.body) }) });
    return { status: response.statusCode, body: response.body.length > 0 ? (JSON.parse(response.body) as T) : (undefined as T) };
  };

  const loginWithOtp = async (mobile: string): Promise<string> => {
    await redis.client.del(OtpKeys.cooldown(mobile), OtpKeys.challenge(mobile), OtpKeys.hourlyByMobile(mobile));
    expect((await request('/auth/otp/request', { method: 'POST', body: { mobile } })).status).toBe(200);
    const code = (app.get<SmsProvider>(SMS_PROVIDER) as SandboxSmsProvider).latestOtpCode(mobile);
    const verified = await request<{ accessToken: string }>('/auth/otp/verify', { method: 'POST', body: { mobile, code } });
    expect(verified.status).toBe(200);
    return verified.body.accessToken;
  };

  const loginWithPassword = async (identifier: string, password: string): Promise<string> => {
    const response = await request<{ accessToken: string }>('/auth/login/password', { method: 'POST', body: { identifier, password } });
    expect(response.status).toBe(200);
    return response.body.accessToken;
  };

  /** A product with one variant, written directly (the state under test is the starting point, not the creation flow). */
  const product = async (key: string, vendor: 'a' | 'b' | 'c', state: { published?: boolean; blocked?: boolean; activeVariant?: boolean }): Promise<void> => {
    const created = await prisma.product.create({
      data: {
        vendorId: vendorIds[vendor],
        categoryId,
        title: `محصول ${key} ${RUN}`,
        slug: `pd-${key}-${RUN}`,
        basePrice: 1_000_000,
        isPublished: state.published ?? false,
        isBlockedByAdmin: state.blocked ?? false,
        ...(state.blocked ? { blockedReason: 'نقض قوانین فروشگاه (آزمون)', blockedAt: new Date() } : {}),
        variants: { create: { sku: `PD-${key}-${RUN}`.toUpperCase(), price: 1_000_000, stockQuantity: 5, isActive: state.activeVariant ?? true } },
      },
      select: { id: true },
    });
    products[key] = created.id;
  };

  async function cleanup(): Promise<void> {
    const vendors = await prisma.vendor.findMany({ where: { storeSlug: { in: Object.values(slugs) } }, select: { id: true } });
    const vendorList = vendors.map((vendor) => vendor.id);
    const productRows = await prisma.product.findMany({ where: { vendorId: { in: vendorList } }, select: { id: true } });
    const productIds = productRows.map((row) => row.id);
    const users = await prisma.user.findMany({ where: { mobile: { in: SUITE_MOBILES } }, select: { id: true } });
    const userIds = users.map((user) => user.id);
    await prisma.auditLog.deleteMany({ where: { OR: [{ entityId: { in: productIds } }, { userId: { in: userIds } }, { userAgent: TEST_UA }] } });
    await prisma.productVariant.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
    await prisma.vendor.deleteMany({ where: { id: { in: vendorList } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
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
    await redis.client.del('catalog:category-tree:v1');

    const adminPassword = process.env['SUPER_ADMIN_PASSWORD'];
    const staffPassword = process.env['SEED_STAFF_PASSWORD'];
    if (!adminPassword || !staffPassword) throw new Error('This suite needs SUPER_ADMIN_PASSWORD and SEED_STAFF_PASSWORD from the root .env.');

    categoryId = (await prisma.category.findFirstOrThrow({ where: { isActive: true, children: { none: {} } }, select: { id: true } })).id;
    const statuses = { a: VendorStatus.APPROVED, b: VendorStatus.APPROVED, c: VendorStatus.SUSPENDED };
    for (const key of ['a', 'b', 'c'] as const) {
      const user = await prisma.user.create({ data: { mobile: MOBILES[key], fullName: `فروشنده ${key}`, role: UserRole.VENDOR }, select: { id: true } });
      const vendor = await prisma.vendor.create({
        data: { userId: user.id, storeName: `فروشگاه ${key} ${RUN}`, storeSlug: slugs[key], bankIban: 'IR820540102680020817909002', status: statuses[key] },
        select: { id: true },
      });
      vendorIds[key] = vendor.id;
    }

    await product('a1', 'a', {});
    await product('a2', 'a', {});
    await product('a3', 'a', { activeVariant: false });
    await product('a4', 'a', { blocked: true });
    await product('a5', 'a', { published: true });
    await product('b1', 'b', {});
    await product('c1', 'c', {});

    // A large catalogue of drafts for store B (more than one batch).
    const bulkIds = Array.from({ length: BULK_EXTRA }, () => randomUUID());
    await prisma.product.createMany({
      data: bulkIds.map((id, index) => ({ id, vendorId: vendorIds.b, categoryId, title: `پیش‌نویس انبوه ${index} ${RUN}`, slug: `pd-bulk-${index}-${RUN}`, basePrice: 500_000 })),
    });
    await prisma.productVariant.createMany({ data: bulkIds.map((id, index) => ({ productId: id, sku: `PD-BULK-${index}-${RUN}`.toUpperCase(), price: 500_000, stockQuantity: 3 })) });

    vendorAToken = await loginWithOtp(MOBILES.a);
    adminToken = await loginWithPassword(SEEDED_ADMIN_EMAIL, adminPassword);
    supportToken = await loginWithPassword(SEEDED_SUPPORT_EMAIL, staffPassword);
  }, 120_000);

  afterAll(async () => {
    if (prisma !== undefined) await cleanup();
    await redis?.client.del('catalog:category-tree:v1');
    await app?.close();
  });

  describe('vendor', () => {
    it('previews what would be published and what would stay a draft', async () => {
      const summary = await request<Summary>('/vendor/products/publish-drafts', { token: vendorAToken });
      expect(summary.status).toBe(200);
      expect(summary.body).toEqual({ publishable: 2, blocked: 1, noActiveVariant: 1, storeNotApproved: 0 });
    });

    it('publishes the qualifying drafts of its own store only, with one audit row each', async () => {
      const result = await request<Result>('/vendor/products/publish-drafts', { method: 'POST', token: vendorAToken });
      expect(result.status).toBe(200);
      expect(result.body).toEqual({ published: 2, remaining: { publishable: 0, blocked: 1, noActiveVariant: 1, storeNotApproved: 0 } });

      const rows = await prisma.product.findMany({ where: { id: { in: Object.values(products) } }, select: { id: true, isPublished: true, variants: { select: { isActive: true } } } });
      const byId = new Map(rows.map((row) => [row.id, row]));
      expect(byId.get(products.a1!)?.isPublished).toBe(true);
      expect(byId.get(products.a2!)?.isPublished).toBe(true);
      expect(byId.get(products.a3!)).toMatchObject({ isPublished: false, variants: [{ isActive: false }] }); // variants are never switched on
      expect(byId.get(products.a4!)?.isPublished).toBe(false); // blocked by staff
      expect(byId.get(products.b1!)?.isPublished).toBe(false); // another store

      const audits = await prisma.auditLog.findMany({ where: { entityId: { in: [products.a1!, products.a2!] }, action: AuditAction.STATUS_CHANGE } });
      expect(audits).toHaveLength(2);
      expect(audits[0]?.newValue).toMatchObject({ isPublished: true, by: 'vendor', bulk: 'publish-drafts' });

      // On the storefront at once.
      expect((await request(`/products/pd-a1-${RUN}`)).status).toBe(200);
    });

    it('is idempotent', async () => {
      const again = await request<Result>('/vendor/products/publish-drafts', { method: 'POST', token: vendorAToken });
      expect(again.body.published).toBe(0);
    });

    it('is for vendors only', async () => {
      expect((await request('/vendor/products/publish-drafts', { method: 'POST', token: adminToken })).status).toBe(403);
      expect((await request('/vendor/products/publish-drafts', { method: 'POST' })).status).toBe(401);
    });
  });

  describe('staff', () => {
    it('previews one store, or every store', async () => {
      const storeB = await request<Summary>(`/admin/products/publish-drafts?vendorSlug=${slugs.b}`, { token: adminToken });
      expect(storeB.body).toEqual({ publishable: 1 + BULK_EXTRA, blocked: 0, noActiveVariant: 0, storeNotApproved: 0 });
      const storeC = await request<Summary>(`/admin/products/publish-drafts?vendorSlug=${slugs.c}`, { token: adminToken });
      expect(storeC.body).toEqual({ publishable: 0, blocked: 0, noActiveVariant: 0, storeNotApproved: 1 });
      const all = await request<Summary>('/admin/products/publish-drafts', { token: adminToken });
      expect(all.status).toBe(200);
      expect(all.body.publishable).toBeGreaterThanOrEqual(1 + BULK_EXTRA);
      expect(all.body.storeNotApproved).toBeGreaterThanOrEqual(1);
      expect((await request<{ statusCode: number }>('/admin/products/publish-drafts?vendorSlug=no-such-store-xyz', { token: adminToken })).status).toBe(404);
    });

    it('lets only SUPER_ADMIN and ADMIN publish', async () => {
      expect((await request('/admin/products/publish-drafts', { token: supportToken })).status).toBe(403);
      expect((await request(`/admin/products/publish-drafts?vendorSlug=${slugs.b}`, { method: 'POST', token: supportToken })).status).toBe(403);
      expect((await request(`/admin/products/publish-drafts?vendorSlug=${slugs.b}`, { method: 'POST', token: vendorAToken })).status).toBe(403);
    });

    it('publishes every qualifying draft of the store across batches', async () => {
      const result = await request<Result>(`/admin/products/publish-drafts?vendorSlug=${slugs.b}`, { method: 'POST', token: adminToken });
      expect(result.status).toBe(200);
      expect(result.body).toEqual({ published: 1 + BULK_EXTRA, remaining: { publishable: 0, blocked: 0, noActiveVariant: 0, storeNotApproved: 0 } });
      expect(await prisma.product.count({ where: { vendorId: vendorIds.b, isPublished: false } })).toBe(0);
      const audits = await prisma.auditLog.count({ where: { action: AuditAction.STATUS_CHANGE, entityName: 'Product', newValue: { path: ['by'], equals: 'staff' }, entityId: { in: [products.b1!] } } });
      expect(audits).toBe(1);
      // Other stores are untouched.
      expect((await prisma.product.findUniqueOrThrow({ where: { id: products.a3! } })).isPublished).toBe(false);
      expect((await prisma.product.findUniqueOrThrow({ where: { id: products.c1! } })).isPublished).toBe(false);
    }, 60_000);

    it('never publishes products of a store that is not approved', async () => {
      const result = await request<Result>(`/admin/products/publish-drafts?vendorSlug=${slugs.c}`, { method: 'POST', token: adminToken });
      expect(result.body).toEqual({ published: 0, remaining: { publishable: 0, blocked: 0, noActiveVariant: 0, storeNotApproved: 1 } });
    });
  });
});
