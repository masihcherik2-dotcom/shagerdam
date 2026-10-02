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
import { BULK_DAILY_LIMIT } from '../src/modules/importer/bulk/bulk-import.service';
import { bulkKeys } from '../src/modules/importer/bulk/bulk-job.store';
import type { BulkJobMeta } from '../src/modules/importer/bulk/bulk-job.types';
import { IMPORT_NETWORK_POLICY, isReservedAddress, PUBLIC_INTERNET_POLICY, type ImportNetworkPolicy } from '../src/modules/importer/net/address-policy';
import { SMS_PROVIDER, type SmsProvider } from '../src/modules/sms/sms-provider.interface';
import type { SandboxSmsProvider } from '../src/modules/sms/providers/sandbox-sms.provider';
import { STORAGE_PROVIDER, type StorageProvider } from '../src/modules/storage/storage-provider.interface';
import { applyGlobalPolicies } from '../src/setup/app.setup';
import { createImporterCategories, removeImporterCategories, type ImporterCategoryIds } from './support/importer-categories';

/**
 * Whole-store import (sitemap crawl + background bulk job) against the real
 * stack: PostgreSQL (products, variants, media, audit), Redis (job state,
 * locks, quotas), the media pipeline (Sharp → WebP → storage) and the real
 * product service.
 *
 * The "internet" is a local fixture server: a store with robots.txt, a Yoast
 * sitemap index and product pages in the shapes the importer meets (WooCommerce
 * visible toman prices, discounts, out-of-stock, pages without price or unit, a
 * page that fails once, a 404, slow pages). As in importer.e2e-spec.ts, the
 * network policy is the only test seam.
 */

const TEST_UA = 'shopino-bulk-import-e2e/1.0';
const RUN = Date.now().toString(36);
const OWNER_MOBILE = '09971140001';
const OTHER_MOBILE = '09971140002';
const CUSTOMER_MOBILE = '+989971140003';
const SUITE_MOBILES = ['+989971140001', '+989971140002', CUSTOMER_MOBILE];
const IBANS = ['IR820540102680020817909002', 'IR570629600000001003242001'];
const SEEDED_ADMIN_EMAIL = 'admin@shopino.local';
const PASTE_MARKER = `paste-marker-${RUN}`;

const FIXTURES = join(__dirname, 'fixtures/importer');

interface HttpResult<T> {
  status: number;
  body: T;
}

interface ErrorBody {
  statusCode: number;
  code?: string;
  message: string | string[];
  jobId?: string;
}

interface CrawlResult {
  storeUrl: string;
  totalFound: number;
  productUrls: string[];
  sitemapsScanned: string[];
  warnings: string[];
}

interface BulkItem {
  index: number;
  url: string;
  status: 'PENDING' | 'PROCESSING' | 'SUCCEEDED' | 'SKIPPED' | 'NEEDS_REVIEW' | 'FAILED';
  attempts: number;
  code: string | null;
  message: string | null;
  notes: string[];
  title: string | null;
  imageUrl: string | null;
  price: number | null;
  product: { id: string; slug: string; isPublished: boolean } | null;
}

interface BulkJob {
  id: string;
  vendorId: string;
  staff: boolean;
  status: 'RUNNING' | 'COMPLETED' | 'CANCELLED' | 'INTERRUPTED';
  total: number;
  runs: number;
  options: { autoPublish: boolean; priceUnit: string; defaultStock: number; defaultCategoryId: string | null };
  counts: { pending: number; processing: number; succeeded: number; skipped: number; needsReview: number; failed: number };
  processed: number;
  progressPercent: number;
  items: BulkItem[];
}

// ─── Fixture network ────────────────────────────────────────────────────────

const network = { fixtureMode: true, port: 0 };

const fixturePolicy: ImportNetworkPolicy = {
  isBlockedAddress: (address) =>
    network.fixtureMode ? address !== '127.0.0.1' && isReservedAddress(address) : PUBLIC_INTERNET_POLICY.isBlockedAddress(address),
  isAllowedPort: (port) => PUBLIC_INTERNET_POLICY.isAllowedPort(port) || (network.fixtureMode && port === network.port),
  resolve: (hostname) => {
    if (network.fixtureMode && hostname === 'evil.fixture.test') return Promise.resolve([{ address: '10.0.0.7', family: 4 as const }]);
    if (network.fixtureMode && hostname.endsWith('.fixture.test')) return Promise.resolve([{ address: '127.0.0.1', family: 4 as const }]);
    return PUBLIC_INTERNET_POLICY.resolve(hostname);
  },
};

let fixtureServer: Server;
const shop = (): string => `http://shop.fixture.test:${network.port}`;
const hits = new Map<string, number>();

interface PageSpec {
  title: string;
  jsonLdPrice?: string;
  currency?: string;
  visible?: { price: string; old?: string; symbol: string };
  availability?: 'InStock' | 'OutOfStock';
  category?: string;
  images?: string[];
}

function productPage(spec: PageSpec): string {
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: spec.title,
    description: `توضیحات ${spec.title} برای آزمون درون‌ریزی دسته‌ای.`,
    image: (spec.images ?? []).map((path) => `${shop()}${path}`),
    brand: { '@type': 'Brand', name: 'برند آزمون' },
    ...(spec.category ? { category: spec.category } : {}),
    ...(spec.jsonLdPrice
      ? { offers: { '@type': 'Offer', price: spec.jsonLdPrice, ...(spec.currency ? { priceCurrency: spec.currency } : {}), availability: `https://schema.org/${spec.availability ?? 'InStock'}` } }
      : {}),
  };
  const amount = (value: string, symbol: string): string =>
    `<span class="woocommerce-Price-amount amount"><bdi>${value}&nbsp;<span class="woocommerce-Price-currencySymbol">${symbol}</span></bdi></span>`;
  const visible = spec.visible
    ? `<p class="price">${spec.visible.old ? `<del>${amount(spec.visible.old, spec.visible.symbol)}</del> <ins>${amount(spec.visible.price, spec.visible.symbol)}</ins>` : amount(spec.visible.price, spec.visible.symbol)}</p>
       <p class="stock ${spec.availability === 'OutOfStock' ? 'out-of-stock' : 'in-stock'}">وضعیت انبار</p>`
    : '';
  return `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><title>${spec.title} | فروشگاه آزمون</title>
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script></head>
<body><div class="product"><div class="summary entry-summary"><h1 class="product_title">${spec.title}</h1>${visible}</div></div></body></html>`;
}

const PAGES: Record<string, PageSpec> = {
  '/product/pot-24/': {
    title: `قابلمه استیل ۲۴ سانتی ${RUN}`,
    jsonLdPrice: '18500000',
    currency: 'IRR',
    visible: { price: '1,850,000', symbol: 'تومان' },
    category: 'قابلمه و تابه',
    images: ['/img/pot-front.jpg', '/img/pot-side.png'],
  },
  '/product/pan-28/': {
    title: `تابه نچسب ۲۸ سانتی ${RUN}`,
    visible: { price: '950,000', old: '1,200,000', symbol: 'تومان' },
    availability: 'OutOfStock',
    images: ['/img/pan.jpg'],
  },
  '/product/no-price/': { title: `کتری برقی بدون قیمت ${RUN}`, images: [] },
  '/product/no-unit/': { title: `سماور بدون واحد قیمت ${RUN}`, jsonLdPrice: '2400000', images: [] },
  '/product/flaky/': { title: `چای‌ساز ناپایدار ${RUN}`, jsonLdPrice: '31000000', currency: 'IRR', images: [] },
  '/product/admin-kettle/': { title: `کتری روگازی ادمین ${RUN}`, jsonLdPrice: '6500000', currency: 'IRR', images: ['/img/pan.jpg'] },
};
const SLOW_PAGES = Array.from({ length: 8 }, (_, i) => `/product/slow-${i}/`);

async function startFixtureServer(): Promise<void> {
  const jpeg = await sharp({ create: { width: 1200, height: 900, channels: 3, background: { r: 180, g: 120, b: 40 } } }).jpeg({ quality: 88 }).toBuffer();
  const png = await sharp({ create: { width: 700, height: 700, channels: 4, background: { r: 20, g: 120, b: 200, alpha: 1 } } }).png().toBuffer();
  const redmiFront = await sharp({ create: { width: 1800, height: 1200, channels: 3, background: { r: 200, g: 40, b: 40 } } }).jpeg({ quality: 90 }).toBuffer();

  fixtureServer = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]!;
    const host = (req.headers.host ?? '').split(':')[0];
    hits.set(path, (hits.get(path) ?? 0) + 1);
    const send = (status: number, type: string, body: string | Buffer): void => {
      res.writeHead(status, { 'content-type': type });
      res.end(body);
    };
    if (host !== 'shop.fixture.test') return send(404, 'text/html', 'no such site');

    const xml = (body: string): void => send(200, 'application/xml; charset=UTF-8', `<?xml version="1.0" encoding="UTF-8"?>${body}`);
    if (path === '/robots.txt') return send(200, 'text/plain', `User-agent: *\nDisallow: /wp-admin/\nSitemap: ${shop()}/sitemap_index.xml\n`);
    if (path === '/sitemap_index.xml') {
      return xml(
        `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>${shop()}/post-sitemap.xml</loc></sitemap><sitemap><loc>${shop()}/product-sitemap.xml</loc></sitemap><sitemap><loc>${shop()}/product_cat-sitemap.xml</loc></sitemap></sitemapindex>`,
      );
    }
    if (path === '/product-sitemap.xml') {
      const urls = [`${shop()}/shop/`, `${shop()}/product/redmi-note-13/`, ...Object.keys(PAGES).map((p) => `${shop()}${p}`)];
      return xml(`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((u) => `<url><loc>${u}</loc></url>`).join('')}</urlset>`);
    }
    if (path === '/post-sitemap.xml' || path === '/product_cat-sitemap.xml') {
      return xml(`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${shop()}/blog/post-1/</loc></url></urlset>`);
    }
    if (path === '/product/redmi-note-13/') {
      return send(
        200,
        'text/html; charset=UTF-8',
        readFileSync(join(FIXTURES, 'woocommerce-product.html'), 'utf8')
          .replaceAll('https://shop.fixture.test', shop())
          .replaceAll('https:\\/\\/shop.fixture.test', shop().replaceAll('/', '\\/')),
      );
    }
    if (path.startsWith('/wp-content/uploads/')) return send(200, 'image/jpeg', redmiFront);
    if (path === '/img/pot-front.jpg' || path === '/img/pan.jpg') return send(200, 'image/jpeg', jpeg);
    if (path === '/img/pot-side.png') return send(200, 'image/png', png);
    if (path === '/product/flaky/' && hits.get(path) === 1) return send(503, 'text/html', 'temporarily unavailable');
    if (path === '/product/gone/') return send(404, 'text/html', 'not found');
    const spec = PAGES[path];
    if (spec) return send(200, 'text/html; charset=UTF-8', productPage(spec));
    if (SLOW_PAGES.includes(path)) {
      setTimeout(() => send(200, 'text/html; charset=UTF-8', productPage({ title: `کالای کند شماره ${path.slice(-2, -1)} ${RUN}`, jsonLdPrice: '1000000', currency: 'IRR' })), 700);
      return;
    }
    return send(404, 'text/html', 'not found');
  });
  await new Promise<void>((resolve) => fixtureServer.listen(0, '127.0.0.1', resolve));
  network.port = (fixtureServer.address() as AddressInfo).port;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ─── Suite ──────────────────────────────────────────────────────────────────

describe('Whole-store import — crawl-store, bulk-extract, jobs (live stack)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let redis: RedisService;
  let storage: StorageProvider;

  let adminToken: string;
  let owner: { token: string; userId: string; vendorId: string };
  let other: { token: string; userId: string; vendorId: string };
  let customerToken: string;
  let categoryIds: ImporterCategoryIds;
  let firstJobId: string;

  const API = `/${GLOBAL_API_PREFIX}`;
  const VENDOR_BASE = '/vendor/products/import';

  const request = async <T>(url: string, options: { method?: 'GET' | 'POST'; token?: string; body?: unknown } = {}): Promise<HttpResult<T>> => {
    const headers: Record<string, string> = { 'user-agent': TEST_UA };
    if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
    let payload: string | undefined;
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(options.body);
    }
    const response = await app.inject({ method: options.method ?? 'GET', url: `${API}${url}`, headers, ...(payload === undefined ? {} : { payload }) });
    return { status: response.statusCode, body: response.body.length > 0 ? (JSON.parse(response.body) as T) : (undefined as T) };
  };

  const waitForJob = async (jobId: string, token: string, base = VENDOR_BASE): Promise<BulkJob> => {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const response = await request<BulkJob>(`${base}/bulk-jobs/${jobId}`, { token });
      expect(response.status).toBe(200);
      if (response.body.status !== 'RUNNING') return response.body;
      await sleep(150);
    }
    throw new Error(`Job ${jobId} did not finish`);
  };

  const itemFor = (job: BulkJob, path: string): BulkItem => {
    const item = job.items.find((entry) => entry.url === `${shop()}${path}`);
    if (!item) throw new Error(`No item for ${path}`);
    return item;
  };

  const loginWithOtp = async (mobile: string): Promise<{ token: string; userId: string }> => {
    expect((await request('/auth/otp/request', { method: 'POST', body: { mobile } })).status).toBe(200);
    const code = (app.get<SmsProvider>(SMS_PROVIDER) as SandboxSmsProvider).latestOtpCode(mobile);
    const verified = await request<{ accessToken: string; user: { id: string } }>('/auth/otp/verify', { method: 'POST', body: { mobile, code } });
    expect(verified.status).toBe(200);
    return { token: verified.body.accessToken, userId: verified.body.user.id };
  };

  const createStore = async (mobile: string, slug: string, iban: string): Promise<{ token: string; userId: string; vendorId: string }> => {
    const created = await request<{ profile: { id: string } }>('/admin/vendors', {
      method: 'POST',
      token: adminToken,
      body: { storeName: `فروشگاه آزمون درون‌ریزی ${slug}`, storeSlug: slug, ownerMobile: mobile, ownerFullName: 'مالک آزمون دسته‌ای', bankIban: iban },
    });
    expect(created.status).toBe(201);
    const login = await loginWithOtp(`+98${mobile.slice(1)}`);
    return { ...login, vendorId: created.body.profile.id };
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
    ];
    for (const store of [owner, other]) {
      if (store === undefined) continue;
      keys.push(bulkKeys.latest(store.vendorId), bulkKeys.active(store.vendorId), bulkKeys.daily(store.vendorId), bulkKeys.crawl(store.vendorId));
    }
    keys.push(...(await redis.client.keys(`importer:bulk:job:*`)).filter(Boolean));
    if (keys.length > 0) await redis.client.del(...keys);
  }

  beforeAll(async () => {
    await startFixtureServer();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(IMPORT_NETWORK_POLICY).useValue(fixturePolicy).compile();
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
    const admin = await request<{ accessToken: string }>('/auth/login/password', { method: 'POST', body: { identifier: SEEDED_ADMIN_EMAIL, password: adminPassword } });
    expect(admin.status).toBe(200);
    adminToken = admin.body.accessToken;

    owner = await createStore(OWNER_MOBILE, `e2e-bulk-${RUN}`, IBANS[0]!);
    other = await createStore(OTHER_MOBILE, `e2e-bulk-o-${RUN}`, IBANS[1]!);
    customerToken = (await loginWithOtp(CUSTOMER_MOBILE)).token;

    categoryIds = await createImporterCategories(prisma, app.get(CategoriesService), RUN);
  }, 120_000);

  afterAll(async () => {
    if (prisma !== undefined) {
      // Let background jobs settle before removing their data.
      for (let i = 0; i < 50 && ((await redis.client.exists(bulkKeys.active(owner?.vendorId ?? '-'))) === 1 || (await redis.client.exists(bulkKeys.active(other?.vendorId ?? '-'))) === 1); i += 1) {
        await sleep(200);
      }
      const users = await prisma.user.findMany({ where: { mobile: { in: SUITE_MOBILES } }, select: { id: true } });
      const userIds = users.map((user) => user.id);
      const vendors = await prisma.vendor.findMany({ where: { userId: { in: userIds } }, select: { id: true } });
      const vendorIds = vendors.map((row) => row.id);
      const products = await prisma.product.findMany({ where: { vendorId: { in: vendorIds } }, select: { id: true } });
      const productIds = products.map((row) => row.id);
      await prisma.productMedia.deleteMany({ where: { productId: { in: productIds } } });
      await prisma.productVariant.deleteMany({ where: { productId: { in: productIds } } });
      await prisma.product.deleteMany({ where: { id: { in: productIds } } });
      const assets = await prisma.mediaAsset.findMany({ where: { ownerUserId: { in: userIds } }, select: { path: true, thumbnailPath: true } });
      for (const asset of assets) {
        await storage.delete(asset.path).catch(() => false);
        if (asset.thumbnailPath !== null) await storage.delete(asset.thumbnailPath).catch(() => false);
      }
      await prisma.auditLog.deleteMany({ where: { OR: [{ userId: { in: userIds } }, { userAgent: TEST_UA }, { userAgent: { startsWith: 'shagerdam-bulk-importer' } }, { entityId: { in: [...vendorIds, ...productIds] } }] } });
      await prisma.mediaAsset.deleteMany({ where: { ownerUserId: { in: userIds } } });
      await prisma.vendorWallet.deleteMany({ where: { vendorId: { in: vendorIds } } });
      await prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      await removeImporterCategories(prisma, app.get(CategoriesService));
      await resetKeys();
    }
    await app?.close();
    fixtureServer?.closeAllConnections();
    await new Promise<void>((resolve) => (fixtureServer ? fixtureServer.close(() => resolve()) : resolve()));
  }, 120_000);

  // ─── Access ──────────────────────────────────────────────────────────────

  describe('access control', () => {
    it('requires a vendor (or staff) token', async () => {
      expect((await request(`${VENDOR_BASE}/crawl-store`, { method: 'POST', body: { storeUrl: shop() } })).status).toBe(401);
      expect((await request(`${VENDOR_BASE}/crawl-store`, { method: 'POST', token: customerToken, body: { storeUrl: shop() } })).status).toBe(403);
      expect((await request(`${VENDOR_BASE}/bulk-jobs/latest`, { token: customerToken })).status).toBe(403);
      expect((await request(`/admin/vendors/${owner.vendorId}/products/import/bulk-jobs/latest`, { token: owner.token })).status).toBe(403);
    });

    it('has no job before the first import', async () => {
      const latest = await request<{ job: BulkJob | null }>(`${VENDOR_BASE}/bulk-jobs/latest`, { token: owner.token });
      expect(latest).toEqual({ status: 200, body: { job: null } });
    });
  });

  // ─── Crawl ───────────────────────────────────────────────────────────────

  describe('POST crawl-store', () => {
    it('discovers product pages via robots.txt → sitemap index → product sitemap', async () => {
      hits.clear();
      const response = await request<CrawlResult>(`${VENDOR_BASE}/crawl-store`, { method: 'POST', token: owner.token, body: { storeUrl: shop() } });
      expect(response.status).toBe(200);
      expect(response.body.storeUrl).toBe(`${shop()}/`);
      expect(response.body.productUrls).toEqual([`${shop()}/product/redmi-note-13/`, ...Object.keys(PAGES).map((path) => `${shop()}${path}`)]);
      expect(response.body.totalFound).toBe(response.body.productUrls.length);
      expect(response.body.sitemapsScanned).toEqual([`${shop()}/sitemap_index.xml`, `${shop()}/product-sitemap.xml`]);
      expect(hits.has('/post-sitemap.xml')).toBe(false);
      expect(hits.has('/product_cat-sitemap.xml')).toBe(false);
    });

    it('honours maxProducts', async () => {
      const response = await request<CrawlResult>(`${VENDOR_BASE}/crawl-store`, { method: 'POST', token: owner.token, body: { storeUrl: shop(), maxProducts: 2 } });
      expect(response.status).toBe(200);
      expect(response.body.productUrls).toEqual([`${shop()}/product/redmi-note-13/`, `${shop()}/product/pot-24/`]);
      // The whole product sitemap was read: totalFound counts every product page in it.
      expect(response.body.totalFound).toBe(1 + Object.keys(PAGES).length);
    });

    it('parses pasted sitemap content without contacting the store; the audit row keeps only a bounded excerpt', async () => {
      hits.clear();
      const pasted = `<!-- ${PASTE_MARKER} --><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${shop()}/قابلمه-مسی/</loc></url><url><loc>${shop()}/product/pot-24/</loc></url></urlset>`;
      const response = await request<CrawlResult>(`${VENDOR_BASE}/crawl-store`, { method: 'POST', token: owner.token, body: { storeUrl: shop(), sitemapContent: pasted } });
      expect(response.status).toBe(200);
      // The pot page has a product path; the pasted list is filtered to it.
      expect(response.body.productUrls).toEqual([`${shop()}/product/pot-24/`]);
      expect(response.body.sitemapsScanned).toEqual(['(pasted)']);
      expect(hits.size).toBe(0);

      const audit = await prisma.auditLog.findFirst({ where: { userId: owner.userId, entityName: 'ProductImport' }, orderBy: { createdAt: 'desc' }, select: { newValue: true } });
      expect(audit?.newValue).toMatchObject({ result: { pastedContentLength: pasted.length, totalFound: 1, returned: 1 } });

      // A large paste (≈ 400 KB, 4,000 links): parsed in full, audited as a 2,000-character excerpt.
      const links = Array.from({ length: 4000 }, (_, i) => `${shop()}/product/bulk-paste-${i}-${'x'.repeat(40)}/`);
      const big = `${PASTE_MARKER}\n${links.join('\n')}`;
      expect(big.length).toBeGreaterThan(300_000);
      const large = await request<CrawlResult>(`${VENDOR_BASE}/crawl-store`, { method: 'POST', token: owner.token, body: { sitemapContent: big } });
      expect(large.status).toBe(200);
      expect(large.body).toMatchObject({ totalFound: 4000 });
      expect(large.body.productUrls).toHaveLength(200);
      const bigAudit = await prisma.auditLog.findFirst({ where: { userId: owner.userId, entityName: 'ProductImport' }, orderBy: { createdAt: 'desc' }, select: { newValue: true } });
      const stored = (bigAudit?.newValue as { request: { sitemapContent: string }; result: { pastedContentLength: number } }) ?? null;
      expect(stored.result.pastedContentLength).toBe(big.length);
      expect(stored.request.sitemapContent.length).toBe(2000);
    });

    it('accepts a pasted plain list of links', async () => {
      const response = await request<CrawlResult>(`${VENDOR_BASE}/crawl-store`, {
        method: 'POST',
        token: owner.token,
        body: { sitemapContent: `${shop()}/کتری-برقی/\n${shop()}/product/pan-28/\n${shop()}/کتری-برقی/` },
      });
      expect(response.status).toBe(200);
      expect(response.body.productUrls).toEqual([`${shop()}/${encodeURI('کتری-برقی')}/`, `${shop()}/product/pan-28/`]);
    });

    it('explains when a site has no readable sitemap (422) and validates input (400)', async () => {
      const empty = await request<ErrorBody>(`${VENDOR_BASE}/crawl-store`, { method: 'POST', token: owner.token, body: { storeUrl: `http://empty.fixture.test:${network.port}` } });
      expect(empty.status).toBe(422);
      expect(empty.body.code).toBe('IMPORT_NO_PRODUCTS_FOUND');
      expect((await request(`${VENDOR_BASE}/crawl-store`, { method: 'POST', token: owner.token, body: {} })).status).toBe(400);
      expect((await request(`${VENDOR_BASE}/crawl-store`, { method: 'POST', token: owner.token, body: { storeUrl: shop(), maxProducts: 500 } })).status).toBe(400);
    });

    it('refuses internal targets (SSRF)', async () => {
      network.fixtureMode = false;
      try {
        for (const storeUrl of ['http://127.0.0.1/', 'http://169.254.169.254/latest/', 'http://redis:6379/', 'http://localhost/']) {
          const response = await request<ErrorBody>(`${VENDOR_BASE}/crawl-store`, { method: 'POST', token: owner.token, body: { storeUrl } });
          expect(response.status).toBe(400);
          expect(response.body.code).toBe('IMPORT_BLOCKED_TARGET');
        }
      } finally {
        network.fixtureMode = true;
      }
      const rebinding = await request<ErrorBody>(`${VENDOR_BASE}/crawl-store`, { method: 'POST', token: owner.token, body: { storeUrl: `http://evil.fixture.test:${network.port}` } });
      expect(rebinding.status).toBe(400);
      expect(rebinding.body.code).toBe('IMPORT_BLOCKED_TARGET');
    });
  });

  // ─── Bulk job ────────────────────────────────────────────────────────────

  describe('POST bulk-extract + GET bulk-jobs', () => {
    it('validates the request', async () => {
      const bad = async (body: unknown): Promise<HttpResult<ErrorBody>> => request<ErrorBody>(`${VENDOR_BASE}/bulk-extract`, { method: 'POST', token: owner.token, body });
      expect((await bad({ urls: [] })).status).toBe(400);
      expect((await bad({ urls: Array.from({ length: 201 }, (_, i) => `${shop()}/product/x-${i}/`) })).status).toBe(400);
      expect((await bad({ urls: [`${shop()}/product/pot-24/`], priceUnit: 'USD' })).status).toBe(400);
      expect((await bad({ urls: [`${shop()}/product/pot-24/`], defaultStock: -1 })).status).toBe(400);
      const internal = await bad({ urls: [`${shop()}/product/pot-24/`, 'http://169.254.169.254/latest/meta-data/'] });
      expect(internal.status).toBe(400);
      expect(internal.body.code).toBe('BULK_INVALID_URL');
      const category = await bad({ urls: [`${shop()}/product/pot-24/`], defaultCategoryId: '00000000-0000-4000-8000-000000000000' });
      expect(category.status).toBe(400);
    });

    it('runs a job in the background: products created, reviews and failures reported per item', async () => {
      hits.clear();
      const urls = ['/product/redmi-note-13/', '/product/pot-24/', '/product/pan-28/', '/product/no-price/', '/product/flaky/', '/product/gone/', '/product/no-unit/'].map((path) => `${shop()}${path}`);
      const started = await request<{ jobId: string; totalProducts: number }>(`${VENDOR_BASE}/bulk-extract`, {
        method: 'POST',
        token: owner.token,
        body: { urls: [...urls, urls[1]], storeUrl: shop(), autoPublish: true, defaultStock: 5, defaultCategoryId: categoryIds.digital },
      });
      expect(started.status).toBe(202);
      expect(started.body.totalProducts).toBe(7); // duplicate dropped
      firstJobId = started.body.jobId;

      // One running job per store.
      const second = await request<ErrorBody>(`${VENDOR_BASE}/bulk-extract`, { method: 'POST', token: owner.token, body: { urls: [urls[0]] } });
      expect(second.status).toBe(409);
      expect(second.body).toMatchObject({ code: 'BULK_JOB_RUNNING', jobId: firstJobId });

      const job = await waitForJob(firstJobId, owner.token);
      expect(job.status).toBe('COMPLETED');
      expect(job.counts).toEqual({ pending: 0, processing: 0, succeeded: 3, skipped: 0, needsReview: 2, failed: 2 });
      expect(job.progressPercent).toBe(100);
      expect(job.options).toEqual({ autoPublish: true, priceUnit: 'AUTO', defaultStock: 5, defaultCategoryId: categoryIds.digital });

      // WooCommerce fixture: visible 18,500,000 تومان → 185,000,000 IRR; category matched by name, not the default.
      const redmi = itemFor(job, '/product/redmi-note-13/');
      expect(redmi).toMatchObject({ status: 'SUCCEEDED', price: 185_000_000 });
      const redmiRow = await prisma.product.findUniqueOrThrow({ where: { id: redmi.product!.id }, select: { categoryId: true, isPublished: true, vendorId: true } });
      expect(redmiRow).toEqual({ categoryId: categoryIds.mobile, isPublished: true, vendorId: owner.vendorId });

      // Pot: two images through the media pipeline, owned by the store owner; default category; stock 5.
      const pot = itemFor(job, '/product/pot-24/');
      expect(pot).toMatchObject({ status: 'SUCCEEDED', price: 18_500_000, message: null, notes: [] });
      expect(pot.imageUrl).toMatch(/_thumb\.webp$/);
      const potRow = await prisma.product.findUniqueOrThrow({
        where: { id: pot.product!.id },
        select: { categoryId: true, brand: true, variants: { select: { sku: true, price: true, stockQuantity: true } }, media: { select: { mediaAsset: { select: { ownerUserId: true, mimeType: true } } } } },
      });
      expect(potRow.categoryId).toBe(categoryIds.digital);
      expect(potRow.brand).toBe('برند آزمون');
      expect(potRow.variants).toHaveLength(1);
      expect(potRow.variants[0]).toMatchObject({ stockQuantity: 5 });
      expect(potRow.variants[0]!.sku).toMatch(/^IMP-[0-9A-F]{16}$/);
      expect(Number(potRow.variants[0]!.price)).toBe(18_500_000);
      expect(potRow.media).toHaveLength(2);
      expect(potRow.media.every((row) => row.mediaAsset?.ownerUserId === owner.userId && row.mediaAsset?.mimeType === 'image/webp')).toBe(true);

      // Pan: discount kept as compare-at price, out of stock → 0.
      const pan = itemFor(job, '/product/pan-28/');
      expect(pan).toMatchObject({ status: 'SUCCEEDED', price: 9_500_000 });
      expect(pan.message).toContain('out of stock');
      expect(pan.notes).toEqual(['OUT_OF_STOCK']);
      const panVariant = await prisma.productVariant.findFirstOrThrow({ where: { productId: pan.product!.id }, select: { compareAtPrice: true, stockQuantity: true } });
      expect(Number(panVariant.compareAtPrice)).toBe(12_000_000);
      expect(panVariant.stockQuantity).toBe(0);

      expect(itemFor(job, '/product/no-price/')).toMatchObject({ status: 'NEEDS_REVIEW', code: 'NO_PRICE', product: null });
      expect(itemFor(job, '/product/no-unit/')).toMatchObject({ status: 'NEEDS_REVIEW', code: 'UNKNOWN_CURRENCY' });
      expect(itemFor(job, '/product/flaky/')).toMatchObject({ status: 'FAILED', code: 'IMPORT_UPSTREAM_STATUS' });
      expect(itemFor(job, '/product/gone/')).toMatchObject({ status: 'FAILED', code: 'IMPORT_NOT_FOUND' });

      // Product audit rows name the vendor as actor.
      const audit = await prisma.auditLog.findFirst({ where: { entityName: 'Product', entityId: pot.product!.id }, select: { userId: true } });
      expect(audit?.userId).toBe(owner.userId);
    }, 90_000);

    it('shows the latest job again (window closed and reopened)', async () => {
      const latest = await request<{ job: BulkJob }>(`${VENDOR_BASE}/bulk-jobs/latest`, { token: owner.token });
      expect(latest.status).toBe(200);
      expect(latest.body.job.id).toBe(firstJobId);
      expect(latest.body.job.items).toHaveLength(7);
      expect(JSON.stringify(latest.body)).not.toContain('ownerUserId');
    });

    it('retries failed and needs-review items with new options, without touching created products', async () => {
      const retried = await request<BulkJob>(`${VENDOR_BASE}/bulk-jobs/${firstJobId}/retry`, { method: 'POST', token: owner.token, body: { priceUnit: 'IRT' } });
      expect(retried.status).toBe(202);
      expect(retried.body.options.priceUnit).toBe('IRT');
      const job = await waitForJob(firstJobId, owner.token);
      expect(job).toMatchObject({ status: 'COMPLETED', runs: 2 });
      expect(job.counts).toEqual({ pending: 0, processing: 0, succeeded: 5, skipped: 0, needsReview: 1, failed: 1 });
      expect(itemFor(job, '/product/flaky/')).toMatchObject({ status: 'SUCCEEDED', attempts: 2, price: 310_000_000 });
      // No unit on the page + the user's statement "toman" → ×10.
      expect(itemFor(job, '/product/no-unit/')).toMatchObject({ status: 'SUCCEEDED', price: 24_000_000 });
      expect(itemFor(job, '/product/pot-24/').attempts).toBe(1);
      expect(await prisma.product.count({ where: { vendorId: owner.vendorId } })).toBe(5);

      const nothing = await request<ErrorBody>(`${VENDOR_BASE}/bulk-jobs/${firstJobId}/retry`, { method: 'POST', token: owner.token, body: { itemIndexes: [itemFor(job, '/product/pot-24/').index] } });
      expect(nothing.status).toBe(400);
      expect(nothing.body.code).toBe('BULK_NOTHING_TO_RETRY');
    }, 90_000);

    it('never imports the same page twice into a store', async () => {
      const started = await request<{ jobId: string }>(`${VENDOR_BASE}/bulk-extract`, { method: 'POST', token: owner.token, body: { urls: [`${shop()}/product/pot-24/`] } });
      expect(started.status).toBe(202);
      const job = await waitForJob(started.body.jobId, owner.token);
      expect(job.items[0]).toMatchObject({ status: 'SKIPPED', code: 'ALREADY_IMPORTED' });
      expect(await prisma.product.count({ where: { vendorId: owner.vendorId } })).toBe(5);
    });

    it('cancels a running job and resumes it later', async () => {
      const started = await request<{ jobId: string }>(`${VENDOR_BASE}/bulk-extract`, { method: 'POST', token: owner.token, body: { urls: SLOW_PAGES.map((path) => `${shop()}${path}`), defaultCategoryId: categoryIds.digital } });
      expect(started.status).toBe(202);
      const cancel = await request<BulkJob>(`${VENDOR_BASE}/bulk-jobs/${started.body.jobId}/cancel`, { method: 'POST', token: owner.token });
      expect(cancel.status).toBe(200);
      const cancelled = await waitForJob(started.body.jobId, owner.token);
      expect(cancelled.status).toBe('CANCELLED');
      expect(cancelled.counts.processing).toBe(0);
      expect(cancelled.counts.pending).toBeGreaterThan(0);
      expect(cancelled.counts.succeeded + cancelled.counts.pending).toBe(8);

      const again = await request<ErrorBody>(`${VENDOR_BASE}/bulk-jobs/${started.body.jobId}/cancel`, { method: 'POST', token: owner.token });
      expect(again.status).toBe(409);

      expect((await request(`${VENDOR_BASE}/bulk-jobs/${started.body.jobId}/retry`, { method: 'POST', token: owner.token, body: {} })).status).toBe(202);
      const resumed = await waitForJob(started.body.jobId, owner.token);
      expect(resumed.status).toBe('COMPLETED');
      expect(resumed.counts.succeeded).toBe(8);
      expect(resumed.items.every((item) => item.message === 'no image could be imported' && item.notes.join() === 'NO_IMAGE')).toBe(true);
    }, 90_000);

    it('reports a job whose runner died as INTERRUPTED and resumes it without duplicates', async () => {
      // Simulate a crashed API instance: RUNNING with a stale heartbeat and an item caught mid-flight.
      const meta = JSON.parse((await redis.client.get(bulkKeys.meta(firstJobId)))!) as BulkJobMeta;
      await redis.client.set(bulkKeys.meta(firstJobId), JSON.stringify({ ...meta, status: 'RUNNING', finishedAt: null, heartbeatAt: new Date(Date.now() - 120_000).toISOString() }));
      const itemsRaw = await redis.client.hgetall(bulkKeys.items(firstJobId));
      const potEntry = Object.values(itemsRaw).map((raw) => JSON.parse(raw) as BulkItem).find((item) => item.url.endsWith('/product/pot-24/'))!;
      await redis.client.hset(bulkKeys.items(firstJobId), String(potEntry.index), JSON.stringify({ ...potEntry, status: 'PROCESSING' }));

      const seen = await request<BulkJob>(`${VENDOR_BASE}/bulk-jobs/${firstJobId}`, { token: owner.token });
      expect(seen.body.status).toBe('INTERRUPTED');
      expect(seen.body.items[potEntry.index]).toMatchObject({ status: 'PENDING', code: 'INTERRUPTED' });

      expect((await request(`${VENDOR_BASE}/bulk-jobs/${firstJobId}/retry`, { method: 'POST', token: owner.token, body: { itemIndexes: [potEntry.index] } })).status).toBe(202);
      const resumed = await waitForJob(firstJobId, owner.token);
      expect(resumed.status).toBe('COMPLETED');
      expect(resumed.items[potEntry.index]).toMatchObject({ status: 'SKIPPED', code: 'ALREADY_IMPORTED', product: { id: potEntry.product!.id } });
    }, 60_000);

    it('enforces the daily limit for vendors', async () => {
      await redis.client.set(bulkKeys.daily(owner.vendorId), String(BULK_DAILY_LIMIT - 1), 'EX', 3600);
      const over = await request<ErrorBody>(`${VENDOR_BASE}/bulk-extract`, { method: 'POST', token: owner.token, body: { urls: [`${shop()}/product/a-1/`, `${shop()}/product/a-2/`] } });
      expect(over.status).toBe(429);
      expect(Number(await redis.client.get(bulkKeys.daily(owner.vendorId)))).toBe(BULK_DAILY_LIMIT - 1); // refunded
      expect(await redis.client.exists(bulkKeys.active(owner.vendorId))).toBe(0); // slot released
    });

    it('keeps jobs private to their store', async () => {
      expect((await request(`${VENDOR_BASE}/bulk-jobs/${firstJobId}`, { token: other.token })).status).toBe(404);
      expect((await request(`${VENDOR_BASE}/bulk-jobs/${firstJobId}/retry`, { method: 'POST', token: other.token, body: {} })).status).toBe(404);
      expect((await request<{ job: null }>(`${VENDOR_BASE}/bulk-jobs/latest`, { token: other.token })).body).toEqual({ job: null });
      expect((await request(`/admin/vendors/${other.vendorId}/products/import/bulk-jobs/${firstJobId}`, { token: adminToken })).status).toBe(404);
    });
  });

  // ─── Staff ───────────────────────────────────────────────────────────────

  describe('admin endpoints (on behalf of a store)', () => {
    it('crawls and imports for the store: products and images belong to the owner, the admin is the actor, no daily limit', async () => {
      const base = `/admin/vendors/${owner.vendorId}/products/import`;
      const crawl = await request<CrawlResult>(`${base}/crawl-store`, { method: 'POST', token: adminToken, body: { storeUrl: shop() } });
      expect(crawl.status).toBe(200);
      expect(crawl.body.productUrls).toContain(`${shop()}/product/admin-kettle/`);

      // The store's daily limit is exhausted (previous test) — staff are exempt.
      const started = await request<{ jobId: string }>(`${base}/bulk-extract`, { method: 'POST', token: adminToken, body: { urls: [`${shop()}/product/admin-kettle/`], defaultCategoryId: categoryIds.digital } });
      expect(started.status).toBe(202);
      const job = await waitForJob(started.body.jobId, adminToken, base);
      expect(job).toMatchObject({ status: 'COMPLETED', staff: true, vendorId: owner.vendorId });
      const item = job.items[0]!;
      expect(item).toMatchObject({ status: 'SUCCEEDED', price: 6_500_000, product: { isPublished: false } });

      const row = await prisma.product.findUniqueOrThrow({ where: { id: item.product!.id }, select: { vendorId: true, media: { select: { mediaAsset: { select: { ownerUserId: true } } } } } });
      expect(row.vendorId).toBe(owner.vendorId);
      expect(row.media.map((media) => media.mediaAsset?.ownerUserId)).toEqual([owner.userId]);
      const adminUser = await prisma.user.findFirstOrThrow({ where: { email: SEEDED_ADMIN_EMAIL }, select: { id: true } });
      const audit = await prisma.auditLog.findFirst({ where: { entityName: 'Product', entityId: item.product!.id }, select: { userId: true } });
      expect(audit?.userId).toBe(adminUser.id);

      // The store's panel shows the staff job as its latest.
      const latest = await request<{ job: BulkJob }>(`${VENDOR_BASE}/bulk-jobs/latest`, { token: owner.token });
      expect(latest.body.job.id).toBe(started.body.jobId);
      await redis.client.del(bulkKeys.daily(owner.vendorId));
    }, 60_000);
  });
});
