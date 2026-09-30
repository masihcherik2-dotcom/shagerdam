import { ConfigService } from '@nestjs/config';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { AuditAction, type ConfigValueType } from '@prisma/client';
import sharp from 'sharp';
import { AppModule } from '../src/app.module';
import { GLOBAL_API_PREFIX } from '../src/common/constants';
import { PrismaService } from '../src/infra/prisma/prisma.service';
import { RedisService } from '../src/infra/redis/redis.service';
import { normalizeIdentifier } from '../src/modules/auth/auth.service';
import { OtpKeys } from '../src/modules/auth/otp.service';
import { loginAttemptsKey, loginLockKey } from '../src/modules/auth/token.service';
import { BRANDING_CACHE_KEY, BRANDING_KEYS, BRANDING_KEY_LIST } from '../src/modules/branding/branding-rules';
import { SMS_PROVIDER } from '../src/modules/sms/sms-provider.interface';
import type { SmsProvider } from '../src/modules/sms/sms-provider.interface';
import type { SandboxSmsProvider } from '../src/modules/sms/providers/sandbox-sms.provider';
import { STORAGE_PROVIDER, type StorageProvider } from '../src/modules/storage/storage-provider.interface';
import { applyGlobalPolicies, buildOpenApiDocument } from '../src/setup/app.setup';

/**
 * Branding against the live stack (PostgreSQL + Redis + the configured storage
 * provider): real uploads through Sharp, real `system_configs` writes, real
 * cache purge, real AuditLog rows. The platform's existing branding rows are
 * snapshotted before the suite and restored afterwards; every asset, file,
 * audit row, user and Redis key the suite creates is removed.
 */

const TEST_UA = 'shopino-branding-e2e/1.0';
const CUSTOMER_MOBILE = '+989971141001';
const SEEDED_ADMIN_EMAIL = 'admin@shopino.local';

interface HttpResult<T> {
  status: number;
  body: T;
  headers: Record<string, string | string[] | number | undefined>;
  raw: Buffer;
}
interface ErrorBody {
  code?: string;
  message?: string | string[];
}
interface Banner {
  id: string;
  imageUrl: string;
  title: string | null;
  linkUrl: string | null;
  sortOrder: number;
  isActive?: boolean;
}
interface PublicBranding {
  logoUrl: string | null;
  mobileLogoUrl: string | null;
  faviconUrl: string | null;
  heroBanners: Banner[];
}
interface AdminBranding extends PublicBranding {
  heroBanners: Array<Banner & { isActive: boolean }>;
  updatedAt: Record<'logoUrl' | 'mobileLogoUrl' | 'faviconUrl' | 'heroBanners', string | null>;
  history: Array<{ id: string; createdAt: string; actor: { id: string; fullName: string } | null; changedFields: string[] }>;
  auditLogId?: string;
}
interface Asset {
  id: string;
  slot: string;
  url: string;
  thumbnailUrl: string;
  mimeType: string;
  width: number;
  height: number;
  sizeBytes: number;
  originalSizeBytes: number;
}

describe('Branding — public config, admin management, uploads, cache invalidation (live stack)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let redis: RedisService;
  let storage: StorageProvider;
  let adminToken: string;
  let adminId: string;
  let customerToken: string;
  let snapshot: Array<{ key: string; value: string; valueType: ConfigValueType; description: string | null }> = [];
  const createdAssetIds: string[] = [];
  const assets: Partial<Record<'logo' | 'logoSvg' | 'mobile' | 'favicon' | 'banner1' | 'banner2', Asset>> = {};

  const API = `/${GLOBAL_API_PREFIX}`;

  const request = async <T>(
    url: string,
    options: { method?: 'GET' | 'POST' | 'PATCH'; token?: string; body?: unknown; form?: FormData; absolute?: boolean } = {},
  ): Promise<HttpResult<T>> => {
    const headers: Record<string, string> = { 'user-agent': TEST_UA };
    if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
    let payload: string | Buffer | undefined;
    if (options.form !== undefined) {
      const serialized = new Response(options.form);
      payload = Buffer.from(await serialized.arrayBuffer());
      headers['content-type'] = serialized.headers.get('content-type') ?? '';
    } else if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(options.body);
    }
    const response = await app.inject({
      method: options.method ?? 'GET',
      url: options.absolute === true ? url : `${API}${url}`,
      headers,
      ...(payload === undefined ? {} : { payload }),
    });
    const isJson = String(response.headers['content-type'] ?? '').includes('json');
    return {
      status: response.statusCode,
      body: isJson && response.body.length > 0 ? (JSON.parse(response.body) as T) : (undefined as T),
      headers: response.headers,
      raw: response.rawPayload,
    };
  };

  const publicBranding = (): Promise<HttpResult<PublicBranding>> => request('/branding');
  const adminBranding = (): Promise<HttpResult<AdminBranding>> => request('/admin/branding', { token: adminToken });
  const patch = (body: unknown, token = adminToken): Promise<HttpResult<AdminBranding & ErrorBody>> =>
    request('/admin/branding', { method: 'PATCH', token, body });

  const upload = async (slot: string, file: Buffer, name: string, type: string, token = adminToken): Promise<HttpResult<Asset & ErrorBody>> => {
    const form = new FormData();
    form.append('slot', slot);
    form.append('file', new Blob([new Uint8Array(file)], { type }), name);
    const result = await request<Asset & ErrorBody>('/admin/branding/assets', { method: 'POST', token, form });
    if (result.status === 201) createdAssetIds.push(result.body.id);
    return result;
  };
  const png = (width: number, height: number, color: string): Promise<Buffer> =>
    sharp({ create: { width, height, channels: 4, background: color } }).png().toBuffer();
  const svgLogo = Buffer.from(
    '<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="160" height="48" viewBox="0 0 160 48">' +
      '<rect width="160" height="48" rx="8" fill="#1d4ed8"/><circle cx="24" cy="24" r="14" fill="#ffffff"/></svg>',
  );
  /** Fetches a stored image through the public media route and decodes it. */
  const served = async (url: string): Promise<Awaited<ReturnType<ReturnType<typeof sharp>['metadata']>>> => {
    const response = await request(/^https?:\/\//.test(url) ? new URL(url).pathname : url, { absolute: true });
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('image/webp');
    return sharp(response.raw).metadata();
  };

  const loginWithOtp = async (mobile: string): Promise<string> => {
    expect((await request('/auth/otp/request', { method: 'POST', body: { mobile } })).status).toBe(200);
    const code = (app.get<SmsProvider>(SMS_PROVIDER) as SandboxSmsProvider).latestOtpCode(mobile);
    const verified = await request<{ accessToken: string }>('/auth/otp/verify', { method: 'POST', body: { mobile, code } });
    expect(verified.status).toBe(200);
    return verified.body.accessToken;
  };

  async function resetKeys(): Promise<void> {
    await redis.client.del(
      BRANDING_CACHE_KEY,
      OtpKeys.challenge(CUSTOMER_MOBILE),
      OtpKeys.lock(CUSTOMER_MOBILE),
      OtpKeys.cooldown(CUSTOMER_MOBILE),
      OtpKeys.hourlyByMobile(CUSTOMER_MOBILE),
      loginAttemptsKey(normalizeIdentifier(SEEDED_ADMIN_EMAIL)),
      loginLockKey(normalizeIdentifier(SEEDED_ADMIN_EMAIL)),
    );
    const ipKeys = await redis.client.keys('auth:otp:hourly:ip:*');
    if (ipKeys.length > 0) await redis.client.del(...ipKeys);
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    applyGlobalPolicies(app, app.get(ConfigService));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = app.get(PrismaService);
    redis = app.get(RedisService);
    storage = app.get<StorageProvider>(STORAGE_PROVIDER);

    // Start from "nothing configured"; the platform's own values come back in afterAll.
    snapshot = await prisma.systemConfig.findMany({
      where: { key: { in: BRANDING_KEY_LIST } },
      select: { key: true, value: true, valueType: true, description: true },
    });
    await prisma.systemConfig.deleteMany({ where: { key: { in: BRANDING_KEY_LIST } } });
    await resetKeys();

    const adminPassword = process.env['SUPER_ADMIN_PASSWORD'];
    if (adminPassword === undefined) throw new Error('This suite needs SUPER_ADMIN_PASSWORD from the root .env.');
    const admin = await request<{ accessToken: string; user: { id: string } }>('/auth/login/password', {
      method: 'POST',
      body: { identifier: SEEDED_ADMIN_EMAIL, password: adminPassword },
    });
    expect(admin.status).toBe(200);
    adminToken = admin.body.accessToken;
    adminId = admin.body.user.id;
    customerToken = await loginWithOtp(CUSTOMER_MOBILE);
  }, 120_000);

  afterAll(async () => {
    if (prisma !== undefined) {
      await prisma.systemConfig.deleteMany({ where: { key: { in: BRANDING_KEY_LIST } } });
      for (const row of snapshot) {
        await prisma.systemConfig.create({ data: row });
      }
      const rows = await prisma.mediaAsset.findMany({ where: { id: { in: createdAssetIds } }, select: { path: true, thumbnailPath: true } });
      for (const row of rows) {
        await storage.delete(row.path).catch(() => false);
        if (row.thumbnailPath !== null) await storage.delete(row.thumbnailPath).catch(() => false);
      }
      await prisma.mediaAsset.deleteMany({ where: { id: { in: createdAssetIds } } });
      const customer = await prisma.user.findUnique({ where: { mobile: CUSTOMER_MOBILE }, select: { id: true } });
      await prisma.auditLog.deleteMany({ where: { OR: [{ userAgent: TEST_UA }, ...(customer ? [{ userId: customer.id }] : [])] } });
      if (customer) await prisma.user.delete({ where: { id: customer.id } });
      await resetKeys();
    }
    await app?.close();
  }, 60_000);

  // ─── Public endpoint ──────────────────────────────────────────────────────

  describe('GET /branding (public)', () => {
    it('returns nulls and no banners when nothing is configured', async () => {
      const response = await publicBranding();
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ logoUrl: null, mobileLogoUrl: null, faviconUrl: null, heroBanners: [] });
      expect(response.headers['cache-control']).toBe('no-cache');
    });

    it('caches the rendered config in Redis', async () => {
      await publicBranding();
      expect(JSON.parse((await redis.client.get(BRANDING_CACHE_KEY)) ?? 'null')).toEqual({
        logoUrl: null,
        mobileLogoUrl: null,
        faviconUrl: null,
        heroBanners: [],
      });
      expect(await redis.client.ttl(BRANDING_CACHE_KEY)).toBeGreaterThan(0);
    });
  });

  // ─── Access control ───────────────────────────────────────────────────────

  describe('access control', () => {
    it('401 without a token on every admin route', async () => {
      expect((await request('/admin/branding')).status).toBe(401);
      expect((await request('/admin/branding', { method: 'PATCH', body: {} })).status).toBe(401);
      const form = new FormData();
      form.append('slot', 'logo');
      form.append('file', new Blob([new Uint8Array(await png(200, 60, '#000'))], { type: 'image/png' }), 'l.png');
      expect((await request('/admin/branding/assets', { method: 'POST', form })).status).toBe(401);
    });

    it('403 for a signed-in customer on every admin route', async () => {
      expect((await request('/admin/branding', { token: customerToken })).status).toBe(403);
      expect((await patch({ logoUrl: null }, customerToken)).status).toBe(403);
      expect((await upload('logo', await png(200, 60, '#000'), 'l.png', 'image/png', customerToken)).status).toBe(403);
    });
  });

  // ─── Uploads ──────────────────────────────────────────────────────────────

  describe('POST /admin/branding/assets (Sharp → WebP)', () => {
    it('converts a PNG logo to WebP within the logo box and serves it publicly', async () => {
      const response = await upload('logo', await png(1600, 400, '#1d4ed8'), 'logo.png', 'image/png');
      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({ slot: 'logo', mimeType: 'image/webp', width: 800, height: 200 });
      assets.logo = response.body;
      const meta = await served(response.body.url);
      expect(meta).toMatchObject({ format: 'webp', width: 800, height: 200 });
      const row = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: response.body.id } });
      expect(row).toMatchObject({ purpose: 'branding_logo', isPublic: true, ownerUserId: adminId, vendorId: null, mimeType: 'image/webp' });
    });

    it('rasterises an SVG logo to WebP (never stores SVG)', async () => {
      const response = await upload('logo', svgLogo, 'logo.svg', 'image/svg+xml');
      expect(response.status).toBe(201);
      expect(response.body.mimeType).toBe('image/webp');
      expect(response.body.url.endsWith('.webp')).toBe(true);
      // 160×48 nominal at 4× density → 640×192, inside the 800×240 box.
      expect(response.body).toMatchObject({ width: 640, height: 192 });
      assets.logoSvg = response.body;
      expect((await served(response.body.url)).format).toBe('webp');
    });

    it('makes a square transparent favicon from a non-square source', async () => {
      const response = await upload('favicon', await png(300, 150, '#dc2626'), 'fav.png', 'image/png');
      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({ width: 512, height: 512 });
      assets.favicon = response.body;
      const meta = await served(response.body.url);
      expect(meta).toMatchObject({ width: 512, height: 512, hasAlpha: true });
      expect(await served(response.body.thumbnailUrl)).toMatchObject({ width: 64, height: 64 });
    });

    it('accepts a mobile logo and two hero banners (banner capped at 1920 wide)', async () => {
      const mobile = await upload('mobile_logo', await png(256, 256, '#16a34a'), 'm.png', 'image/png');
      expect(mobile.status).toBe(201);
      assets.mobile = mobile.body;
      const banner1 = await upload('hero_banner', await png(2400, 800, '#f59e0b'), 'b1.png', 'image/png');
      expect(banner1.status).toBe(201);
      expect(banner1.body).toMatchObject({ width: 1920, height: 640 });
      assets.banner1 = banner1.body;
      const banner2 = await upload('hero_banner', await png(1200, 400, '#7c3aed'), 'b2.png', 'image/png');
      expect(banner2.status).toBe(201);
      assets.banner2 = banner2.body;
    });

    it('rejects an SVG banner, an unsafe SVG, a too-small banner, a non-image and an unknown slot', async () => {
      expect((await upload('hero_banner', svgLogo, 'b.svg', 'image/svg+xml')).status).toBe(400);
      const entity = Buffer.from('<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY a "x">]><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">&a;</svg>');
      const unsafe = await upload('logo', entity, 'e.svg', 'image/svg+xml');
      expect(unsafe.status).toBe(400);
      const external = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="40"><image href="https://tracker.example/p.png"/></svg>');
      expect((await upload('logo', external, 'x.svg', 'image/svg+xml')).status).toBe(400);
      const small = await upload('hero_banner', await png(400, 200, '#000'), 's.png', 'image/png');
      expect(small.status).toBe(400);
      expect(String(small.body.message)).toMatch(/too small/);
      expect((await upload('logo', Buffer.from('this is plainly not an image file at all'), 'x.png', 'image/png')).status).toBe(400);
      const slot = await upload('store_logo', await png(200, 60, '#000'), 'l.png', 'image/png');
      expect(slot.status).toBe(400);
      expect(slot.body.code).toBe('BRANDING_INVALID_SLOT');
    });
  });

  // ─── Updates ──────────────────────────────────────────────────────────────

  describe('PATCH /admin/branding', () => {
    it('refuses URLs that are not branding uploads of the matching slot', async () => {
      const external = await patch({ logoUrl: 'https://cdn.example.com/logo.png' });
      expect(external.status).toBe(400);
      expect(external.body.code).toBe('BRANDING_ASSET_INVALID');
      const wrongSlot = await patch({ faviconUrl: assets.logo!.url });
      expect(wrongSlot.status).toBe(400);
      expect(wrongSlot.body.code).toBe('BRANDING_ASSET_INVALID');
      const bannerAsLogo = await patch({ heroBanners: [{ imageUrl: assets.logo!.url }] });
      expect(bannerAsLogo.body.code).toBe('BRANDING_ASSET_INVALID');
    });

    it('validates banner links, ids, count and unknown fields', async () => {
      const link = await patch({ heroBanners: [{ imageUrl: assets.banner1!.url, linkUrl: '//evil.example' }] });
      expect(link.status).toBe(400);
      expect(link.body.code).toBe('BRANDING_INVALID_LINK');
      expect((await patch({ heroBanners: [{ imageUrl: assets.banner1!.url, linkUrl: 'javascript:alert(1)' }] })).body.code).toBe('BRANDING_INVALID_LINK');
      const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
      const duplicate = await patch({ heroBanners: [{ id, imageUrl: assets.banner1!.url }, { id, imageUrl: assets.banner2!.url }] });
      expect(duplicate.body.code).toBe('BRANDING_INVALID_BANNER');
      expect((await patch({ heroBanners: Array.from({ length: 11 }, () => ({ imageUrl: assets.banner1!.url })) })).status).toBe(400);
      expect((await patch({ siteName: 'x' })).status).toBe(400);
      expect((await patch({ logoUrl: 42 })).status).toBe(400);
      // Nothing was written by any rejected request.
      expect(await prisma.systemConfig.count({ where: { key: { in: BRANDING_KEY_LIST } } })).toBe(0);
    });

    it('sets the logo: writes system_configs + AuditLog, purges the cache, and the public endpoint reflects it', async () => {
      await publicBranding(); // prime the cache with the "nothing configured" state
      expect(await redis.client.exists(BRANDING_CACHE_KEY)).toBe(1);

      const response = await patch({ logoUrl: assets.logo!.url, faviconUrl: assets.favicon!.url });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ logoUrl: assets.logo!.url, faviconUrl: assets.favicon!.url, mobileLogoUrl: null });
      expect(await redis.client.exists(BRANDING_CACHE_KEY)).toBe(0);

      expect((await publicBranding()).body).toMatchObject({ logoUrl: assets.logo!.url, faviconUrl: assets.favicon!.url, mobileLogoUrl: null });

      const rows = await prisma.systemConfig.findMany({ where: { key: { in: BRANDING_KEY_LIST } } });
      expect(Object.fromEntries(rows.map((row) => [row.key, row.value]))).toEqual({
        [BRANDING_KEYS.logoUrl]: assets.logo!.url,
        [BRANDING_KEYS.faviconUrl]: assets.favicon!.url,
      });

      const audit = await prisma.auditLog.findUniqueOrThrow({ where: { id: response.body.auditLogId! } });
      expect(audit).toMatchObject({ userId: adminId, action: AuditAction.UPDATE, entityName: 'Branding', userAgent: TEST_UA });
      expect(audit.oldValue).toEqual({ logoUrl: null, faviconUrl: null });
      expect(audit.newValue).toEqual({ logoUrl: assets.logo!.url, faviconUrl: assets.favicon!.url });
    });

    it('the admin view carries per-key timestamps and the change history', async () => {
      const view = await adminBranding();
      expect(view.status).toBe(200);
      expect(view.body.updatedAt.logoUrl).not.toBeNull();
      expect(view.body.updatedAt.faviconUrl).not.toBeNull();
      expect(view.body.updatedAt.mobileLogoUrl).toBeNull();
      expect(view.body.updatedAt.heroBanners).toBeNull();
      expect(view.body.history[0]).toMatchObject({ actor: { id: adminId }, changedFields: ['logoUrl', 'faviconUrl'] });
    });

    it('a no-op PATCH writes no audit row', async () => {
      const before = await prisma.auditLog.count({ where: { entityName: 'Branding', userAgent: TEST_UA } });
      const response = await patch({ logoUrl: assets.logo!.url });
      expect(response.status).toBe(200);
      expect(response.body.auditLogId).toBeUndefined();
      expect(await prisma.auditLog.count({ where: { entityName: 'Branding', userAgent: TEST_UA } })).toBe(before);
    });

    it('can switch to the rasterised SVG logo and set the mobile logo', async () => {
      const response = await patch({ logoUrl: assets.logoSvg!.url, mobileLogoUrl: assets.mobile!.url });
      expect(response.status).toBe(200);
      expect((await publicBranding()).body).toMatchObject({ logoUrl: assets.logoSvg!.url, mobileLogoUrl: assets.mobile!.url });
    });

    it('manages hero banners: ids assigned, order normalised, inactive banners hidden from the public', async () => {
      const response = await patch({
        heroBanners: [
          { imageUrl: assets.banner2!.url, title: '  کالای دیجیتال  ', linkUrl: '/search?categorySlug=digital', sortOrder: 20 },
          { imageUrl: assets.banner1!.url, title: 'حراج پاییزه', linkUrl: '/search?categorySlug=fashion', sortOrder: 10 },
          { imageUrl: assets.banner1!.url, title: 'پیش‌نویس', linkUrl: 'https://example.com/landing', sortOrder: 30, isActive: false },
        ],
      });
      expect(response.status).toBe(200);
      const stored = response.body.heroBanners;
      expect(stored.map((banner) => [banner.title, banner.sortOrder, banner.isActive])).toEqual([
        ['حراج پاییزه', 1, true],
        ['کالای دیجیتال', 2, true],
        ['پیش‌نویس', 3, false],
      ]);
      for (const banner of stored) expect(banner.id).toMatch(/^[0-9a-f-]{36}$/);

      const pub = (await publicBranding()).body.heroBanners;
      expect(pub).toEqual([
        { id: stored[0]!.id, imageUrl: assets.banner1!.url, title: 'حراج پاییزه', linkUrl: '/search?categorySlug=fashion', sortOrder: 1 },
        { id: stored[1]!.id, imageUrl: assets.banner2!.url, title: 'کالای دیجیتال', linkUrl: '/search?categorySlug=digital', sortOrder: 2 },
      ]);

      // Reorder + activate, keeping ids (what the admin UI sends).
      const reordered = await patch({
        heroBanners: [
          { ...stored[2]!, sortOrder: 0, isActive: true },
          { ...stored[1]!, sortOrder: 1 },
        ],
      });
      expect(reordered.status).toBe(200);
      expect((await publicBranding()).body.heroBanners.map((banner) => [banner.id, banner.sortOrder])).toEqual([
        [stored[2]!.id, 1],
        [stored[1]!.id, 2],
      ]);
    });

    it('serves the cache until an admin change purges it (a write that bypasses the API is not seen)', async () => {
      await publicBranding();
      await prisma.systemConfig.update({ where: { key: BRANDING_KEYS.logoUrl }, data: { value: 'https://bypass.example/logo.webp' } });
      expect((await publicBranding()).body.logoUrl).toBe(assets.logoSvg!.url);
      // Restore through the API: the purge makes the public endpoint read the DB again.
      expect((await patch({ logoUrl: assets.logo!.url })).status).toBe(200);
      expect((await publicBranding()).body.logoUrl).toBe(assets.logo!.url);
    });

    it('«حذف لوگو»: null clears the logos back to the default (stored as empty, timestamp kept)', async () => {
      const response = await patch({ logoUrl: null, mobileLogoUrl: null });
      expect(response.status).toBe(200);
      expect((await publicBranding()).body).toMatchObject({ logoUrl: null, mobileLogoUrl: null, faviconUrl: assets.favicon!.url });
      const row = await prisma.systemConfig.findUniqueOrThrow({ where: { key: BRANDING_KEYS.logoUrl } });
      expect(row.value).toBe('');
      expect((await adminBranding()).body.updatedAt.logoUrl).not.toBeNull();
    });

    it('an empty banner list removes the carousel', async () => {
      expect((await patch({ heroBanners: [] })).status).toBe(200);
      expect((await publicBranding()).body.heroBanners).toEqual([]);
    });

    it('degrades to defaults when a stored value is corrupt', async () => {
      await prisma.systemConfig.update({ where: { key: BRANDING_KEYS.heroBanners }, data: { value: '{broken' } });
      await redis.client.del(BRANDING_CACHE_KEY);
      const response = await publicBranding();
      expect(response.status).toBe(200);
      expect(response.body.heroBanners).toEqual([]);
    });
  });

  // ─── Documentation ────────────────────────────────────────────────────────

  it('documents the public and admin endpoints', () => {
    const document = buildOpenApiDocument(app) as unknown as { paths: Record<string, Record<string, { tags?: string[]; security?: unknown[] }>> };
    expect(document.paths[`${API}/branding`]?.get?.tags).toEqual(['branding']);
    expect(document.paths[`${API}/admin/branding`]?.get?.tags).toEqual(['admin-branding']);
    expect(document.paths[`${API}/admin/branding`]?.patch?.tags).toEqual(['admin-branding']);
    expect(document.paths[`${API}/admin/branding/assets`]?.post?.tags).toEqual(['admin-branding']);
  });
});
