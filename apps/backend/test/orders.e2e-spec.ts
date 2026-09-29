import { ConfigService } from '@nestjs/config';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { ParentOrderPaymentStatus, SubOrderStatus } from '@prisma/client';
import { AuditAction, Prisma } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { GLOBAL_API_PREFIX } from '../src/common/constants';
import { PrismaService } from '../src/infra/prisma/prisma.service';
import { RedisService } from '../src/infra/redis/redis.service';
import { normalizeIdentifier } from '../src/modules/auth/auth.service';
import { OtpKeys } from '../src/modules/auth/otp.service';
import { loginAttemptsKey, loginLockKey } from '../src/modules/auth/token.service';
import { CategoriesService } from '../src/modules/categories/categories.service';
import { OrderLifecycleService } from '../src/modules/orders/order-lifecycle.service';
import { SHIPPING_CONFIG_KEYS } from '../src/modules/shipping/shipping-calculator.service';
import { SMS_PROVIDER } from '../src/modules/sms/sms-provider.interface';
import type { SmsProvider } from '../src/modules/sms/sms-provider.interface';
import type { SandboxSmsProvider } from '../src/modules/sms/providers/sandbox-sms.provider';
import { STORAGE_PROVIDER, type StorageProvider } from '../src/modules/storage/storage-provider.interface';
import { applyGlobalPolicies, buildOpenApiDocument } from '../src/setup/app.setup';

/**
 * End-to-end verification of Phase 6 — address book, cart, checkout with
 * multi-vendor splitting, stock reservation and the order lifecycle — against
 * the real PostgreSQL 16 and Redis 7 of docker-compose. Nothing is stubbed:
 * stores are onboarded and approved over the API, products are created over the
 * vendor API, orders are placed over the checkout API.
 *
 * This suite isolates the order lifecycle: it moves orders to PAID with the
 * real `OrderLifecycleService.markPaid` (same code path the payment callback
 * runs, including escrow). The full gateway path — initiate, bank page,
 * callback — is covered by test/finance.e2e-spec.ts.
 *
 * The platform shipping policy is set for the duration of the suite through
 * real `system_configs` rows (restored afterwards).
 */

const TEST_UA = 'shopino-orders-e2e/1.0';
const RUN = Date.now().toString(36);
const TAG = RUN.toUpperCase();

const VENDOR_A_MOBILE = '+989971140001';
const VENDOR_B_MOBILE = '+989971140002';
const CUSTOMER_MOBILE = '+989971140003';
const CUSTOMER_2_MOBILE = '+989971140004';
const SUITE_MOBILES = [VENDOR_A_MOBILE, VENDOR_B_MOBILE, CUSTOMER_MOBILE, CUSTOMER_2_MOBILE];
const IBANS = ['IR550540102680020817909003', 'IR760170000000000000000001'];
const SEEDED_ADMIN_EMAIL = 'admin@shopino.local';
const SEEDED_SUPPORT_EMAIL = 'support@shopino.local';

/** Platform shipping policy used by this suite (Toman). */
const PLATFORM_FEE = '450000';
const PLATFORM_FREE_THRESHOLD = '3000000';
/** Store B offers free shipping from 2,000,000. */
const STORE_B_FREE_THRESHOLD = '2000000';

interface HttpResult<T> {
  status: number;
  body: T;
  headers: Record<string, unknown>;
}

interface Address {
  id: string;
  isDefault: boolean;
  postalCode: string;
  recipientMobile: string;
  city: string;
}

interface CartLine {
  id: string;
  productVariantId: string;
  quantity: number;
  unitPrice: string;
  priceWhenAdded: string;
  availableQuantity: number;
  isPurchasable: boolean;
  issues: Array<{ code: string }>;
}

interface Cart {
  cartToken: string | null;
  owner: 'user' | 'guest' | 'none';
  groups: Array<{
    vendor: { storeSlug: string };
    lines: CartLine[];
    itemsSubtotal: string;
    shipping: { fee: string; isFree: boolean; freeThreshold: string };
    packageTotal: string;
  }>;
  itemCount: number;
  lineCount: number;
  itemsSubtotal: string;
  shippingTotal: string;
  payableAmount: string;
  hasPriceChanges: boolean;
  canCheckout: boolean;
}

interface OrderItem {
  productTitle: string;
  sku: string;
  vendorStoreName: string;
  unitPrice: string;
  quantity: number;
  lineTotal: string;
  variantDetails: { colorName: string | null };
}

interface SubOrder {
  id: string;
  subOrderNumber: string;
  store: { id: string; storeSlug: string };
  status: SubOrderStatus;
  itemsSubtotal: string;
  shippingFee: string;
  total: string;
  trackingCode: string | null;
  carrierName: string | null;
  items: OrderItem[];
}

interface Checkout {
  parentOrderId: string;
  orderNumber: string;
  paymentStatus: ParentOrderPaymentStatus;
  paymentMethod: string;
  totalItemsAmount: string;
  totalShippingFee: string;
  totalDiscountAmount: string;
  finalPayableAmount: string;
  paymentExpiresAt: string;
  subOrders: SubOrder[];
}

interface OrderDetail extends Omit<Checkout, 'parentOrderId'> {
  id: string;
  canCancel: boolean;
  shippingAddress: { postalCode: string; recipientName: string };
  timeline: Array<{ type: string; toStatus: SubOrderStatus | null; actor: string }>;
  auditLogId?: string;
}

interface VendorSubOrder {
  id: string;
  subOrderNumber: string;
  orderNumber: string;
  status: SubOrderStatus;
  itemsSubtotal: string;
  platformCommissionAmount: string;
  vendorEarningsAmount: string;
  allowedTransitions: SubOrderStatus[];
  trackingCode: string | null;
  shippingAddress?: { postalCode: string };
  items?: Array<{ commissionRate: string; commissionAmount: string }>;
  history?: Array<{ toStatus: SubOrderStatus; actorRole: string }>;
}

interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

interface ErrorBody {
  code?: string;
  message: string | string[];
  availableQuantity?: number;
  changes?: Array<{ productVariantId: string; previousUnitPrice: string; currentUnitPrice: string }>;
  lines?: Array<{ productVariantId: string; issues: string[] }>;
  allowedTransitions?: SubOrderStatus[];
}

const d = (value: string | number | Prisma.Decimal): Prisma.Decimal => new Prisma.Decimal(value);

describe('Phase 6 — cart, checkout, multi-vendor orders and lifecycle (live stack)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let lifecycle: OrderLifecycleService;

  let adminToken: string;
  let supportToken: string;
  let vendorA: { token: string; userId: string; vendorId: string; storeSlug: string };
  let vendorB: { token: string; userId: string; vendorId: string; storeSlug: string };
  let customer: { token: string; userId: string };
  let customer2: { token: string; userId: string };

  let categoryId: string;
  /** Variant ids: A1/A2 sold by store A, B1 by store B, D1 unpublished (store A). */
  const v: Record<'A1' | 'A2' | 'B1' | 'D1', string> = {} as never;
  let productAId: string;
  let address: Address;
  let address2: Address;
  let savedSystemConfigs: Array<{ key: string; value: string; valueType: never; description: string | null }> = [];

  const API = `/${GLOBAL_API_PREFIX}`;

  const request = async <T>(
    url: string,
    options: { method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; token?: string; cartToken?: string; body?: unknown } = {},
  ): Promise<HttpResult<T>> => {
    const headers: Record<string, string> = { 'user-agent': TEST_UA };
    if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
    if (options.cartToken !== undefined) headers['x-cart-token'] = options.cartToken;
    let payload: string | undefined;
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(options.body);
    }
    const response = await app.inject({
      method: options.method ?? 'GET',
      url: `${API}${url}`,
      headers,
      ...(payload === undefined ? {} : { payload }),
    });
    return {
      status: response.statusCode,
      body: response.body.length > 0 ? (JSON.parse(response.body) as T) : (undefined as T),
      headers: response.headers,
    };
  };

  const loginWithOtp = async (mobile: string): Promise<{ token: string; userId: string }> => {
    expect((await request('/auth/otp/request', { method: 'POST', body: { mobile } })).status).toBe(200);
    const code = (app.get<SmsProvider>(SMS_PROVIDER) as SandboxSmsProvider).latestOtpCode(mobile);
    const verified = await request<{ accessToken: string; user: { id: string } }>('/auth/otp/verify', {
      method: 'POST',
      body: { mobile, code },
    });
    expect(verified.status).toBe(200);
    return { token: verified.body.accessToken, userId: verified.body.user.id };
  };

  const loginWithPassword = async (identifier: string, password: string): Promise<string> => {
    const response = await request<{ accessToken: string }>('/auth/login/password', { method: 'POST', body: { identifier, password } });
    expect(response.status).toBe(200);
    return response.body.accessToken;
  };

  const onboardStore = async (
    login: { token: string; userId: string },
    storeSlug: string,
    iban: string,
    commissionRateOverride: number | null,
  ): Promise<string> => {
    const registered = await request<{ id: string }>('/vendors/register', {
      method: 'POST',
      token: login.token,
      body: {
        storeName: `فروشگاه آزمون سفارش ${storeSlug}`,
        storeSlug,
        bio: 'فروشگاه ساخته‌شده در آزمون سفارش',
        bankIban: iban,
        bankAccountHolder: 'شرکت آزمون سفارش',
      },
    });
    expect(registered.status).toBe(201);
    const form = new FormData();
    const pdf = Buffer.concat([Buffer.from(`%PDF-1.7\n% orders e2e ${RUN}\n`, 'latin1'), Buffer.from('%%EOF', 'latin1')]);
    form.append('file', new Blob([new Uint8Array(pdf)], { type: 'application/pdf' }), 'national-id.pdf');
    form.append('purpose', 'kyc_national_id');
    const serialized = new Response(form);
    const uploaded = await app.inject({
      method: 'POST',
      url: `${API}/media/upload/document`,
      headers: {
        authorization: `Bearer ${login.token}`,
        'user-agent': TEST_UA,
        'content-type': serialized.headers.get('content-type') ?? '',
      },
      payload: Buffer.from(await serialized.arrayBuffer()),
    });
    expect(uploaded.statusCode).toBe(201);
    const submitted = await request('/vendors/verification/documents', {
      method: 'POST',
      token: login.token,
      body: { nationalIdCardUrl: (JSON.parse(uploaded.body) as { url: string }).url },
    });
    expect(submitted.status).toBe(200);
    const verified = await request(`/admin/vendors/${registered.body.id}/verify`, {
      method: 'POST',
      token: adminToken,
      body: { status: 'APPROVED', rejectionReason: null, commissionRateOverride },
    });
    expect(verified.status).toBe(200);
    return registered.body.id;
  };

  const createProduct = async (
    token: string,
    title: string,
    variants: Array<{ sku: string; price: number; stockQuantity: number; colorName?: string }>,
    isPublished = true,
  ): Promise<{ id: string; variants: Array<{ id: string; sku: string }> }> => {
    const response = await request<{ id: string; variants: Array<{ id: string; sku: string }> }>('/vendor/products', {
      method: 'POST',
      token,
      body: { title, categoryId, basePrice: variants[0]!.price, isPublished, variants },
    });
    expect(response.status).toBe(201);
    return response.body;
  };

  const variantIdBySku = (product: { variants: Array<{ id: string; sku: string }> }, sku: string): string =>
    product.variants.find((variant) => variant.sku === sku)!.id;

  const stockOf = async (variantId: string): Promise<{ stock: number; reserved: number }> => {
    const row = await prisma.productVariant.findUniqueOrThrow({ where: { id: variantId }, select: { stockQuantity: true, reservedQuantity: true } });
    return { stock: row.stockQuantity, reserved: row.reservedQuantity };
  };

  const setStock = (variantId: string, stockQuantity: number): Promise<HttpResult<unknown>> =>
    request(`/vendor/products/variants/${variantId}`, {
      method: 'PATCH',
      token: variantId === v.B1 ? vendorB.token : vendorA.token,
      body: { stockQuantity },
    });

  const addToUserCart = (token: string, productVariantId: string, quantity: number): Promise<HttpResult<Cart & ErrorBody>> =>
    request<Cart & ErrorBody>('/cart/items', { method: 'POST', token, body: { productVariantId, quantity } });

  const checkout = (token: string, addressId: string, customerNote?: string): Promise<HttpResult<Checkout & ErrorBody>> =>
    request<Checkout & ErrorBody>('/orders/checkout', {
      method: 'POST',
      token,
      body: { addressId, ...(customerNote === undefined ? {} : { customerNote }) },
    });

  const clearCart = async (token: string): Promise<void> => {
    expect((await request('/cart/clear', { method: 'POST', token })).status).toBe(200);
  };

  // ─── lifecycle ─────────────────────────────────────────────────────────────

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    applyGlobalPolicies(app, app.get(ConfigService));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = app.get(PrismaService);
    lifecycle = app.get(OrderLifecycleService);
    await resetAuthKeys();

    const adminPassword = process.env['SUPER_ADMIN_PASSWORD'];
    const staffPassword = process.env['SEED_STAFF_PASSWORD'];
    if (adminPassword === undefined || staffPassword === undefined) {
      throw new Error('This suite needs SUPER_ADMIN_PASSWORD and SEED_STAFF_PASSWORD from the root .env.');
    }
    adminToken = await loginWithPassword(SEEDED_ADMIN_EMAIL, adminPassword);
    supportToken = await loginWithPassword(SEEDED_SUPPORT_EMAIL, staffPassword);

    // Platform shipping policy for this run, via real system_configs rows.
    savedSystemConfigs = (await prisma.systemConfig.findMany({
      where: { key: { in: Object.values(SHIPPING_CONFIG_KEYS) } },
      select: { key: true, value: true, valueType: true, description: true },
    })) as never;
    for (const [key, value] of [
      [SHIPPING_CONFIG_KEYS.defaultFeePerVendor, PLATFORM_FEE],
      [SHIPPING_CONFIG_KEYS.freeThresholdPerVendor, PLATFORM_FREE_THRESHOLD],
    ] as const) {
      await prisma.systemConfig.upsert({
        where: { key },
        update: { value },
        create: { key, value, valueType: 'NUMBER', description: `orders e2e ${RUN}` },
      });
    }

    const category = await request<{ id: string }>('/admin/categories', {
      method: 'POST',
      token: adminToken,
      body: { slug: `e2e-ord-${RUN}`, titleFa: `دسته آزمون سفارش ${RUN}`, defaultCommissionRate: 10 },
    });
    expect(category.status).toBe(201);
    categoryId = category.body.id;

    const a = await loginWithOtp(VENDOR_A_MOBILE);
    const b = await loginWithOtp(VENDOR_B_MOBILE);
    customer = await loginWithOtp(CUSTOMER_MOBILE);
    customer2 = await loginWithOtp(CUSTOMER_2_MOBILE);
    const storeA = `ord-e2e-a-${RUN}`;
    const storeB = `ord-e2e-b-${RUN}`;
    vendorA = { ...a, storeSlug: storeA, vendorId: await onboardStore(a, storeA, IBANS[0]!, 7.5) };
    vendorB = { ...b, storeSlug: storeB, vendorId: await onboardStore(b, storeB, IBANS[1]!, null) };
    // No API sets a store's shipping settings yet (not in the Phase-6 endpoint list): set the column directly.
    await prisma.vendor.update({ where: { id: vendorB.vendorId }, data: { freeShippingThreshold: d(STORE_B_FREE_THRESHOLD) } });

    const pa = await createProduct(vendorA.token, `هدفون آزمون ${RUN}`, [
      { sku: `ORD-${TAG}-A1`, price: 1_200_000, stockQuantity: 5, colorName: 'مشکی' },
      { sku: `ORD-${TAG}-A2`, price: 350_000, stockQuantity: 2, colorName: 'سفید' },
    ]);
    productAId = pa.id;
    v.A1 = variantIdBySku(pa, `ORD-${TAG}-A1`);
    v.A2 = variantIdBySku(pa, `ORD-${TAG}-A2`);
    const pb = await createProduct(vendorB.token, `کتاب آزمون ${RUN}`, [{ sku: `ORD-${TAG}-B1`, price: 2_500_000, stockQuantity: 3 }]);
    v.B1 = variantIdBySku(pb, `ORD-${TAG}-B1`);
    const draft = await createProduct(vendorA.token, `پیش‌نویس آزمون ${RUN}`, [{ sku: `ORD-${TAG}-D1`, price: 90_000, stockQuantity: 9 }], false);
    v.D1 = variantIdBySku(draft, `ORD-${TAG}-D1`);
  }, 180_000);

  afterAll(async () => {
    if (prisma !== undefined) {
      const users = await prisma.user.findMany({ where: { mobile: { in: SUITE_MOBILES } }, select: { id: true } });
      const userIds = users.map((user) => user.id);
      const vendors = await prisma.vendor.findMany({ where: { userId: { in: userIds } }, select: { id: true } });
      const vendorIds = vendors.map((vendor) => vendor.id);
      const orders = await prisma.parentOrder.findMany({ where: { userId: { in: userIds } }, select: { id: true, subOrders: { select: { id: true } } } });
      const orderIds = orders.map((order) => order.id);
      const subIds = orders.flatMap((order) => order.subOrders.map((sub) => sub.id));
      const products = await prisma.product.findMany({ where: { vendorId: { in: vendorIds } }, select: { id: true, variants: { select: { id: true } } } });
      const productIds = products.map((row) => row.id);
      const variantIds = products.flatMap((row) => row.variants.map((variant) => variant.id));

      await prisma.auditLog.deleteMany({
        where: {
          OR: [
            { userId: { in: userIds } },
            { userAgent: TEST_UA },
            { entityId: { in: [...vendorIds, ...productIds, ...variantIds, ...orderIds, ...subIds, categoryId].filter(Boolean) } },
          ],
        },
      });
      await prisma.parentOrder.deleteMany({ where: { id: { in: orderIds } } }); // cascades to sub-orders, items, history
      await prisma.cart.deleteMany({ where: { OR: [{ userId: { in: userIds } }, { items: { some: { productVariantId: { in: variantIds } } } }] } });
      await prisma.address.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.productVariant.deleteMany({ where: { productId: { in: productIds } } });
      await prisma.product.deleteMany({ where: { id: { in: productIds } } });
      if (categoryId !== undefined) await prisma.category.deleteMany({ where: { id: categoryId } });

      const storage = app.get<StorageProvider>(STORAGE_PROVIDER);
      const assets = await prisma.mediaAsset.findMany({ where: { ownerUserId: { in: userIds } }, select: { path: true } });
      for (const asset of assets) await storage.delete(asset.path).catch(() => false);
      await prisma.vendorVerification.deleteMany({ where: { vendorId: { in: vendorIds } } });
      await prisma.vendorWallet.deleteMany({ where: { vendorId: { in: vendorIds } } });
      await prisma.mediaAsset.deleteMany({ where: { ownerUserId: { in: userIds } } });
      await prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
      await prisma.customerProfile.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });

      await prisma.systemConfig.deleteMany({ where: { key: { in: Object.values(SHIPPING_CONFIG_KEYS) } } });
      for (const row of savedSystemConfigs) await prisma.systemConfig.create({ data: row });
      await app.get(CategoriesService).invalidateTree();
      await resetAuthKeys();
    }
    await app?.close();
  }, 120_000);

  async function resetAuthKeys(): Promise<void> {
    const redis = app.get(RedisService);
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
      ...[SEEDED_ADMIN_EMAIL, SEEDED_SUPPORT_EMAIL].flatMap((identifier) => [
        loginAttemptsKey(normalizeIdentifier(identifier)),
        loginLockKey(normalizeIdentifier(identifier)),
      ]),
    ];
    if (keys.length > 0) await redis.client.del(...keys);
  }

  // ─── 1. address book ───────────────────────────────────────────────────────

  describe('customer address book', () => {
    const body = {
      province: 'تهران',
      city: 'تهران',
      postalAddress: 'خیابان ولیعصر، کوچه نگار، پلاک ۱۲',
      postalCode: '۱۹۶۹۸۳۳۱۱۱', // Persian digits: normalised
      buildingNumber: '12',
      unitNumber: '4',
      recipientName: 'مریم احمدی',
      recipientMobile: '09121234567',
    };

    it('creates addresses; the first becomes the default and mobile/postal code are normalised', async () => {
      const first = await request<Address>('/customer/addresses', { method: 'POST', token: customer.token, body });
      expect(first.status).toBe(201);
      expect(first.body).toMatchObject({ isDefault: true, postalCode: '1969833111', recipientMobile: '+989121234567' });
      address = first.body;

      const second = await request<Address>('/customer/addresses', {
        method: 'POST',
        token: customer.token,
        body: { ...body, city: 'کرج', province: 'البرز', postalCode: '3134567890', isDefault: true },
      });
      expect(second.status).toBe(201);
      expect(second.body.isDefault).toBe(true);
      const list = await request<{ items: Address[]; total: number }>('/customer/addresses', { token: customer.token });
      expect(list.body.total).toBe(2);
      expect(list.body.items[0]!.id).toBe(second.body.id); // default first
      expect(list.body.items.filter((item) => item.isDefault)).toHaveLength(1);

      const own2 = await request<Address>('/customer/addresses', { method: 'POST', token: customer2.token, body });
      expect(own2.status).toBe(201);
      address2 = own2.body;
    });

    it('updates and deletes; the default moves when the default is deleted', async () => {
      const list = await request<{ items: Address[] }>('/customer/addresses', { token: customer.token });
      const karaj = list.body.items[0]!;
      const patched = await request<Address>(`/customer/addresses/${karaj.id}`, { method: 'PATCH', token: customer.token, body: { city: 'فردیس' } });
      expect(patched.status).toBe(200);
      expect(patched.body.city).toBe('فردیس');

      const removed = await request<{ deleted: boolean }>(`/customer/addresses/${karaj.id}`, { method: 'DELETE', token: customer.token });
      expect(removed.status).toBe(200);
      const after = await request<{ items: Address[] }>('/customer/addresses', { token: customer.token });
      expect(after.body.items.map((item) => [item.id, item.isDefault])).toEqual([[address.id, true]]);
    });

    it('validates input and isolates customers', async () => {
      expect((await request('/customer/addresses', { method: 'POST', token: customer.token, body: { ...body, postalCode: '0123456789' } })).status).toBe(400);
      expect((await request('/customer/addresses', { method: 'POST', token: customer.token, body: { ...body, recipientMobile: '12345' } })).status).toBe(400);
      expect((await request(`/customer/addresses/${address.id}`, { method: 'PATCH', token: customer2.token, body: { city: 'رشت' } })).status).toBe(404);
      expect((await request(`/customer/addresses/${address.id}`, { method: 'DELETE', token: customer2.token })).status).toBe(404);
      expect((await request('/customer/addresses', { token: vendorA.token })).status).toBe(403);
      expect((await request('/customer/addresses')).status).toBe(401);
    });
  });

  // ─── 2. cart ───────────────────────────────────────────────────────────────

  describe('cart', () => {
    let guestToken: string;

    it('creates a guest cart on first add and returns its token exactly once', async () => {
      const added = await request<Cart>('/cart/items', { method: 'POST', body: { productVariantId: v.A1, quantity: 2 } });
      expect(added.status).toBe(200);
      expect(added.body.owner).toBe('guest');
      expect(added.body.cartToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      guestToken = added.body.cartToken!;

      const again = await request<Cart>('/cart/items', { method: 'POST', cartToken: guestToken, body: { productVariantId: v.B1, quantity: 1 } });
      expect(again.status).toBe(200);
      expect(again.body.cartToken).toBeNull();
      expect(again.body.lineCount).toBe(2);

      // Only the digest is stored.
      const stored = await prisma.cart.findFirst({ where: { items: { some: { productVariantId: v.B1 } }, userId: null } });
      expect(stored?.sessionToken).not.toBe(guestToken);
      expect(stored?.sessionToken).toMatch(/^[0-9a-f]{64}$/);
    });

    it('adds to the same line, enforces the stock limit and reports what is available', async () => {
      const more = await request<Cart>('/cart/items', { method: 'POST', cartToken: guestToken, body: { productVariantId: v.A1, quantity: 1 } });
      expect(more.status).toBe(200);
      const line = more.body.groups.flatMap((group) => group.lines).find((item) => item.productVariantId === v.A1)!;
      expect(line.quantity).toBe(3);

      const tooMany = await request<ErrorBody>('/cart/items', { method: 'POST', cartToken: guestToken, body: { productVariantId: v.A1, quantity: 3 } });
      expect(tooMany.status).toBe(409);
      expect(tooMany.body).toMatchObject({ code: 'INSUFFICIENT_STOCK', availableQuantity: 5 });

      const patched = await request<Cart>(`/cart/items/${line.id}`, { method: 'PATCH', cartToken: guestToken, body: { quantity: 6 } });
      expect(patched.status).toBe(409);
      const ok = await request<Cart>(`/cart/items/${line.id}`, { method: 'PATCH', cartToken: guestToken, body: { quantity: 5 } });
      expect(ok.status).toBe(200);
      expect(ok.body.itemCount).toBe(6);
    });

    it('refuses unpublished products, unknown variants and bad input', async () => {
      const draft = await request<ErrorBody>('/cart/items', { method: 'POST', cartToken: guestToken, body: { productVariantId: v.D1, quantity: 1 } });
      expect(draft.status).toBe(409);
      expect(draft.body.code).toBe('PRODUCT_UNPUBLISHED');
      expect((await request('/cart/items', { method: 'POST', cartToken: guestToken, body: { productVariantId: '8f8b7a2e-3c41-4f59-9d1e-5b9a2c7d4e10', quantity: 1 } })).status).toBe(404);
      expect((await request('/cart/items', { method: 'POST', cartToken: guestToken, body: { productVariantId: v.A2, quantity: 0 } })).status).toBe(400);
      expect((await request('/cart/items', { method: 'POST', cartToken: guestToken, body: { productVariantId: v.A2, quantity: 101 } })).status).toBe(400);
      const malformed = await request<ErrorBody>('/cart', { cartToken: 'not a token' });
      expect(malformed.status).toBe(400);
      expect(malformed.body.code).toBe('INVALID_CART_TOKEN');
    });

    it('deletes a line; another guest cannot see or touch it', async () => {
      const cart = await request<Cart>('/cart', { cartToken: guestToken });
      const bLine = cart.body.groups.flatMap((group) => group.lines).find((item) => item.productVariantId === v.B1)!;
      const other = await request<Cart>('/cart/items', { method: 'POST', body: { productVariantId: v.A2, quantity: 1 } });
      expect((await request(`/cart/items/${bLine.id}`, { method: 'DELETE', cartToken: other.body.cartToken! })).status).toBe(404);
      const removed = await request<Cart>(`/cart/items/${bLine.id}`, { method: 'DELETE', cartToken: guestToken });
      expect(removed.status).toBe(200);
      expect(removed.body.lineCount).toBe(1);
      // put B1 back for the merge test
      await request('/cart/items', { method: 'POST', cartToken: guestToken, body: { productVariantId: v.B1, quantity: 1 } });
    });

    it('merges the guest cart into the account cart on login, clamped to stock', async () => {
      expect((await addToUserCart(customer.token, v.A1, 2)).status).toBe(200);

      expect((await request('/cart/merge', { method: 'POST', cartToken: guestToken })).status).toBe(401);
      expect((await request('/cart/merge', { method: 'POST', token: customer.token })).status).toBe(400);

      const merged = await request<{ cart: Cart; report: { mergedLines: number; clampedLines: Array<{ applied: number }>; droppedLines: unknown[] } }>(
        '/cart/merge',
        { method: 'POST', token: customer.token, cartToken: guestToken },
      );
      expect(merged.status).toBe(200);
      expect(merged.body.cart.owner).toBe('user');
      const lines = merged.body.cart.groups.flatMap((group) => group.lines);
      expect(lines.find((line) => line.productVariantId === v.A1)?.quantity).toBe(5); // 2 + 5 clamped to stock 5
      expect(lines.find((line) => line.productVariantId === v.B1)?.quantity).toBe(1);
      expect(merged.body.report.clampedLines).toEqual([expect.objectContaining({ applied: 5 })]);

      // The guest cart is gone; merging again is a no-op.
      const again = await request<{ report: { mergedLines: number } }>('/cart/merge', { method: 'POST', token: customer.token, cartToken: guestToken });
      expect(again.status).toBe(200);
      expect(again.body.report.mergedLines).toBe(0);
      expect((await request<Cart>('/cart', { cartToken: guestToken })).body.owner).toBe('none');
    });

    it('groups by store with per-store shipping from the platform policy and store overrides', async () => {
      const line = (await request<Cart>('/cart', { token: customer.token })).body.groups.flatMap((g) => g.lines).find((l) => l.productVariantId === v.A1)!;
      await request(`/cart/items/${line.id}`, { method: 'PATCH', token: customer.token, body: { quantity: 2 } });
      await addToUserCart(customer.token, v.A2, 1);

      const cart = await request<Cart>('/cart', { token: customer.token });
      expect(cart.status).toBe(200);
      const a = cart.body.groups.find((group) => group.vendor.storeSlug === vendorA.storeSlug)!;
      const b = cart.body.groups.find((group) => group.vendor.storeSlug === vendorB.storeSlug)!;
      expect(cart.body.groups).toHaveLength(2);
      // A: 2×1,200,000 + 350,000 = 2,750,000 < platform threshold 3,000,000 → platform fee
      expect(a.itemsSubtotal).toBe('2750000.00');
      expect(a.shipping).toMatchObject({ fee: '450000.00', isFree: false, freeThreshold: '3000000.00' });
      // B: 2,500,000 ≥ store threshold 2,000,000 → free
      expect(b.shipping).toMatchObject({ fee: '0.00', isFree: true, freeThreshold: '2000000.00' });
      expect(cart.body).toMatchObject({ itemsSubtotal: '5250000.00', shippingTotal: '450000.00', payableAmount: '5700000.00', canCheckout: true });
    });

    it('flags availability problems in the cart view', async () => {
      await setStock(v.A2, 0);
      const cart = await request<Cart>('/cart', { token: customer.token });
      const a2 = cart.body.groups.flatMap((g) => g.lines).find((l) => l.productVariantId === v.A2)!;
      expect(a2.issues.map((issue) => issue.code)).toContain('OUT_OF_STOCK');
      expect(cart.body.canCheckout).toBe(false);
      const blocked = await checkout(customer.token, address.id);
      expect(blocked.status).toBe(409);
      expect(blocked.body.code).toBe('CART_NOT_CHECKOUTABLE');
      expect(blocked.body.lines).toEqual([expect.objectContaining({ productVariantId: v.A2, issues: ['OUT_OF_STOCK'] })]);
      expect((await setStock(v.A2, 2)).status).toBe(200);
    });
  });

  // ─── 3. checkout ───────────────────────────────────────────────────────────

  describe('checkout', () => {
    let order: Checkout;

    it('refuses foreign addresses and empty carts', async () => {
      expect((await checkout(customer.token, address2.id)).status).toBe(404);
      const empty = await checkout(customer2.token, address2.id);
      expect(empty.status).toBe(409);
      expect(empty.body.code).toBe('CART_EMPTY');
      expect((await checkout(vendorA.token, address.id)).status).toBe(403);
      expect((await request('/orders/checkout', { method: 'POST', body: { addressId: address.id } })).status).toBe(401);
    });

    it('reports changed prices, refreshes the cart, and succeeds on the next attempt', async () => {
      expect((await request(`/vendor/products/variants/${v.A2}`, { method: 'PATCH', token: vendorA.token, body: { price: 400_000 } })).status).toBe(200);

      const cart = await request<Cart>('/cart', { token: customer.token });
      expect(cart.body.hasPriceChanges).toBe(true);

      const changed = await checkout(customer.token, address.id);
      expect(changed.status).toBe(409);
      expect(changed.body.code).toBe('CART_PRICES_CHANGED');
      expect(changed.body.changes).toEqual([
        expect.objectContaining({ productVariantId: v.A2, previousUnitPrice: '350000.00', currentUnitPrice: '400000.00' }),
      ]);
      expect(await prisma.parentOrder.count({ where: { userId: customer.userId } })).toBe(0);
      expect((await request<Cart>('/cart', { token: customer.token })).body.hasPriceChanges).toBe(false);
    });

    it('creates 1 parent order and 2 store packages with correct money, snapshots and reservations', async () => {
      const before = { A1: await stockOf(v.A1), A2: await stockOf(v.A2), B1: await stockOf(v.B1) };
      const response = await checkout(customer.token, address.id, 'لطفاً قبل از ارسال تماس بگیرید');
      expect(response.status).toBe(201);
      order = response.body;

      expect(order.orderNumber).toMatch(/^SHP-\d{9,}$/);
      expect(order.paymentStatus).toBe('PENDING');
      expect(order.paymentMethod).toBe('CASH_IPG');
      expect(order.subOrders).toHaveLength(2);
      expect(order.subOrders.map((sub) => sub.subOrderNumber)).toEqual([`${order.orderNumber}-1`, `${order.orderNumber}-2`]);
      expect(order.subOrders.every((sub) => sub.status === 'PENDING_APPROVAL')).toBe(true);

      const a = order.subOrders.find((sub) => sub.store.id === vendorA.vendorId)!;
      const b = order.subOrders.find((sub) => sub.store.id === vendorB.vendorId)!;
      // A: 2×1,200,000 + 400,000 = 2,800,000 (< 3,000,000 → fee 450,000); B: 2,500,000 (free from 2,000,000)
      expect(a).toMatchObject({ itemsSubtotal: '2800000.00', shippingFee: '450000.00', total: '3250000.00' });
      expect(b).toMatchObject({ itemsSubtotal: '2500000.00', shippingFee: '0.00', total: '2500000.00' });
      expect(order).toMatchObject({
        totalItemsAmount: '5300000.00',
        totalShippingFee: '450000.00',
        totalDiscountAmount: '0.00',
        finalPayableAmount: '5750000.00',
      });
      expect(new Date(order.paymentExpiresAt).getTime()).toBeGreaterThan(Date.now() + 25 * 60_000);

      // Money identities, checked on the stored rows.
      const parent = await prisma.parentOrder.findUniqueOrThrow({ where: { id: order.parentOrderId }, include: { subOrders: { include: { items: true } } } });
      const sumPackages = parent.subOrders.reduce((sum, sub) => sum.add(sub.itemsSubtotal).add(sub.shippingFee), d(0));
      expect(sumPackages.eq(parent.finalPayableAmount)).toBe(true);
      for (const sub of parent.subOrders) {
        expect(sub.platformCommissionAmount.add(sub.vendorEarningsAmount).eq(sub.itemsSubtotal)).toBe(true);
      }
      const subA = parent.subOrders.find((sub) => sub.vendorId === vendorA.vendorId)!;
      const subB = parent.subOrders.find((sub) => sub.vendorId === vendorB.vendorId)!;
      expect(subA.platformCommissionAmount.toFixed(2)).toBe('210000.00'); // store override 7.5% of 2,800,000
      expect(subB.platformCommissionAmount.toFixed(2)).toBe('250000.00'); // category default 10% of 2,500,000
      expect(subA.items.every((item) => item.commissionRateSnapshot.toFixed(2) === '7.50')).toBe(true);
      expect(subB.items[0]!.commissionRateSnapshot.toFixed(2)).toBe('10.00');
      const a1Item = subA.items.find((item) => item.productVariantId === v.A1)!;
      expect(a1Item).toMatchObject({ skuSnapshot: `ORD-${TAG}-A1`, quantity: 2, productTitleSnapshot: `هدفون آزمون ${RUN}` });
      expect(a1Item.vendorStoreNameSnapshot).toBe(`فروشگاه آزمون سفارش ${vendorA.storeSlug}`);
      expect(a1Item.variantDetailsSnapshot).toMatchObject({ colorName: 'مشکی' });
      expect(parent.shippingAddressSnapshot).toMatchObject({ postalCode: '1969833111', recipientName: 'مریم احمدی' });
      expect(parent.customerNote).toBe('لطفاً قبل از ارسال تماس بگیرید');

      // Stock reserved, not yet sold.
      expect(await stockOf(v.A1)).toEqual({ stock: before.A1.stock, reserved: before.A1.reserved + 2 });
      expect(await stockOf(v.A2)).toEqual({ stock: before.A2.stock, reserved: before.A2.reserved + 1 });
      expect(await stockOf(v.B1)).toEqual({ stock: before.B1.stock, reserved: before.B1.reserved + 1 });

      // Cart emptied, history started, audit row written without address PII.
      expect((await request<Cart>('/cart', { token: customer.token })).body.lineCount).toBe(0);
      expect(await prisma.subOrderStatusHistory.count({ where: { subOrder: { parentOrderId: order.parentOrderId } } })).toBe(2);
      const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: order.parentOrderId, action: AuditAction.CREATE } });
      expect(audit.userId).toBe(customer.userId);
      expect(JSON.stringify(audit.newValue)).not.toContain('1969833111');
    });

    it('keeps item snapshots immutable when the catalogue changes afterwards', async () => {
      await request(`/vendor/products/${productAId}`, { method: 'PATCH', token: vendorA.token, body: { title: `عنوان جدید ${RUN}` } });
      await request(`/vendor/products/variants/${v.A1}`, { method: 'PATCH', token: vendorA.token, body: { price: 1_300_000 } });
      const detail = await request<OrderDetail>(`/customer/orders/${order.parentOrderId}`, { token: customer.token });
      const a1 = detail.body.subOrders.flatMap((sub) => sub.items).find((item) => item.sku === `ORD-${TAG}-A1`)!;
      expect(a1).toMatchObject({ productTitle: `هدفون آزمون ${RUN}`, unitPrice: '1200000.00', lineTotal: '2400000.00' });
      await request(`/vendor/products/variants/${v.A1}`, { method: 'PATCH', token: vendorA.token, body: { price: 1_200_000 } });
    });

    it('lets exactly one of two concurrent checkouts take the last units', async () => {
      const available = (await stockOf(v.A2));
      const units = available.stock - available.reserved; // 1 left
      expect(units).toBe(1);
      await addToUserCart(customer.token, v.A2, units);
      await addToUserCart(customer2.token, v.A2, units);
      const results = await Promise.all([checkout(customer.token, address.id), checkout(customer2.token, address2.id)]);
      expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
      const loser = results.find((result) => result.status === 409)!;
      expect(loser.body.code).toBe('CART_NOT_CHECKOUTABLE');
      expect(await stockOf(v.A2)).toEqual({ stock: available.stock, reserved: available.stock });

      // Release the winner's order again (unpaid cancel) and clear the loser's cart.
      const winnerToken = results[0].status === 201 ? customer.token : customer2.token;
      const winner = results.find((result) => result.status === 201)!.body;
      expect((await request(`/customer/orders/${winner.parentOrderId}/cancel`, { method: 'POST', token: winnerToken, body: {} })).status).toBe(200);
      await clearCart(customer.token);
      await clearCart(customer2.token);
      expect(await stockOf(v.A2)).toEqual({ stock: available.stock, reserved: available.reserved });
    });

    it('does not create two orders from one cart submitted twice at once', async () => {
      await addToUserCart(customer2.token, v.B1, 1);
      const results = await Promise.all([checkout(customer2.token, address2.id), checkout(customer2.token, address2.id)]);
      expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
      expect(results.find((result) => result.status === 409)!.body.code).toBe('CART_EMPTY');
      const winner = results.find((result) => result.status === 201)!.body;
      await request(`/customer/orders/${winner.parentOrderId}/cancel`, { method: 'POST', token: customer2.token, body: {} });
    });

    // ─── 4. customer orders and cancellation ─────────────────────────────────

    describe('customer orders', () => {
      it('lists own orders with the package breakdown; others get 404', async () => {
        const list = await request<Page<{ id: string; orderNumber: string; subOrders: Array<{ storeName: string; itemCount: number }> }>>(
          '/customer/orders?pageSize=10',
          { token: customer.token },
        );
        expect(list.status).toBe(200);
        const mine = list.body.items.find((item) => item.id === order.parentOrderId)!;
        expect(mine.subOrders).toHaveLength(2);
        expect(mine.subOrders.map((sub) => sub.itemCount).sort()).toEqual([1, 2]);
        expect((await request(`/customer/orders/${order.parentOrderId}`, { token: customer2.token })).status).toBe(404);
        const pending = await request<Page<unknown>>('/customer/orders?paymentStatus=PENDING', { token: customer.token });
        expect(pending.body.items).toHaveLength(1);
      });

      it('shows the order detail with address, packages and timeline', async () => {
        const detail = await request<OrderDetail>(`/customer/orders/${order.parentOrderId}`, { token: customer.token });
        expect(detail.status).toBe(200);
        expect(detail.body).toMatchObject({ orderNumber: order.orderNumber, canCancel: true, finalPayableAmount: '5750000.00' });
        expect(detail.body.shippingAddress.postalCode).toBe('1969833111');
        expect(detail.body.timeline[0]).toMatchObject({ type: 'ORDER_PLACED' });
      });

      it('cancels an unpaid order, releases the stock and refuses a second cancel', async () => {
        await addToUserCart(customer.token, v.A1, 1);
        const second = await checkout(customer.token, address.id);
        expect(second.status).toBe(201);
        const reservedBefore = (await stockOf(v.A1)).reserved;

        const cancelled = await request<OrderDetail>(`/customer/orders/${second.body.parentOrderId}/cancel`, {
          method: 'POST',
          token: customer.token,
          body: { reason: 'از خرید منصرف شدم' },
        });
        expect(cancelled.status).toBe(200);
        expect(cancelled.body).toMatchObject({ paymentStatus: 'CANCELLED', canCancel: false });
        expect(cancelled.body.subOrders.every((sub) => sub.status === 'CANCELLED')).toBe(true);
        expect(cancelled.body.timeline.map((event) => event.type)).toEqual(expect.arrayContaining(['ORDER_CANCELLED', 'SUB_ORDER_STATUS']));
        expect((await stockOf(v.A1)).reserved).toBe(reservedBefore - 1);
        expect(cancelled.body.auditLogId).toBeDefined();

        const again = await request<ErrorBody>(`/customer/orders/${second.body.parentOrderId}/cancel`, { method: 'POST', token: customer.token, body: {} });
        expect(again.status).toBe(409);
        expect(again.body.code).toBe('ORDER_NOT_CANCELLABLE');
        expect((await request(`/customer/orders/${order.parentOrderId}/cancel`, { method: 'POST', token: customer2.token, body: {} })).status).toBe(404);
      });
    });

    // ─── 5. payment, vendor fulfilment and isolation ─────────────────────────

    describe('after payment', () => {
      let subA: string;
      let subB: string;

      it('hides unpaid orders from vendors', async () => {
        const list = await request<Page<VendorSubOrder>>('/vendor/orders', { token: vendorA.token });
        expect(list.body.items.find((item) => item.orderNumber === order.orderNumber)).toBeUndefined();
        subA = order.subOrders.find((sub) => sub.store.id === vendorA.vendorId)!.id;
        subB = order.subOrders.find((sub) => sub.store.id === vendorB.vendorId)!.id;
        expect((await request(`/vendor/orders/${subA}`, { token: vendorA.token })).status).toBe(404);
        expect((await request(`/vendor/orders/${subA}/status`, { method: 'PATCH', token: vendorA.token, body: { status: 'PROCESSING' } })).status).toBe(404);
      });

      it('commits the reservation when payment is confirmed (stock and reserved both drop)', async () => {
        const before = { A1: await stockOf(v.A1), B1: await stockOf(v.B1) };
        expect((await lifecycle.markPaid(order.parentOrderId)).applied).toBe(true);
        expect((await lifecycle.markPaid(order.parentOrderId)).applied).toBe(false); // idempotent
        expect(await stockOf(v.A1)).toEqual({ stock: before.A1.stock - 2, reserved: before.A1.reserved - 2 });
        expect(await stockOf(v.B1)).toEqual({ stock: before.B1.stock - 1, reserved: before.B1.reserved - 1 });
        const detail = await request<OrderDetail>(`/customer/orders/${order.parentOrderId}`, { token: customer.token });
        expect(detail.body).toMatchObject({ paymentStatus: 'PAID', canCancel: false });
        expect((await request(`/customer/orders/${order.parentOrderId}/cancel`, { method: 'POST', token: customer.token, body: {} })).status).toBe(409);
      });

      it('shows each vendor only its own package, with address, commission and allowed transitions', async () => {
        const listA = await request<Page<VendorSubOrder>>('/vendor/orders?status=PENDING_APPROVAL', { token: vendorA.token });
        expect(listA.status).toBe(200);
        expect(listA.body.items.map((item) => item.id)).toEqual([subA]);
        expect(listA.body.items[0]).toMatchObject({
          itemsSubtotal: '2800000.00',
          platformCommissionAmount: '210000.00',
          vendorEarningsAmount: '2590000.00',
          allowedTransitions: ['PROCESSING', 'CANCELLED'],
        });
        const detail = await request<VendorSubOrder>(`/vendor/orders/${subA}`, { token: vendorA.token });
        expect(detail.body.shippingAddress?.postalCode).toBe('1969833111');
        expect(detail.body.items?.every((item) => item.commissionRate === '7.50')).toBe(true);
        const searched = await request<Page<VendorSubOrder>>(`/vendor/orders?search=${order.orderNumber}`, { token: vendorB.token });
        expect(searched.body.items.map((item) => item.id)).toEqual([subB]);
      });

      it('forbids vendor A from reading or updating vendor B’s package', async () => {
        expect((await request(`/vendor/orders/${subB}`, { token: vendorA.token })).status).toBe(404);
        expect((await request(`/vendor/orders/${subB}/status`, { method: 'PATCH', token: vendorA.token, body: { status: 'PROCESSING' } })).status).toBe(404);
        expect((await request(`/vendor/orders/${subA}`, { token: customer.token })).status).toBe(403);
        expect((await request('/vendor/orders', { token: adminToken })).status).toBe(403);
        const untouched = await prisma.subOrder.findUniqueOrThrow({ where: { id: subB } });
        expect(untouched.status).toBe('PENDING_APPROVAL');
      });

      it('enforces the state machine and ships with a tracking code', async () => {
        const skip = await request<ErrorBody>(`/vendor/orders/${subA}/status`, {
          method: 'PATCH',
          token: vendorA.token,
          body: { status: 'SHIPPED', trackingCode: 'TRK-1', shippingCarrier: 'پست' },
        });
        expect(skip.status).toBe(409);
        expect(skip.body).toMatchObject({ code: 'INVALID_STATUS_TRANSITION', allowedTransitions: ['PROCESSING', 'CANCELLED'] });

        const processing = await request<{ previousStatus: string; subOrder: VendorSubOrder }>(`/vendor/orders/${subA}/status`, {
          method: 'PATCH',
          token: vendorA.token,
          body: { status: 'PROCESSING' },
        });
        expect(processing.status).toBe(200);
        expect(processing.body).toMatchObject({ previousStatus: 'PENDING_APPROVAL', subOrder: { status: 'PROCESSING', allowedTransitions: ['SHIPPED', 'CANCELLED'] } });

        expect((await request(`/vendor/orders/${subA}/status`, { method: 'PATCH', token: vendorA.token, body: { status: 'SHIPPED' } })).status).toBe(400);
        expect((await request(`/vendor/orders/${subA}/status`, { method: 'PATCH', token: vendorA.token, body: { status: 'SHIPPED', trackingCode: 'TRACK 1', shippingCarrier: 'پست' } })).status).toBe(400);

        const shipped = await request<{ subOrder: VendorSubOrder; auditLogId: string }>(`/vendor/orders/${subA}/status`, {
          method: 'PATCH',
          token: vendorA.token,
          body: { status: 'SHIPPED', trackingCode: '123456789012345678901234', shippingCarrier: 'پست پیشتاز' },
        });
        expect(shipped.status).toBe(200);
        expect(shipped.body.subOrder).toMatchObject({ status: 'SHIPPED', trackingCode: '123456789012345678901234', allowedTransitions: [] });
        expect(shipped.body.subOrder.history?.map((entry) => entry.toStatus)).toEqual(['PENDING_APPROVAL', 'PROCESSING', 'SHIPPED']);
        const audit = await prisma.auditLog.findUniqueOrThrow({ where: { id: shipped.body.auditLogId } });
        expect(audit).toMatchObject({ action: AuditAction.STATUS_CHANGE, entityName: 'SubOrder', entityId: subA, userId: vendorA.userId });

        expect((await request(`/vendor/orders/${subA}/status`, { method: 'PATCH', token: vendorA.token, body: { status: 'CANCELLED', reason: 'دیگر موجود نیست' } })).status).toBe(409);

        const detail = await request<OrderDetail>(`/customer/orders/${order.parentOrderId}`, { token: customer.token });
        const pkg = detail.body.subOrders.find((sub) => sub.id === subA)!;
        expect(pkg).toMatchObject({ trackingCode: '123456789012345678901234', carrierName: 'پست پیشتاز', status: 'SHIPPED' });
        expect(detail.body.timeline.filter((event) => event.type === 'SUB_ORDER_STATUS').map((event) => event.toStatus)).toEqual(['PROCESSING', 'SHIPPED']);
      });

      it('restocks when a vendor cancels a paid package that has not shipped', async () => {
        const before = await stockOf(v.B1);
        expect((await request(`/vendor/orders/${subB}/status`, { method: 'PATCH', token: vendorB.token, body: { status: 'CANCELLED' } })).status).toBe(400); // reason required
        const cancelled = await request<{ stockAction: string; subOrder: VendorSubOrder }>(`/vendor/orders/${subB}/status`, {
          method: 'PATCH',
          token: vendorB.token,
          body: { status: 'CANCELLED', reason: 'نسخه چاپی تمام شده است' },
        });
        expect(cancelled.status).toBe(200);
        expect(cancelled.body).toMatchObject({ stockAction: 'RESTOCKED', subOrder: { status: 'CANCELLED' } });
        expect(await stockOf(v.B1)).toEqual({ stock: before.stock + 1, reserved: before.reserved });
      });

      // ─── 6. staff ──────────────────────────────────────────────────────────

      it('lets staff search globally; support may read but not force', async () => {
        const found = await request<Page<{ id: string; customer: { mobile: string }; subOrders: unknown[] }>>(
          `/admin/orders?search=${order.orderNumber}`,
          { token: supportToken },
        );
        expect(found.status).toBe(200);
        expect(found.body.items.map((item) => item.id)).toEqual([order.parentOrderId]);
        expect(found.body.items[0]!.customer.mobile).toBe(CUSTOMER_MOBILE);
        const byMobile = await request<Page<{ id: string }>>(`/admin/orders?search=09971140003&paymentStatus=PAID`, { token: adminToken });
        expect(byMobile.body.items.map((item) => item.id)).toEqual([order.parentOrderId]);
        const byVendor = await request<Page<{ id: string }>>(`/admin/orders?vendorId=${vendorB.vendorId}&subOrderStatus=CANCELLED`, { token: adminToken });
        expect(byVendor.body.items.map((item) => item.id)).toContain(order.parentOrderId);

        expect((await request(`/admin/sub-orders/${subA}/force-status`, { method: 'PATCH', token: supportToken, body: { status: 'DELIVERED', reason: 'تایید تحویل' } })).status).toBe(403);
        expect((await request('/admin/orders', { token: customer.token })).status).toBe(403);
        expect((await request('/admin/orders', { token: vendorA.token })).status).toBe(403);
      });

      it('forces DELIVERED and REFUNDED with history and audit; unpaid orders are refused', async () => {
        const delivered = await request<{ previousStatus: string; stockAction: string; subOrder: { status: string } }>(
          `/admin/sub-orders/${subA}/force-status`,
          { method: 'PATCH', token: adminToken, body: { status: 'DELIVERED', reason: 'تحویل توسط شرکت پست تایید شد' } },
        );
        expect(delivered.status).toBe(200);
        expect(delivered.body).toMatchObject({ previousStatus: 'SHIPPED', stockAction: 'NONE', subOrder: { status: 'DELIVERED' } });
        expect((await request(`/admin/sub-orders/${subA}/force-status`, { method: 'PATCH', token: adminToken, body: { status: 'DELIVERED', reason: 'دوباره' } })).status).toBe(409);

        const b1Before = await stockOf(v.B1);
        const refunded = await request<{ previousStatus: string; stockAction: string }>(`/admin/sub-orders/${subB}/force-status`, {
          method: 'PATCH',
          token: adminToken,
          body: { status: 'REFUNDED', reason: 'بازپرداخت به مشتری' },
        });
        expect(refunded.status).toBe(200);
        expect(refunded.body).toMatchObject({ previousStatus: 'CANCELLED', stockAction: 'NONE' }); // already restocked on cancel
        expect(await stockOf(v.B1)).toEqual(b1Before);
        const history = await prisma.subOrderStatusHistory.findMany({ where: { subOrderId: subB }, orderBy: { createdAt: 'asc' } });
        expect(history.map((row) => [row.toStatus, row.actorRole])).toEqual([
          ['PENDING_APPROVAL', 'CUSTOMER'],
          ['CANCELLED', 'VENDOR'],
          ['REFUNDED', 'STAFF'],
        ]);

        const cancelledOrder = await prisma.subOrder.findFirstOrThrow({
          where: { parentOrder: { userId: customer.userId, paymentStatus: 'CANCELLED' } },
          select: { id: true },
        });
        const unpaid = await request<ErrorBody>(`/admin/sub-orders/${cancelledOrder.id}/force-status`, {
          method: 'PATCH',
          token: adminToken,
          body: { status: 'REFUNDED', reason: 'آزمون سفارش پرداخت‌نشده' },
        });
        expect(unpaid.status).toBe(409);
        expect(unpaid.body.code).toBe('ORDER_NOT_PAID');
        expect((await request(`/admin/sub-orders/${subA}/force-status`, { method: 'PATCH', token: adminToken, body: { status: 'SHIPPED', reason: 'نامعتبر' } })).status).toBe(400);
      });

      it('restocks a paid package refunded by staff before shipping', async () => {
        await addToUserCart(customer.token, v.A2, 1);
        const placed = await checkout(customer.token, address.id);
        expect(placed.status).toBe(201);
        await lifecycle.markPaid(placed.body.parentOrderId);
        const before = await stockOf(v.A2);
        const refunded = await request<{ stockAction: string }>(`/admin/sub-orders/${placed.body.subOrders[0]!.id}/force-status`, {
          method: 'PATCH',
          token: adminToken,
          body: { status: 'REFUNDED', reason: 'درخواست انصراف پیش از پردازش' },
        });
        expect(refunded.status).toBe(200);
        expect(refunded.body.stockAction).toBe('RESTOCKED');
        expect(await stockOf(v.A2)).toEqual({ stock: before.stock + 1, reserved: before.reserved });
      });
    });

    // ─── 7. payment failure and expiry ───────────────────────────────────────

    describe('unpaid orders that never complete', () => {
      it('releases the reservation when payment fails', async () => {
        await addToUserCart(customer2.token, v.B1, 1);
        const placed = await checkout(customer2.token, address2.id);
        expect(placed.status).toBe(201);
        const reserved = (await stockOf(v.B1)).reserved;
        expect(await lifecycle.markPaymentFailed(placed.body.parentOrderId, 'Gateway declined')).toBe(true);
        expect((await stockOf(v.B1)).reserved).toBe(reserved - 1);
        const detail = await request<OrderDetail>(`/customer/orders/${placed.body.parentOrderId}`, { token: customer2.token });
        expect(detail.body.paymentStatus).toBe('FAILED');
        expect(detail.body.timeline.map((event) => event.type)).toContain('PAYMENT_FAILED');
        expect((await lifecycle.markPaid(placed.body.parentOrderId)).applied).toBe(false);
      });

      it('cancels orders whose payment window passed and releases their stock', async () => {
        await addToUserCart(customer2.token, v.A1, 1);
        const placed = await checkout(customer2.token, address2.id);
        expect(placed.status).toBe(201);
        const reserved = (await stockOf(v.A1)).reserved;
        expect(await lifecycle.expireOverdue(new Date())).toBe(0); // not due yet

        await prisma.parentOrder.update({ where: { id: placed.body.parentOrderId }, data: { paymentExpiresAt: new Date(Date.now() - 1000) } });
        expect(await lifecycle.expireOverdue(new Date())).toBeGreaterThanOrEqual(1);
        expect((await stockOf(v.A1)).reserved).toBe(reserved - 1);
        const row = await prisma.parentOrder.findUniqueOrThrow({ where: { id: placed.body.parentOrderId }, include: { subOrders: true } });
        expect(row.paymentStatus).toBe('CANCELLED');
        expect(row.cancellationReason).toBe('Payment was not completed in time');
        expect(row.subOrders.every((sub) => sub.status === 'CANCELLED')).toBe(true);
        expect((await lifecycle.markPaid(placed.body.parentOrderId)).applied).toBe(false);
      });
    });
  });

  // ─── 8. database guarantees ─────────────────────────────────────────────────

  describe('database guarantees', () => {
    it('rejects SHIPPED without a tracking code and broken money identities', async () => {
      const sub = await prisma.subOrder.findFirstOrThrow({ where: { parentOrder: { userId: customer.userId } }, select: { id: true } });
      await expect(
        prisma.$executeRaw`UPDATE sub_orders SET status = 'SHIPPED', tracking_code = NULL WHERE id = ${sub.id}::uuid`,
      ).rejects.toThrow(/sub_orders_shipped_tracking_check|check constraint/);
      await expect(
        prisma.$executeRaw`UPDATE sub_orders SET vendor_earnings_amount = vendor_earnings_amount + 1 WHERE id = ${sub.id}::uuid`,
      ).rejects.toThrow(/check constraint/);
      const parent = await prisma.parentOrder.findFirstOrThrow({ where: { userId: customer.userId }, select: { id: true } });
      await expect(
        prisma.$executeRaw`UPDATE parent_orders SET final_payable_amount = final_payable_amount + 1 WHERE id = ${parent.id}::uuid`,
      ).rejects.toThrow(/check constraint/);
    });
  });

  // ─── 9. OpenAPI ─────────────────────────────────────────────────────────────

  describe('Swagger', () => {
    it('documents every Phase-6 route with its tag', () => {
      const document = buildOpenApiDocument(app) as unknown as {
        paths: Record<string, Record<string, { tags?: string[]; responses: Record<string, unknown> }>>;
        tags: Array<{ name: string }>;
      };
      const expected: Array<[string, string, string]> = [
        ['/api/v1/customer/addresses', 'post', 'customer-addresses'],
        ['/api/v1/customer/addresses', 'get', 'customer-addresses'],
        ['/api/v1/customer/addresses/{id}', 'patch', 'customer-addresses'],
        ['/api/v1/customer/addresses/{id}', 'delete', 'customer-addresses'],
        ['/api/v1/cart', 'get', 'cart'],
        ['/api/v1/cart/items', 'post', 'cart'],
        ['/api/v1/cart/items/{id}', 'patch', 'cart'],
        ['/api/v1/cart/items/{id}', 'delete', 'cart'],
        ['/api/v1/cart/clear', 'post', 'cart'],
        ['/api/v1/cart/merge', 'post', 'cart'],
        ['/api/v1/orders/checkout', 'post', 'orders'],
        ['/api/v1/customer/orders', 'get', 'customer-orders'],
        ['/api/v1/customer/orders/{id}', 'get', 'customer-orders'],
        ['/api/v1/customer/orders/{id}/cancel', 'post', 'customer-orders'],
        ['/api/v1/vendor/orders', 'get', 'vendor-orders'],
        ['/api/v1/vendor/orders/{id}', 'get', 'vendor-orders'],
        ['/api/v1/vendor/orders/{id}/status', 'patch', 'vendor-orders'],
        ['/api/v1/admin/orders', 'get', 'admin-orders'],
        ['/api/v1/admin/sub-orders/{id}/force-status', 'patch', 'admin-orders'],
      ];
      for (const [path, method, tag] of expected) {
        const operation = document.paths[path]?.[method];
        expect({ path, method, documented: operation !== undefined }).toEqual({ path, method, documented: true });
        expect(operation!.tags).toContain(tag);
        expect(Object.keys(operation!.responses).length).toBeGreaterThanOrEqual(2);
      }
      expect(document.tags.map((tag) => tag.name)).toEqual(
        expect.arrayContaining(['customer-addresses', 'cart', 'orders', 'customer-orders', 'vendor-orders', 'admin-orders']),
      );
    });
  });
});
