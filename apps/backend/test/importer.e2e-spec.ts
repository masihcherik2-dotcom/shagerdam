import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import sharp from 'sharp';
import { AppModule } from '../src/app.module';
import { GLOBAL_API_PREFIX } from '../src/common/constants';
import { PrismaService } from '../src/infra/prisma/prisma.service';
import { RedisService } from '../src/infra/redis/redis.service';
import { CategoriesService } from '../src/modules/categories/categories.service';
import { normalizeIdentifier } from '../src/modules/auth/auth.service';
import { OtpKeys } from '../src/modules/auth/otp.service';
import { loginAttemptsKey, loginLockKey } from '../src/modules/auth/token.service';
import { DIGIKALA_API_ORIGIN } from '../src/modules/importer/extractors/digikala.extractor';
import {
  IMPORT_NETWORK_POLICY,
  isReservedAddress,
  PUBLIC_INTERNET_POLICY,
  type ImportNetworkPolicy,
} from '../src/modules/importer/net/address-policy';
import { EXTRACT_LIMIT, importerRateKeys } from '../src/modules/importer/product-importer.service';
import { MAX_MEDIA_PER_PRODUCT } from '../src/modules/products/product-rules';
import { SMS_PROVIDER, type SmsProvider } from '../src/modules/sms/sms-provider.interface';
import type { SandboxSmsProvider } from '../src/modules/sms/providers/sandbox-sms.provider';
import { STORAGE_PROVIDER, type StorageProvider } from '../src/modules/storage/storage-provider.interface';
import { applyGlobalPolicies } from '../src/setup/app.setup';
import { createImporterCategories, removeImporterCategories, type ImporterCategoryIds } from './support/importer-categories';

/**
 * End-to-end verification of the product importer against the real stack:
 * PostgreSQL (media assets, products, specifications, audit log), Redis
 * (per-vendor quotas, auth state), the real media pipeline (Sharp → WebP +
 * thumbnail → storage provider) and the real vendor onboarding flow.
 *
 * Remote sites are replaced by a local HTTP server that serves captured
 * Digikala API responses and a WooCommerce page (test/fixtures/importer). To
 * reach it, the suite swaps the network policy — the only test seam — for one
 * that has a "fixture mode" switch:
 *
 *   - fixture mode ON: the production reserved-address rules, plus exactly
 *     127.0.0.1 on the fixture port, and `*.fixture.test` resolving to it;
 *   - fixture mode OFF: behaves exactly like PUBLIC_INTERNET_POLICY. All SSRF
 *     assertions run in this mode, i.e. against the production policy.
 */

const TEST_UA = 'shopino-importer-e2e/1.0';
const RUN = Date.now().toString(36);
const TAG = RUN.toUpperCase();

const VENDOR_MOBILE = '+989971190001';
const PENDING_VENDOR_MOBILE = '+989971190002';
const CUSTOMER_MOBILE = '+989971190003';
const SUITE_MOBILES = [VENDOR_MOBILE, PENDING_VENDOR_MOBILE, CUSTOMER_MOBILE];
const IBANS = ['IR820540102680020817909002', 'IR570629600000001003242001'];
const SEEDED_ADMIN_EMAIL = 'admin@shopino.local';

const FIXTURES = join(__dirname, 'fixtures/importer');

interface HttpResult<T> {
  status: number;
  body: T;
}

interface ExtractResponse {
  source: 'DIGIKALA' | 'GENERIC';
  strategies: string[];
  sourceUrl: string;
  sourceProductId: string | null;
  title: string;
  titleEn: string | null;
  brand: string | null;
  description: string | null;
  suggestedCategory: string | null;
  suggestedCategoryId: string | null;
  specifications: Array<{ group: string | null; title: string; value: string }>;
  imageUrls: string[];
}

interface IngestResponse {
  items: Array<{ sourceUrl: string; id: string; url: string; thumbnailUrl: string; width: number; height: number; sizeBytes: number }>;
  failures: Array<{ sourceUrl: string; code: string; message: string }>;
}

interface ErrorBody {
  statusCode: number;
  code?: string;
  message: string | string[];
}

// ─── Fixture network ────────────────────────────────────────────────────────

const network = { fixtureMode: true, port: 0 };

const fixturePolicy: ImportNetworkPolicy = {
  isBlockedAddress: (address) =>
    network.fixtureMode ? address !== '127.0.0.1' && isReservedAddress(address) : PUBLIC_INTERNET_POLICY.isBlockedAddress(address),
  isAllowedPort: (port) =>
    PUBLIC_INTERNET_POLICY.isAllowedPort(port) || (network.fixtureMode && port === network.port),
  resolve: (hostname) => {
    if (network.fixtureMode && hostname === 'evil.fixture.test') return Promise.resolve([{ address: '10.0.0.7', family: 4 as const }]);
    if (network.fixtureMode && hostname.endsWith('.fixture.test')) return Promise.resolve([{ address: '127.0.0.1', family: 4 as const }]);
    return PUBLIC_INTERNET_POLICY.resolve(hostname);
  },
};

let fixtureServer: Server;
const shopOrigin = (): string => `http://shop.fixture.test:${network.port}`;

async function startFixtureServer(): Promise<void> {
  const digikala = (id: string): string => readFileSync(join(FIXTURES, `digikala-dkp-${id}.json`), 'utf8');
  const frontJpeg = await sharp({ create: { width: 1800, height: 1200, channels: 3, background: { r: 200, g: 40, b: 40 } } })
    .jpeg({ quality: 90 })
    .toBuffer();
  const backPng = await sharp({ create: { width: 640, height: 640, channels: 4, background: { r: 30, g: 90, b: 200, alpha: 1 } } })
    .png()
    .toBuffer();

  fixtureServer = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    const send = (status: number, type: string, body: string | Buffer): void => {
      res.writeHead(status, { 'content-type': type });
      res.end(body);
    };
    switch (path) {
      case '/v2/product/13196935/':
        return send(200, 'application/json', digikala('13196935'));
      case '/v2/product/18010600/':
        return send(200, 'application/json', digikala('18010600'));
      case '/v2/product/999999/':
        return send(404, 'application/json', '{"status":404}');
      case '/product/redmi-note-13/':
        // The captured page references https://shop.fixture.test; serve it from this server instead.
        return send(
          200,
          'text/html; charset=UTF-8',
          readFileSync(join(FIXTURES, 'woocommerce-product.html'), 'utf8')
            .replaceAll('https://shop.fixture.test', shopOrigin())
            .replaceAll('https:\\/\\/shop.fixture.test', shopOrigin().replaceAll('/', '\\/')),
        );
      case '/wp-content/uploads/2026/01/redmi-note-13-front.jpg':
        return send(200, 'image/jpeg', frontJpeg);
      case '/wp-content/uploads/2026/01/redmi-note-13-back.jpg':
        return send(200, 'image/png', backPng);
      case '/images/not-an-image.jpg':
        return send(200, 'image/jpeg', '<html>this is not an image</html>');
      case '/about/':
        return send(200, 'text/html', '<html><head><title>About us</title></head><body>Hello</body></html>');
      case '/redirect-to-metadata':
        res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
        return res.end();
      default:
        return send(404, 'text/html', 'not found');
    }
  });
  await new Promise<void>((resolve) => fixtureServer.listen(0, '127.0.0.1', resolve));
  network.port = (fixtureServer.address() as AddressInfo).port;
}

// ─── Suite ──────────────────────────────────────────────────────────────────

describe('Product importer — extract-spec, ingest-images, create (live stack)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let redis: RedisService;
  let storage: StorageProvider;

  let adminToken: string;
  let vendor: { token: string; userId: string; vendorId: string };
  let pending: { token: string; userId: string };
  let customer: { token: string; userId: string };
  let categoryIds: ImporterCategoryIds;

  const API = `/${GLOBAL_API_PREFIX}`;

  const request = async <T>(
    url: string,
    options: { method?: 'GET' | 'POST'; token?: string; body?: unknown; form?: FormData } = {},
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
    const response = await app.inject({ method: options.method ?? 'GET', url: `${API}${url}`, headers, ...(payload === undefined ? {} : { payload }) });
    return { status: response.statusCode, body: response.body.length > 0 ? (JSON.parse(response.body) as T) : (undefined as T) };
  };

  const extract = (url: string, token = vendor.token): Promise<HttpResult<ExtractResponse & ErrorBody>> =>
    request('/vendor/products/import/extract-spec', { method: 'POST', token, body: { url } });
  const ingest = (imageUrls: string[], token = vendor.token): Promise<HttpResult<IngestResponse & ErrorBody>> =>
    request('/vendor/products/import/ingest-images', { method: 'POST', token, body: { imageUrls } });

  const loginWithOtp = async (mobile: string): Promise<{ token: string; userId: string }> => {
    expect((await request('/auth/otp/request', { method: 'POST', body: { mobile } })).status).toBe(200);
    const code = (app.get<SmsProvider>(SMS_PROVIDER) as SandboxSmsProvider).latestOtpCode(mobile);
    const verified = await request<{ accessToken: string; user: { id: string } }>('/auth/otp/verify', { method: 'POST', body: { mobile, code } });
    expect(verified.status).toBe(200);
    return { token: verified.body.accessToken, userId: verified.body.user.id };
  };

  const registerStore = async (token: string, storeSlug: string, iban: string): Promise<string> => {
    const response = await request<{ id: string }>('/vendors/register', {
      method: 'POST',
      token,
      body: { storeName: `فروشگاه آزمون واردکننده ${storeSlug}`, storeSlug, bio: 'فروشگاه آزمون واردکردن کالا', bankIban: iban, bankAccountHolder: 'شرکت آزمون' },
    });
    expect(response.status).toBe(201);
    return response.body.id;
  };

  async function resetKeys(): Promise<void> {
    const keys = [
      ...(await redis.client.keys('auth:otp:hourly:ip:*')),
      ...SUITE_MOBILES.flatMap((mobile) => [
        OtpKeys.challenge(mobile),
        OtpKeys.lock(mobile),
        OtpKeys.cooldown(mobile),
        OtpKeys.hourlyByMobile(mobile),
        loginAttemptsKey(normalizeIdentifier(mobile)),
        loginLockKey(normalizeIdentifier(mobile)),
      ]),
      loginAttemptsKey(normalizeIdentifier(SEEDED_ADMIN_EMAIL)),
      loginLockKey(normalizeIdentifier(SEEDED_ADMIN_EMAIL)),
      ...(vendor ? [importerRateKeys.extract(vendor.userId), importerRateKeys.images(vendor.userId)] : []),
    ];
    if (keys.length > 0) await redis.client.del(...keys);
  }

  beforeAll(async () => {
    await startFixtureServer();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(IMPORT_NETWORK_POLICY)
      .useValue(fixturePolicy)
      .overrideProvider(DIGIKALA_API_ORIGIN)
      .useValue(`http://dk-api.fixture.test:${network.port}`)
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    applyGlobalPolicies(app, app.get(ConfigService));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    prisma = app.get(PrismaService);
    redis = app.get(RedisService);
    storage = app.get<StorageProvider>(STORAGE_PROVIDER);
    await resetKeys();

    const adminPassword = process.env['SUPER_ADMIN_PASSWORD'];
    if (adminPassword === undefined) throw new Error('This suite needs SUPER_ADMIN_PASSWORD from the root .env.');
    const admin = await request<{ accessToken: string }>('/auth/login/password', {
      method: 'POST',
      body: { identifier: SEEDED_ADMIN_EMAIL, password: adminPassword },
    });
    expect(admin.status).toBe(200);
    adminToken = admin.body.accessToken;

    const v = await loginWithOtp(VENDOR_MOBILE);
    pending = await loginWithOtp(PENDING_VENDOR_MOBILE);
    customer = await loginWithOtp(CUSTOMER_MOBILE);
    const vendorId = await registerStore(v.token, `imp-e2e-${RUN}`, IBANS[0]!);
    await registerStore(pending.token, `imp-e2e-p-${RUN}`, IBANS[1]!);

    const form = new FormData();
    const pdf = Buffer.concat([Buffer.from(`%PDF-1.7\n% importer e2e ${RUN}\n`, 'latin1'), Buffer.from('%%EOF', 'latin1')]);
    form.append('file', new Blob([new Uint8Array(pdf)], { type: 'application/pdf' }), 'national-id.pdf');
    form.append('purpose', 'kyc_national_id');
    const doc = await request<{ url: string }>('/media/upload/document', { method: 'POST', token: v.token, form });
    expect(doc.status).toBe(201);
    expect((await request('/vendors/verification/documents', { method: 'POST', token: v.token, body: { nationalIdCardUrl: doc.body.url } })).status).toBe(200);
    const approved = await request(`/admin/vendors/${vendorId}/verify`, {
      method: 'POST',
      token: adminToken,
      body: { status: 'APPROVED', rejectionReason: null },
    });
    expect(approved.status).toBe(200);
    vendor = { ...v, vendorId };

    categoryIds = await createImporterCategories(prisma, app.get(CategoriesService), RUN);
  }, 120_000);

  afterAll(async () => {
    if (prisma !== undefined) {
      const users = await prisma.user.findMany({ where: { mobile: { in: SUITE_MOBILES } }, select: { id: true } });
      const userIds = users.map((user) => user.id);
      const vendors = await prisma.vendor.findMany({ where: { userId: { in: userIds } }, select: { id: true } });
      const vendorIds = vendors.map((row) => row.id);
      const products = await prisma.product.findMany({ where: { vendorId: { in: vendorIds } }, select: { id: true } });
      const productIds = products.map((row) => row.id);

      await prisma.productMedia.deleteMany({ where: { productId: { in: productIds } } });
      await prisma.productVariant.deleteMany({ where: { productId: { in: productIds } } });
      await prisma.product.deleteMany({ where: { id: { in: productIds } } }); // specifications cascade

      const assets = await prisma.mediaAsset.findMany({ where: { ownerUserId: { in: userIds } }, select: { path: true, thumbnailPath: true } });
      for (const asset of assets) {
        await storage.delete(asset.path).catch(() => false);
        if (asset.thumbnailPath !== null) await storage.delete(asset.thumbnailPath).catch(() => false);
      }
      await prisma.auditLog.deleteMany({
        where: { OR: [{ userId: { in: userIds } }, { userAgent: TEST_UA }, { entityId: { in: [...vendorIds, ...productIds] } }] },
      });
      await prisma.vendorVerification.deleteMany({ where: { vendorId: { in: vendorIds } } });
      await prisma.vendorWallet.deleteMany({ where: { vendorId: { in: vendorIds } } });
      await prisma.mediaAsset.deleteMany({ where: { ownerUserId: { in: userIds } } });
      await prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      await removeImporterCategories(prisma, app.get(CategoriesService));
      await resetKeys();
    }
    await app?.close();
    fixtureServer?.closeAllConnections();
    await new Promise<void>((resolve) => (fixtureServer ? fixtureServer.close(() => resolve()) : resolve()));
  }, 120_000);

  // ─── Access control and validation ───────────────────────────────────────

  describe('access control', () => {
    it('requires authentication', async () => {
      const response = await request('/vendor/products/import/extract-spec', { method: 'POST', body: { url: 'https://example.com/' } });
      expect(response.status).toBe(401);
    });

    it('is closed to customers', async () => {
      expect((await extract('https://example.com/', customer.token)).status).toBe(403);
      expect((await ingest(['https://example.com/a.jpg'], customer.token)).status).toBe(403);
    });

    it('is closed to stores that are not approved yet', async () => {
      const response = await extract(`${shopOrigin()}/product/redmi-note-13/`, pending.token);
      expect(response.status).toBe(403);
    });

    it('validates the request body', async () => {
      expect((await request('/vendor/products/import/extract-spec', { method: 'POST', token: vendor.token, body: {} })).status).toBe(400);
      expect((await ingest([])).status).toBe(400);
      expect((await ingest(Array.from({ length: MAX_MEDIA_PER_PRODUCT + 1 }, (_, i) => `https://example.com/${i}.jpg`))).status).toBe(400);
    });
  });

  // ─── SSRF — production policy (fixture mode off) ─────────────────────────

  describe('SSRF protection (production network policy)', () => {
    beforeAll(() => {
      network.fixtureMode = false;
    });
    afterAll(() => {
      network.fixtureMode = true;
    });

    it.each([
      ['http://127.0.0.1:4000', 'BLOCKED_TARGET'],
      ['http://192.168.1.1', 'BLOCKED_TARGET'],
      ['http://10.0.0.1/', 'BLOCKED_TARGET'],
      ['http://172.16.0.10/', 'BLOCKED_TARGET'],
      ['http://169.254.169.254/latest/meta-data/', 'BLOCKED_TARGET'],
      ['http://localhost/', 'BLOCKED_TARGET'],
      ['http://[::1]/', 'BLOCKED_TARGET'],
      ['http://2130706433/', 'BLOCKED_TARGET'],
      ['http://postgres:5432/', 'BLOCKED_TARGET'],
      ['file:///etc/passwd', 'INVALID_URL'],
      ['gopher://example.com/', 'INVALID_URL'],
    ])('extract-spec rejects %s with 400 %s', async (url, code) => {
      const response = await extract(url);
      expect(response.status).toBe(400);
      expect(response.body.code).toBe(`IMPORT_${code}`);
    });

    it('the fixture server itself is unreachable under the production policy', async () => {
      const response = await extract(`${shopOrigin()}/product/redmi-note-13/`);
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('IMPORT_BLOCKED_TARGET');
    });

    it('ingest-images validates every URL before downloading anything', async () => {
      const before = await prisma.mediaAsset.count({ where: { ownerUserId: vendor.userId } });
      const response = await ingest(['https://example.com/a.jpg', 'http://127.0.0.1:4000/a.png', 'http://192.168.1.1/x.jpg']);
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('IMPORT_BLOCKED_TARGET');
      expect(await prisma.mediaAsset.count({ where: { ownerUserId: vendor.userId } })).toBe(before);
    });
  });

  describe('SSRF protection at connect time and on redirects', () => {
    it('refuses a public-looking name that resolves to a private address', async () => {
      const response = await extract(`http://evil.fixture.test:${network.port}/product/x/`);
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('IMPORT_BLOCKED_TARGET');
    });

    it('refuses a redirect to the cloud metadata endpoint', async () => {
      const response = await extract(`${shopOrigin()}/redirect-to-metadata`);
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('IMPORT_BLOCKED_TARGET');
    });
  });

  // ─── Extraction ───────────────────────────────────────────────────────────

  describe('extract-spec', () => {
    it('Digikala: reads title, brand, description, grouped specs and gallery through the API', async () => {
      const response = await extract('https://www.digikala.com/product/dkp-13196935/%D8%A8%D8%B1%DA%86%D8%B3%D8%A8/');
      expect(response.status).toBe(200);
      const draft = response.body;
      expect(draft.source).toBe('DIGIKALA');
      expect(draft.strategies).toEqual(['DIGIKALA_API']);
      expect(draft.sourceProductId).toBe('dkp-13196935');
      expect(draft.title).toBe('برچسب پوششی ماهوت مدل Iran Tile 11 مناسب برای گوشی موبایل هوآوی Y5 Lite');
      expect(draft.titleEn).toBe('MAHOOT Iran Tile 11 Cover Sticker for Huawei Y5 Lite');
      expect(draft.brand).toBe('ماهوت');
      expect(draft.description).toContain('ماهوت');
      expect(draft.specifications).toHaveLength(7);
      expect(draft.specifications[0]).toEqual({ group: 'مشخصات', title: 'جنس', value: 'پلی کربنات' });
      expect(draft.imageUrls).toHaveLength(4);
      // «کیف و کاور گوشی» has no local match; the breadcrumb's «کالای دیجیتال» does.
      expect(draft.suggestedCategory).toBe('کیف و کاور گوشی');
      expect(draft.suggestedCategoryId).toBe(categoryIds.digital);
    });

    it('Digikala: maps a phone to the local «گوشی موبایل» category', async () => {
      const response = await extract('https://www.digikala.com/product/dkp-18010600/');
      expect(response.status).toBe(200);
      expect(response.body.brand).toBe('سامسونگ');
      expect(response.body.suggestedCategoryId).toBe(categoryIds.mobile);
      expect(response.body.specifications).toContainEqual({ group: 'ارتباطات', title: 'شبکه‌های ارتباطی قابل پشتیبانی', value: 'Wi-Fi، بلوتوث' });
      expect(response.body.imageUrls).toHaveLength(10);
    });

    it('Digikala: an unknown product is 422 NOT_FOUND', async () => {
      const response = await extract('https://www.digikala.com/product/dkp-999999/');
      expect(response.status).toBe(422);
      expect(response.body.code).toBe('IMPORT_NOT_FOUND');
    });

    it('generic: reads a WooCommerce product page', async () => {
      const response = await extract(`${shopOrigin()}/product/redmi-note-13/`);
      expect(response.status).toBe(200);
      const draft = response.body;
      expect(draft.source).toBe('GENERIC');
      expect(draft.title).toBe('گوشی موبایل شیائومی Redmi Note 13 ظرفیت 256 گیگابایت');
      expect(draft.brand).toBe('شیائومی');
      expect(draft.suggestedCategoryId).toBe(categoryIds.mobile);
      expect(draft.specifications.map((spec) => spec.title)).toEqual(['وزن', 'حافظه RAM', 'شبکه ارتباطی', 'رنگ']);
      expect(draft.imageUrls).toEqual([
        `${shopOrigin()}/wp-content/uploads/2026/01/redmi-note-13-front.jpg`,
        `${shopOrigin()}/wp-content/uploads/2026/01/redmi-note-13-back.jpg`,
      ]);
    });

    it('generic: a page without product data is 422 NOT_A_PRODUCT', async () => {
      const response = await extract(`${shopOrigin()}/about/`);
      expect(response.status).toBe(422);
      expect(response.body.code).toBe('IMPORT_NOT_A_PRODUCT');
    });

    it('generic: a missing page is 422 NOT_FOUND', async () => {
      const response = await extract(`${shopOrigin()}/product/gone/`);
      expect(response.status).toBe(422);
      expect(response.body.code).toBe('IMPORT_NOT_FOUND');
    });

    it('writes an audit entry per extraction', async () => {
      const entries = await prisma.auditLog.findMany({ where: { userId: vendor.userId, entityName: 'ProductImport' } });
      expect(entries.length).toBeGreaterThanOrEqual(3);
    });
  });

  // ─── Full flow: extract → ingest → create ────────────────────────────────

  describe('extract → ingest-images → create product', () => {
    let draft: ExtractResponse;
    let ingested: IngestResponse;

    it('ingests remote images as WebP assets with thumbnails, reporting per-image failures', async () => {
      const extracted = await extract(`${shopOrigin()}/product/redmi-note-13/`);
      expect(extracted.status).toBe(200);
      draft = extracted.body;

      const broken = `${shopOrigin()}/images/not-an-image.jpg`;
      const missing = `${shopOrigin()}/images/missing.jpg`;
      const response = await ingest([...draft.imageUrls, broken, missing]);
      expect(response.status).toBe(200);
      ingested = response.body;

      expect(ingested.items.map((item) => item.sourceUrl)).toEqual(draft.imageUrls);
      expect(ingested.failures).toEqual([
        expect.objectContaining({ sourceUrl: broken, code: 'INVALID_IMAGE' }),
        expect.objectContaining({ sourceUrl: missing, code: 'UPSTREAM_STATUS' }),
      ]);

      const [front, back] = ingested.items;
      expect(front).toMatchObject({ width: 1600, height: 1067 }); // 1800×1200 JPEG, bounded to 1600 px
      expect(back).toMatchObject({ width: 640, height: 640 });

      for (const item of ingested.items) {
        const asset = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: item.id } });
        expect(asset).toMatchObject({ ownerUserId: vendor.userId, purpose: 'product_image', mimeType: 'image/webp', isPublic: true, kind: 'IMAGE' });
        expect(asset.url).toBe(item.url);
        expect(asset.thumbnailUrl).toBe(item.thumbnailUrl);

        const file = await storage.read(asset.path);
        expect(file.subarray(0, 4).toString('latin1')).toBe('RIFF');
        expect(file.subarray(8, 12).toString('latin1')).toBe('WEBP');
        expect(file.length).toBe(asset.sizeBytes);
        const thumbnail = await sharp(await storage.read(asset.thumbnailPath!)).metadata();
        expect(thumbnail).toMatchObject({ format: 'webp', width: 300, height: 300 });
      }
    });

    it('charges the image quota per image in Redis', async () => {
      const used = Number(await redis.client.get(importerRateKeys.images(vendor.userId)));
      expect(used).toBeGreaterThanOrEqual(4);
    });

    it('creates the product from the draft; specifications and gallery persist in PostgreSQL', async () => {
      const response = await request<{ id: string; slug: string; title: string; brand: string | null; specifications: Array<{ groupTitle: string | null; title: string; value: string }> }>(
        '/vendor/products',
        {
          method: 'POST',
          token: vendor.token,
          body: {
            title: `${draft.title} ${RUN}`,
            brand: draft.brand,
            description: draft.description,
            categoryId: draft.suggestedCategoryId,
            basePrice: 185_000_000,
            mediaIds: ingested.items.map((item) => item.id),
            specifications: draft.specifications.map((spec) => ({ groupTitle: spec.group, title: spec.title, value: spec.value })),
            isPublished: true,
            // The only data the vendor types: price, stock and variants.
            variants: [
              { sku: `IMP-${TAG}-BLK`, colorName: 'مشکی', colorHex: '#000000', price: 185_000_000, stockQuantity: 4 },
              { sku: `IMP-${TAG}-BLU`, colorName: 'آبی', colorHex: '#1E40AF', price: 187_000_000, stockQuantity: 2 },
            ],
          },
        },
      );
      expect(response.status).toBe(201);
      expect(response.body.brand).toBe('شیائومی');

      const stored = await prisma.product.findUniqueOrThrow({
        where: { id: response.body.id },
        include: { specifications: { orderBy: { sortOrder: 'asc' } }, media: { orderBy: { sortOrder: 'asc' } }, variants: true },
      });
      expect(stored.categoryId).toBe(categoryIds.mobile);
      expect(stored.specifications.map((spec) => [spec.title, spec.value, spec.sortOrder])).toEqual([
        ['وزن', '188 گرم', 10],
        ['حافظه RAM', '8 گیگابایت', 20],
        ['شبکه ارتباطی', '4G, 3G', 30],
        ['رنگ', 'مشکی، آبی', 40],
      ]);
      expect(stored.media.map((row) => row.mediaAssetId)).toEqual(ingested.items.map((item) => item.id));
      expect(stored.media[0]?.isPrimary).toBe(true);
      expect(stored.variants).toHaveLength(2);

      // The public product page shows the specification table.
      const page = await request<{ specifications: Array<{ groupTitle: string | null; title: string; value: string }> }>(`/products/${response.body.slug}`);
      expect(page.status).toBe(200);
      expect(page.body.specifications.map((spec) => spec.title)).toEqual(['وزن', 'حافظه RAM', 'شبکه ارتباطی', 'رنگ']);
    });

    it('creates a product from a Digikala draft with grouped specifications', async () => {
      const extracted = await extract('https://www.digikala.com/product/dkp-18010600/');
      const images = await ingest([`${shopOrigin()}/wp-content/uploads/2026/01/redmi-note-13-back.jpg`]);
      const response = await request<{ id: string }>('/vendor/products', {
        method: 'POST',
        token: vendor.token,
        body: {
          title: `${extracted.body.title.slice(0, 150)} ${RUN}`,
          brand: extracted.body.brand,
          description: extracted.body.description,
          categoryId: extracted.body.suggestedCategoryId,
          basePrice: 294_000_000,
          mediaIds: images.body.items.map((item) => item.id),
          specifications: extracted.body.specifications.map((spec) => ({ groupTitle: spec.group, title: spec.title, value: spec.value })),
          variants: [{ sku: `IMP-${TAG}-S24`, price: 294_000_000, stockQuantity: 1 }],
        },
      });
      expect(response.status).toBe(201);
      const specs = await prisma.productSpecification.findMany({ where: { productId: response.body.id }, orderBy: { sortOrder: 'asc' } });
      expect(specs).toHaveLength(11);
      expect(new Set(specs.map((spec) => spec.groupTitle))).toEqual(new Set(['دوربین', 'ارتباطات']));
    });
  });

  // ─── Quotas ───────────────────────────────────────────────────────────────

  describe('per-vendor quota', () => {
    it('answers 429 once the extraction quota is used up', async () => {
      await redis.client.set(importerRateKeys.extract(vendor.userId), String(EXTRACT_LIMIT), 'EX', 600);
      const response = await extract(`${shopOrigin()}/product/redmi-note-13/`);
      expect(response.status).toBe(429);
      await redis.client.del(importerRateKeys.extract(vendor.userId));
    });
  });
});
