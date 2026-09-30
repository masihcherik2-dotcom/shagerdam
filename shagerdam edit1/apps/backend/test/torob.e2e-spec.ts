import { ConfigService } from '@nestjs/config';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import sharp from 'sharp';
import { AppModule } from '../src/app.module';
import { GLOBAL_API_PREFIX } from '../src/common/constants';
import { PrismaService } from '../src/infra/prisma/prisma.service';
import { RedisService } from '../src/infra/redis/redis.service';
import { normalizeIdentifier } from '../src/modules/auth/auth.service';
import { OtpKeys } from '../src/modules/auth/otp.service';
import { loginAttemptsKey, loginLockKey } from '../src/modules/auth/token.service';
import { TOROB_FEED_GENERATION_KEY, TOROB_FEED_PAGE_PREFIX } from '../src/modules/integrations/torob/torob-feed-cache.service';
import { InventoryService } from '../src/modules/products/inventory.service';
import { ShippingCalculatorService } from '../src/modules/shipping/shipping-calculator.service';
import { SMS_PROVIDER } from '../src/modules/sms/sms-provider.interface';
import type { SmsProvider } from '../src/modules/sms/sms-provider.interface';
import type { SandboxSmsProvider } from '../src/modules/sms/providers/sandbox-sms.provider';
import { STORAGE_PROVIDER, type StorageProvider } from '../src/modules/storage/storage-provider.interface';
import { applyGlobalPolicies, buildOpenApiDocument } from '../src/setup/app.setup';

/**
 * Torob feed against the live stack: PostgreSQL 16 and Redis 7, stores onboarded
 * through the real API (OTP, registration, KYC upload, staff approval), products
 * created and changed through the vendor and admin APIs. Nothing is stubbed.
 * Every row, file, audit entry and Redis key the suite creates is removed in
 * `afterAll`.
 */

const TEST_UA = 'shopino-torob-e2e/1.0';
const RUN = Date.now().toString(36);
const TAG = RUN.toUpperCase();

const VENDOR_A_MOBILE = '+989971140001';
const VENDOR_B_MOBILE = '+989971140002';
const PENDING_MOBILE = '+989971140003';
const SUITE_MOBILES = [VENDOR_A_MOBILE, VENDOR_B_MOBILE, PENDING_MOBILE];
const IBANS = ['IR820540102680020817909002', 'IR570629600000001003242001', 'IR550540102680020817909003'];
const SEEDED_ADMIN_EMAIL = 'admin@shopino.local';

const SKU = {
  a1: `TRB-${TAG}-A1`,
  a2: `TRB-${TAG}-A2`,
  draft: `TRB-${TAG}-DRAFT`,
  blocked: `TRB-${TAG}-BLK`,
  b1: `TRB-${TAG}-B1`,
};

interface HttpResult<T> {
  status: number;
  body: T;
  headers: Record<string, string | string[] | number | undefined>;
}
interface FeedItem {
  page_unique: string;
  title: string;
  price: number;
  old_price: number | null;
  availability: 'instock' | 'outofstock';
  page_url: string;
  image_links: string[];
  category_name: string | null;
  spec: Record<string, string>;
  guarantee: string | null;
  delivery_fee: number;
}
interface Feed {
  count: number;
  page: number;
  totalPages: number;
  products: FeedItem[];
}
interface ErrorBody {
  code?: string;
  message?: string | string[];
}
interface CreatedProduct {
  id: string;
  slug: string;
  variants: Array<{ id: string; sku: string }>;
}
interface Store {
  token: string;
  userId: string;
  vendorId: string;
  storeSlug: string;
}

describe('Torob integration — marketplace and per-store feeds, product details (live stack)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let redis: RedisService;
  let storage: StorageProvider;

  let adminToken: string;
  let storeA: Store;
  let storeB: Store;
  let pendingSlug: string;
  let webOrigin: string;
  let expectedDeliveryFee: number;
  const products: Record<'a' | 'draft' | 'blocked' | 'b', CreatedProduct> = {} as never;
  const variantId = (sku: string): string => {
    for (const product of Object.values(products)) {
      const match = product.variants.find((variant) => variant.sku === sku);
      if (match) return match.id;
    }
    throw new Error(`unknown SKU ${sku}`);
  };

  const API = `/${GLOBAL_API_PREFIX}`;

  const request = async <T>(
    url: string,
    options: { method?: 'GET' | 'POST' | 'PATCH'; token?: string; body?: unknown; form?: FormData } = {},
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
    return {
      status: response.statusCode,
      body: response.body.length > 0 ? (JSON.parse(response.body) as T) : (undefined as T),
      headers: response.headers,
    };
  };

  const feed = (query = ''): Promise<HttpResult<Feed & ErrorBody>> => request(`/integrations/torob/products${query}`);
  const details = (query: string): Promise<HttpResult<FeedItem & ErrorBody>> => request(`/integrations/torob/product-details${query}`);

  /** Every page of a feed, following totalPages — the way Torob's crawler reads it. */
  const allItems = async (vendorSlug?: string): Promise<FeedItem[]> => {
    const items: FeedItem[] = [];
    const base = vendorSlug === undefined ? '' : `&vendorSlug=${vendorSlug}`;
    for (let page = 1; ; page += 1) {
      const response = await feed(`?page=${page}&pageSize=500${base}`);
      expect(response.status).toBe(200);
      items.push(...response.body.products);
      if (page >= response.body.totalPages) break;
    }
    return items;
  };
  const ours = (items: FeedItem[]): FeedItem[] => items.filter((item) => item.page_unique.startsWith(`TRB-${TAG}-`));
  const item = (items: FeedItem[], sku: string): FeedItem | undefined => items.find((row) => row.page_unique === sku);

  const loginWithOtp = async (mobile: string): Promise<{ token: string; userId: string }> => {
    expect((await request('/auth/otp/request', { method: 'POST', body: { mobile } })).status).toBe(200);
    const code = (app.get<SmsProvider>(SMS_PROVIDER) as SandboxSmsProvider).latestOtpCode(mobile);
    const verified = await request<{ accessToken: string; user: { id: string } }>('/auth/otp/verify', { method: 'POST', body: { mobile, code } });
    expect(verified.status).toBe(200);
    return { token: verified.body.accessToken, userId: verified.body.user.id };
  };

  const onboard = async (mobile: string, storeSlug: string, iban: string, approve: boolean): Promise<Store> => {
    const user = await loginWithOtp(mobile);
    const registered = await request<{ id: string }>('/vendors/register', {
      method: 'POST',
      token: user.token,
      body: { storeName: `فروشگاه آزمون ترب ${storeSlug}`, storeSlug, bio: 'فروشگاه آزمون فید ترب', bankIban: iban, bankAccountHolder: 'شرکت آزمون' },
    });
    expect(registered.status).toBe(201);
    if (approve) {
      const form = new FormData();
      const pdf = Buffer.concat([Buffer.from(`%PDF-1.7\n% torob e2e ${RUN}\n`, 'latin1'), Buffer.from('%%EOF', 'latin1')]);
      form.append('file', new Blob([new Uint8Array(pdf)], { type: 'application/pdf' }), 'national-id.pdf');
      form.append('purpose', 'kyc_national_id');
      const doc = await request<{ url: string }>('/media/upload/document', { method: 'POST', token: user.token, form });
      expect(doc.status).toBe(201);
      expect((await request('/vendors/verification/documents', { method: 'POST', token: user.token, body: { nationalIdCardUrl: doc.body.url } })).status).toBe(200);
      const decision = await request(`/admin/vendors/${registered.body.id}/verify`, { method: 'POST', token: adminToken, body: { status: 'APPROVED', rejectionReason: null } });
      expect(decision.status).toBe(200);
    }
    return { token: user.token, userId: user.userId, vendorId: registered.body.id, storeSlug };
  };

  const uploadImage = async (token: string, color: string): Promise<string> => {
    const png = await sharp({ create: { width: 640, height: 640, channels: 3, background: color } }).png().toBuffer();
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'product.png');
    form.append('purpose', 'product_image');
    const uploaded = await request<{ id: string }>('/media/upload/image', { method: 'POST', token, form });
    expect(uploaded.status).toBe(201);
    return uploaded.body.id;
  };

  const createProduct = async (store: Store, body: Record<string, unknown>): Promise<CreatedProduct> => {
    const created = await request<CreatedProduct & ErrorBody>('/vendor/products', { method: 'POST', token: store.token, body });
    if (created.status !== 201) throw new Error(`create product failed: ${created.status} ${JSON.stringify(created.body)}`);
    return created.body;
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
    storage = app.get<StorageProvider>(STORAGE_PROVIDER);
    const config = app.get(ConfigService);
    webOrigin = config.get<string>('PUBLIC_WEB_ORIGIN') ?? config.getOrThrow<string>('PUBLIC_API_ORIGIN');
    expect(config.get('TOROB_PRICE_UNIT')).toBe('IRR');
    await resetKeys();

    const adminPassword = process.env['SUPER_ADMIN_PASSWORD'];
    if (adminPassword === undefined) throw new Error('This suite needs SUPER_ADMIN_PASSWORD from the root .env.');
    const admin = await request<{ accessToken: string }>('/auth/login/password', { method: 'POST', body: { identifier: SEEDED_ADMIN_EMAIL, password: adminPassword } });
    expect(admin.status).toBe(200);
    adminToken = admin.body.accessToken;

    storeA = await onboard(VENDOR_A_MOBILE, `trb-a-${RUN}`, IBANS[0]!, true);
    storeB = await onboard(VENDOR_B_MOBILE, `trb-b-${RUN}`, IBANS[1]!, true);
    pendingSlug = (await onboard(PENDING_MOBILE, `trb-p-${RUN}`, IBANS[2]!, false)).storeSlug;

    const mobile = await prisma.category.findUniqueOrThrow({ where: { slug: 'mobile' }, select: { id: true } });
    const images = [await uploadImage(storeA.token, '#1d4ed8'), await uploadImage(storeA.token, '#dc2626')];

    products.a = await createProduct(storeA, {
      title: `گوشی موبایل آزمون ترب ${RUN}`,
      categoryId: mobile.id,
      brand: 'سامسونگ',
      basePrice: 620_000_000,
      mediaIds: images,
      specifications: [
        { groupTitle: 'حافظه', title: 'حافظه داخلی', value: '256 گیگابایت' },
        { groupTitle: 'حافظه', title: 'مقدار RAM', value: '12 گیگابایت' },
      ],
      variants: [
        { sku: SKU.a1, colorName: 'مشکی تیتانیوم', colorHex: '#222222', guarantee: 'گارانتی ۱۸ ماهه شرکتی', price: 620_000_000, compareAtPrice: 650_000_000, stockQuantity: 5 },
        { sku: SKU.a2, colorName: 'بنفش', colorHex: '#6b21a8', price: 615_000_000, stockQuantity: 0 },
      ],
      isPublished: true,
    });
    products.draft = await createProduct(storeA, {
      title: `پیش‌نویس آزمون ترب ${RUN}`,
      categoryId: mobile.id,
      basePrice: 1_000_000,
      variants: [{ sku: SKU.draft, price: 1_000_000, stockQuantity: 3 }],
      isPublished: false,
    });
    products.blocked = await createProduct(storeA, {
      title: `کالای مسدودشدنی آزمون ترب ${RUN}`,
      categoryId: mobile.id,
      basePrice: 2_000_000,
      variants: [{ sku: SKU.blocked, price: 2_000_000, stockQuantity: 3 }],
      isPublished: true,
    });
    products.b = await createProduct(storeB, {
      title: `کالای فروشگاه دوم آزمون ترب ${RUN}`,
      categoryId: mobile.id,
      basePrice: 3_000_000,
      variants: [{ sku: SKU.b1, size: 'XL', price: 3_000_000, stockQuantity: 2 }],
      isPublished: true,
    });

    // Neither store overrides shipping: the one-unit delivery fee is the checkout quote.
    const shipping = app.get(ShippingCalculatorService);
    const policy = await shipping.loadPolicy();
    const quote = shipping.quote(new Prisma.Decimal(620_000_000), { shippingFeeOverride: null, freeShippingThreshold: null }, policy);
    expectedDeliveryFee = quote.fee.toNumber();
  }, 180_000);

  afterAll(async () => {
    if (prisma !== undefined) {
      const users = await prisma.user.findMany({ where: { mobile: { in: SUITE_MOBILES } }, select: { id: true } });
      const userIds = users.map((user) => user.id);
      const vendors = await prisma.vendor.findMany({ where: { userId: { in: userIds } }, select: { id: true } });
      const vendorIds = vendors.map((row) => row.id);
      const productRows = await prisma.product.findMany({ where: { vendorId: { in: vendorIds } }, select: { id: true } });
      const productIds = productRows.map((row) => row.id);

      await prisma.productMedia.deleteMany({ where: { productId: { in: productIds } } });
      await prisma.productVariant.deleteMany({ where: { productId: { in: productIds } } });
      await prisma.product.deleteMany({ where: { id: { in: productIds } } });
      const assets = await prisma.mediaAsset.findMany({ where: { ownerUserId: { in: userIds } }, select: { path: true, thumbnailPath: true } });
      for (const asset of assets) {
        await storage.delete(asset.path).catch(() => false);
        if (asset.thumbnailPath !== null) await storage.delete(asset.thumbnailPath).catch(() => false);
      }
      await prisma.auditLog.deleteMany({ where: { OR: [{ userId: { in: userIds } }, { userAgent: TEST_UA }, { entityId: { in: [...vendorIds, ...productIds] } }] } });
      await prisma.vendorVerification.deleteMany({ where: { vendorId: { in: vendorIds } } });
      await prisma.vendorWallet.deleteMany({ where: { vendorId: { in: vendorIds } } });
      await prisma.mediaAsset.deleteMany({ where: { ownerUserId: { in: userIds } } });
      await prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      // Cached pages that mention this run's stores (the generation counter itself is shared state and stays).
      const cached = await redis.client.keys(`${TOROB_FEED_PAGE_PREFIX}:*${RUN}*`);
      if (cached.length > 0) await redis.client.del(...cached);
      await resetKeys();
    }
    await app?.close();
  }, 120_000);

  // ─── Listing ──────────────────────────────────────────────────────────────

  describe('marketplace feed (no vendorSlug)', () => {
    it('lists visible products of every approved store, one item per active variant', async () => {
      const items = ours(await allItems());
      expect(items.map((row) => row.page_unique).sort()).toEqual([SKU.a1, SKU.a2, SKU.blocked, SKU.b1].sort());
    });

    it('never lists unpublished products', async () => {
      expect(item(await allItems(), SKU.draft)).toBeUndefined();
    });

    it('reports count and totalPages consistently with the rows', async () => {
      const first = await feed('?pageSize=1');
      expect(first.status).toBe(200);
      expect(first.body.page).toBe(1);
      expect(first.body.totalPages).toBe(first.body.count);
      expect(first.body.products).toHaveLength(1);
      const second = await feed('?page=2&limit=1');
      expect(second.body.products).toHaveLength(1);
      expect(second.body.products[0]!.page_unique).not.toBe(first.body.products[0]!.page_unique);
      const beyond = await feed(`?page=${first.body.totalPages + 1}&pageSize=1`);
      expect(beyond.status).toBe(200);
      expect(beyond.body.products).toEqual([]);
    });

    it('maps a variant to the Torob schema from live data', async () => {
      const { image_links: imageLinks, ...row } = item(await allItems(), SKU.a1)!;
      expect(imageLinks).toHaveLength(2);
      for (const link of imageLinks) expect(link).toMatch(/^https?:\/\/.+\.webp$/);
      expect(row).toEqual({
        page_unique: SKU.a1,
        title: `گوشی موبایل آزمون ترب ${RUN}، رنگ مشکی تیتانیوم`,
        price: 620_000_000,
        old_price: 650_000_000,
        availability: 'instock',
        page_url: `${webOrigin}/products/${encodeURIComponent(products.a.slug)}?variant=${SKU.a1}`,
        category_name: 'کالای دیجیتال > گوشی موبایل',
        spec: { 'حافظه داخلی': '256 گیگابایت', 'مقدار RAM': '12 گیگابایت', برند: 'سامسونگ', رنگ: 'مشکی تیتانیوم', گارانتی: 'گارانتی ۱۸ ماهه شرکتی' },
        guarantee: 'گارانتی ۱۸ ماهه شرکتی',
        delivery_fee: expectedDeliveryFee,
      });
    });

    it('keeps an out-of-stock variant listed as outofstock without old_price', async () => {
      const row = item(await allItems(), SKU.a2)!;
      expect(row.availability).toBe('outofstock');
      expect(row.old_price).toBeNull();
      expect(row.guarantee).toBeNull();
    });

    it('serves the images it lists', async () => {
      const row = item(await allItems(), SKU.a1)!;
      for (const link of row.image_links) {
        const path = new URL(link).pathname;
        const response = await app.inject({ method: 'GET', url: path });
        expect(response.statusCode).toBe(200);
        expect(response.headers['content-type']).toBe('image/webp');
      }
    });

    it('rejects invalid paging parameters', async () => {
      expect((await feed('?pageSize=501')).status).toBe(400);
      expect((await feed('?limit=0')).status).toBe(400);
      expect((await feed('?page=0')).status).toBe(400);
      expect((await feed('?page=abc')).status).toBe(400);
      expect((await feed('?unknown=1')).status).toBe(400);
    });
  });

  describe('per-store feed (vendorSlug)', () => {
    it('returns ONLY the products of that store', async () => {
      const a = await allItems(storeA.storeSlug);
      expect(a.map((row) => row.page_unique).sort()).toEqual([SKU.a1, SKU.a2, SKU.blocked].sort());
      const b = await allItems(storeB.storeSlug);
      expect(b.map((row) => row.page_unique)).toEqual([SKU.b1]);
      expect(b[0]!.title).toBe(`کالای فروشگاه دوم آزمون ترب ${RUN}، سایز XL`);
    });

    it('agrees with PostgreSQL on the store\'s listed variant count', async () => {
      const response = await feed(`?vendorSlug=${storeA.storeSlug}`);
      const expected = await prisma.productVariant.count({
        where: { isActive: true, product: { vendorId: storeA.vendorId, isPublished: true, isBlockedByAdmin: false } },
      });
      expect(response.body.count).toBe(expected);
    });

    it('404s for an unknown store and for a store that is not approved (indistinguishable)', async () => {
      const unknown = await feed(`?vendorSlug=no-such-store-${RUN}`);
      expect(unknown.status).toBe(404);
      expect(unknown.body.code).toBe('TOROB_VENDOR_NOT_FOUND');
      const pending = await feed(`?vendorSlug=${pendingSlug}`);
      expect(pending.status).toBe(404);
      expect(pending.body.code).toBe('TOROB_VENDOR_NOT_FOUND');
    });

    it('rejects a malformed vendorSlug', async () => {
      expect((await feed('?vendorSlug=Bad%20Slug')).status).toBe(400);
    });
  });

  // ─── Caching and invalidation ─────────────────────────────────────────────

  describe('Redis cache', () => {
    it('caches a rendered page under the current generation with a TTL', async () => {
      const response = await feed(`?vendorSlug=${storeB.storeSlug}`);
      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toBe('public, max-age=60');
      const generation = Number((await redis.client.get(TOROB_FEED_GENERATION_KEY)) ?? '0');
      const key = `${TOROB_FEED_PAGE_PREFIX}:g${generation}:IRR:${storeB.storeSlug}:1:100`;
      expect(await redis.client.exists(key)).toBe(1);
      const ttl = await redis.client.ttl(key);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(300);
    });

    it('serves the cached page (a write that bypasses the application is not seen)…', async () => {
      await feed(`?vendorSlug=${storeB.storeSlug}`); // warm
      await prisma.productVariant.update({ where: { sku: SKU.b1 }, data: { price: 3_100_000 } });
      const cached = await feed(`?vendorSlug=${storeB.storeSlug}`);
      expect(item(cached.body.products, SKU.b1)!.price).toBe(3_000_000);
      await prisma.productVariant.update({ where: { sku: SKU.b1 }, data: { price: 3_000_000 } });
    });

    it('…but a price change through the vendor API invalidates it immediately', async () => {
      await feed(`?vendorSlug=${storeB.storeSlug}`); // warm
      const changed = await request(`/vendor/products/variants/${variantId(SKU.b1)}`, { method: 'PATCH', token: storeB.token, body: { price: 2_900_000, compareAtPrice: 3_000_000 } });
      expect(changed.status).toBe(200);
      const fresh = item((await feed(`?vendorSlug=${storeB.storeSlug}`)).body.products, SKU.b1)!;
      expect(fresh.price).toBe(2_900_000);
      expect(fresh.old_price).toBe(3_000_000);
    });

    it('a stock change through the vendor API invalidates it immediately', async () => {
      await feed(`?vendorSlug=${storeB.storeSlug}`); // warm
      expect((await request(`/vendor/products/variants/${variantId(SKU.b1)}`, { method: 'PATCH', token: storeB.token, body: { stockQuantity: 0 } })).status).toBe(200);
      expect(item((await feed(`?vendorSlug=${storeB.storeSlug}`)).body.products, SKU.b1)!.availability).toBe('outofstock');
      expect((await request(`/vendor/products/variants/${variantId(SKU.b1)}`, { method: 'PATCH', token: storeB.token, body: { stockQuantity: 2 } })).status).toBe(200);
      expect(item((await feed(`?vendorSlug=${storeB.storeSlug}`)).body.products, SKU.b1)!.availability).toBe('instock');
    });

    it('checkout reservations count: reserving the whole stock makes the offer outofstock (stock − reserved)', async () => {
      const inventory = app.get(InventoryService);
      await feed(`?vendorSlug=${storeB.storeSlug}`); // warm
      await inventory.reserve(variantId(SKU.b1), 2);
      try {
        expect(item((await feed(`?vendorSlug=${storeB.storeSlug}`)).body.products, SKU.b1)!.availability).toBe('outofstock');
        expect((await details(`?page_unique=${SKU.b1}`)).body.availability).toBe('outofstock');
      } finally {
        await inventory.release(variantId(SKU.b1), 2);
      }
      expect(item((await feed(`?vendorSlug=${storeB.storeSlug}`)).body.products, SKU.b1)!.availability).toBe('instock');
    });
  });

  // ─── Details ──────────────────────────────────────────────────────────────

  describe('product-details', () => {
    it('returns live price and availability by page_unique (never cached)', async () => {
      const response = await details(`?page_unique=${SKU.a1}`);
      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body.page_unique).toBe(SKU.a1);
      expect(response.body.price).toBe(620_000_000);
      expect(response.body.availability).toBe('instock');
      // A direct database change is visible at once: this endpoint reads PostgreSQL every time.
      await prisma.productVariant.update({ where: { sku: SKU.a1 }, data: { price: 619_000_000 } });
      expect((await details(`?page_unique=${SKU.a1}`)).body.price).toBe(619_000_000);
      await prisma.productVariant.update({ where: { sku: SKU.a1 }, data: { price: 620_000_000 } });
    });

    it('accepts page_unique case-insensitively (SKUs are stored upper-cased)', async () => {
      expect((await details(`?page_unique=${SKU.a1.toLowerCase()}`)).body.page_unique).toBe(SKU.a1);
    });

    it('resolves the page_url published in the feed', async () => {
      const url = `${webOrigin}/products/${encodeURIComponent(products.a.slug)}?variant=${SKU.a2}`;
      const response = await details(`?page_url=${encodeURIComponent(url)}`);
      expect(response.status).toBe(200);
      expect(response.body.page_unique).toBe(SKU.a2);
      expect(response.body.availability).toBe('outofstock');
    });

    it('a page_url without ?variant resolves to the offer the page pre-selects (first in stock)', async () => {
      const url = `${webOrigin}/products/${encodeURIComponent(products.a.slug)}`;
      expect((await details(`?page_url=${encodeURIComponent(url)}`)).body.page_unique).toBe(SKU.a1);
    });

    it('reports an existing but unpublished product as outofstock (not 404)', async () => {
      const response = await details(`?page_unique=${SKU.draft}`);
      expect(response.status).toBe(200);
      expect(response.body.availability).toBe('outofstock');
    });

    it.each([
      ['neither parameter', '', 400, 'TOROB_LOOKUP_REQUIRED'],
      ['both parameters', `?page_unique=${SKU.a1}&page_url=${encodeURIComponent('https://x.example/products/a')}`, 400, 'TOROB_LOOKUP_REQUIRED'],
      ['a foreign page_url', `?page_url=${encodeURIComponent('https://evil.example/products/anything')}`, 400, 'TOROB_INVALID_PAGE_URL'],
      ['an unknown SKU', `?page_unique=NO-SUCH-${TAG}`, 404, 'TOROB_PRODUCT_NOT_FOUND'],
    ])('rejects %s', async (_label, query, status, code) => {
      const response = await details(query);
      expect(response.status).toBe(status);
      expect(response.body.code).toBe(code);
    });

    it('404s when the SKU in page_url belongs to another product', async () => {
      const url = `${webOrigin}/products/${encodeURIComponent(products.a.slug)}?variant=${SKU.b1}`;
      const response = await details(`?page_url=${encodeURIComponent(url)}`);
      expect(response.status).toBe(404);
    });

    it('rejects a malformed page_unique', async () => {
      expect((await details('?page_unique=%3Cscript%3E')).status).toBe(400);
    });
  });

  // ─── Moderation and store status ──────────────────────────────────────────

  describe('staff moderation and store status', () => {
    it('a product blocked by staff leaves both feeds at once and is reported outofstock', async () => {
      await feed(`?vendorSlug=${storeA.storeSlug}`); // warm
      const blocked = await request(`/admin/products/${products.blocked.id}/status`, {
        method: 'PATCH',
        token: adminToken,
        body: { isBlockedByAdmin: true, blockedReason: 'آزمون فید ترب' },
      });
      expect(blocked.status).toBe(200);
      expect(item(await allItems(storeA.storeSlug), SKU.blocked)).toBeUndefined();
      expect(item(await allItems(), SKU.blocked)).toBeUndefined();
      expect((await details(`?page_unique=${SKU.blocked}`)).body.availability).toBe('outofstock');
    });

    it('a suspended store disappears from the marketplace feed and its own feed 404s', async () => {
      await prisma.vendor.update({ where: { id: storeB.vendorId }, data: { status: 'SUSPENDED' } });
      // Direct status write (no suspension endpoint exists yet): invalidate as the service would.
      await redis.client.incr(TOROB_FEED_GENERATION_KEY);
      try {
        expect(item(await allItems(), SKU.b1)).toBeUndefined();
        expect((await feed(`?vendorSlug=${storeB.storeSlug}`)).status).toBe(404);
        expect((await details(`?page_unique=${SKU.b1}`)).body.availability).toBe('outofstock');
      } finally {
        await prisma.vendor.update({ where: { id: storeB.vendorId }, data: { status: 'APPROVED' } });
        await redis.client.incr(TOROB_FEED_GENERATION_KEY);
      }
    });
  });

  // ─── Contract ─────────────────────────────────────────────────────────────

  describe('OpenAPI', () => {
    it('documents both endpoints under the integrations-torob tag, publicly', () => {
      const document = buildOpenApiDocument(app);
      const feedPath = document.paths[`${API}/integrations/torob/products`]?.get;
      const detailsPath = document.paths[`${API}/integrations/torob/product-details`]?.get;
      expect(feedPath?.tags).toEqual(['integrations-torob']);
      expect(detailsPath?.tags).toEqual(['integrations-torob']);
      expect((feedPath?.parameters ?? []).map((parameter) => ('name' in parameter ? parameter.name : '')).sort()).toEqual(['limit', 'page', 'pageSize', 'vendorSlug']);
      expect(document.tags?.some((tag) => tag.name === 'integrations-torob')).toBe(true);
    });
  });
});
