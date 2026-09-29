import { ConfigService } from '@nestjs/config';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { WalletTransactionType } from '@prisma/client';
import { AuditAction, Prisma, WalletBalanceBucket } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { GLOBAL_API_PREFIX } from '../src/common/constants';
import { PrismaService } from '../src/infra/prisma/prisma.service';
import { RedisService } from '../src/infra/redis/redis.service';
import { normalizeIdentifier } from '../src/modules/auth/auth.service';
import { OtpKeys } from '../src/modules/auth/otp.service';
import { loginAttemptsKey, loginLockKey } from '../src/modules/auth/token.service';
import { CategoriesService } from '../src/modules/categories/categories.service';
import { OrderLifecycleService } from '../src/modules/orders/order-lifecycle.service';
import { SETTLEMENT_MIN_AMOUNT_KEY } from '../src/modules/settlements/settlements.service';
import { SHIPPING_CONFIG_KEYS } from '../src/modules/shipping/shipping-calculator.service';
import { SMS_PROVIDER } from '../src/modules/sms/sms-provider.interface';
import type { SmsProvider } from '../src/modules/sms/sms-provider.interface';
import type { SandboxSmsProvider } from '../src/modules/sms/providers/sandbox-sms.provider';
import { STORAGE_PROVIDER, type StorageProvider } from '../src/modules/storage/storage-provider.interface';
import { WalletLedgerService } from '../src/modules/wallet/wallet-ledger.service';
import { applyGlobalPolicies, buildOpenApiDocument } from '../src/setup/app.setup';

/**
 * End-to-end verification of Phase 7 — card payment through the gateway
 * abstraction, escrow wallet ledger, escrow release on delivery, refunds and
 * vendor settlements — against the real PostgreSQL 16 and Redis 7 of
 * docker-compose.
 *
 * The active gateway is the SANDBOX provider (PAYMENT_GATEWAY_PROVIDER=sandbox,
 * development only): the suite drives it exactly as a browser would — initiate
 * → sandbox bank page → Pay/Decline form POST → 303 to the callback → callback
 * verifies server-to-server against the sandbox bank state in Redis. Nothing is
 * stubbed inside the API.
 *
 * Money (IRR). Store A has a 7.5% commission override, store B uses the 10%
 * category rate; platform shipping 450,000 per package (not credited to
 * vendors — earnings = items − commission, Phase 6 rule):
 *   A1 3,000,000 × 2 = 6,000,000 → commission 450,000 → earnings 5,550,000
 *   B1 3,000,000 × 1 = 3,000,000 → commission 300,000 → earnings 2,700,000
 *   payable = 6,000,000 + 3,000,000 + 2 × 450,000 = 9,900,000
 */

const TEST_UA = 'shopino-finance-e2e/1.0';
const RUN = Date.now().toString(36);
const TAG = RUN.toUpperCase();

const VENDOR_A_MOBILE = '+989971150001';
const VENDOR_B_MOBILE = '+989971150002';
const CUSTOMER_MOBILE = '+989971150003';
const CUSTOMER_2_MOBILE = '+989971150004';
const SUITE_MOBILES = [VENDOR_A_MOBILE, VENDOR_B_MOBILE, CUSTOMER_MOBILE, CUSTOMER_2_MOBILE];
const IBAN_A = 'IR820540102680020817909002';
const IBAN_B = 'IR570629600000001003242001';
const OTHER_VALID_IBAN = 'IR550540102680020817909003';
const SEEDED_ADMIN_EMAIL = 'admin@shopino.local';
const SEEDED_SUPPORT_EMAIL = 'support@shopino.local';
const SEEDED_FINANCE_EMAIL = 'finance@shopino.local';

const PLATFORM_FEE = '450000';
const PLATFORM_FREE_THRESHOLD = '20000000';

interface HttpResult<T> {
  status: number;
  body: T;
  headers: Record<string, unknown>;
}

interface ErrorBody {
  code?: string;
  message: string | string[];
}

interface Checkout {
  parentOrderId: string;
  orderNumber: string;
  finalPayableAmount: string;
  subOrders: Array<{ id: string; store: { id: string }; status: string }>;
}

interface Initiated {
  paymentId: string;
  redirectUrl: string;
  gatewayName: string;
  amount: string;
  currency: string;
  orderNumber: string;
}

interface Outcome {
  outcome: 'PAID' | 'FAILED' | 'VERIFICATION_PENDING' | 'PAID_REQUIRES_REFUND';
  paymentId: string;
  paymentStatus: string;
  parentOrderId: string;
  orderNumber: string;
  orderPaymentStatus: string;
  bankRrn: string | null;
  canRetry: boolean;
}

interface Wallet {
  pendingBalance: string;
  withdrawableBalance: string;
  settlementHoldBalance: string;
  totalEarnedBalance: string;
  totalWithdrawnAmount: string;
  currency: string;
}

interface LedgerRow {
  type: WalletTransactionType;
  bucket: WalletBalanceBucket;
  amount: string;
  balanceAfter: string;
  subOrderId: string | null;
  subOrderNumber: string | null;
  settlementRequestId: string | null;
}

interface Settlement {
  id: string;
  vendorId: string;
  amount: string;
  targetIban: string;
  status: string;
  bankPayaReference: string | null;
  rejectionReason: string | null;
  processedBy: { id: string } | null;
  auditLogId?: string;
}

interface Page<T> {
  items: T[];
  total: number;
}

interface Transition {
  previousStatus: string;
  walletAction: string;
  stockAction: string;
}

const d = (value: string | number | Prisma.Decimal): Prisma.Decimal => new Prisma.Decimal(value);

describe('Phase 7 — payments, escrow wallet and settlements (live stack)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let lifecycle: OrderLifecycleService;

  let adminToken: string;
  let supportToken: string;
  let financeToken: string;
  let financeUserId: string;
  let vendorA: { token: string; userId: string; vendorId: string };
  let vendorB: { token: string; userId: string; vendorId: string };
  let customer: { token: string; userId: string };
  let customer2: { token: string; userId: string };
  let categoryId: string;
  let addressId: string;
  const v: Record<'A1' | 'B1', string> = {} as never;
  let savedConfigs: Array<{ key: string; value: string; valueType: never; description: string | null }> = [];
  const paymentIds: string[] = [];

  /** The main order of the suite (A1×2 + B1×1). */
  let order: Checkout;
  let subA: string;
  let subB: string;

  const API = `/${GLOBAL_API_PREFIX}`;

  const request = async <T>(
    url: string,
    options: { method?: 'GET' | 'POST' | 'PATCH'; token?: string; body?: unknown; form?: Record<string, string> } = {},
  ): Promise<HttpResult<T>> => {
    const headers: Record<string, string> = { 'user-agent': TEST_UA };
    if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
    let payload: string | undefined;
    if (options.form !== undefined) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      payload = new URLSearchParams(options.form).toString();
    } else if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(options.body);
    }
    const response = await app.inject({ method: options.method ?? 'GET', url: `${API}${url}`, headers, ...(payload === undefined ? {} : { payload }) });
    const isJson = String(response.headers['content-type'] ?? '').includes('application/json');
    return {
      status: response.statusCode,
      body: (isJson && response.body.length > 0 ? JSON.parse(response.body) : response.body) as T,
      headers: response.headers,
    };
  };

  const loginWithOtp = async (mobile: string): Promise<{ token: string; userId: string }> => {
    expect((await request('/auth/otp/request', { method: 'POST', body: { mobile } })).status).toBe(200);
    const code = (app.get<SmsProvider>(SMS_PROVIDER) as SandboxSmsProvider).latestOtpCode(mobile);
    const verified = await request<{ accessToken: string; user: { id: string } }>('/auth/otp/verify', { method: 'POST', body: { mobile, code } });
    expect(verified.status).toBe(200);
    return { token: verified.body.accessToken, userId: verified.body.user.id };
  };

  const loginWithPassword = async (identifier: string, password: string): Promise<{ token: string; userId: string }> => {
    const response = await request<{ accessToken: string; user: { id: string } }>('/auth/login/password', { method: 'POST', body: { identifier, password } });
    expect(response.status).toBe(200);
    return { token: response.body.accessToken, userId: response.body.user.id };
  };

  const onboardStore = async (login: { token: string }, storeSlug: string, iban: string, commissionRateOverride: number | null): Promise<string> => {
    const registered = await request<{ id: string }>('/vendors/register', {
      method: 'POST',
      token: login.token,
      body: { storeName: `فروشگاه آزمون مالی ${storeSlug}`, storeSlug, bio: 'فروشگاه آزمون فاز هفت', bankIban: iban, bankAccountHolder: 'شرکت آزمون مالی' },
    });
    expect(registered.status).toBe(201);
    const form = new FormData();
    const pdf = Buffer.concat([Buffer.from(`%PDF-1.7\n% finance e2e ${RUN}\n`, 'latin1'), Buffer.from('%%EOF', 'latin1')]);
    form.append('file', new Blob([new Uint8Array(pdf)], { type: 'application/pdf' }), 'national-id.pdf');
    form.append('purpose', 'kyc_national_id');
    const serialized = new Response(form);
    const uploaded = await app.inject({
      method: 'POST',
      url: `${API}/media/upload/document`,
      headers: { authorization: `Bearer ${login.token}`, 'user-agent': TEST_UA, 'content-type': serialized.headers.get('content-type') ?? '' },
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

  const createProduct = async (token: string, title: string, sku: string, price: number, stockQuantity: number): Promise<string> => {
    const response = await request<{ variants: Array<{ id: string }> }>('/vendor/products', {
      method: 'POST',
      token,
      body: { title, categoryId, basePrice: price, isPublished: true, variants: [{ sku, price, stockQuantity }] },
    });
    expect(response.status).toBe(201);
    return response.body.variants[0]!.id;
  };

  const placeOrder = async (lines: Array<[string, number]>, token = customer.token, address = addressId): Promise<Checkout> => {
    expect((await request('/cart/clear', { method: 'POST', token })).status).toBe(200);
    for (const [productVariantId, quantity] of lines) {
      expect((await request('/cart/items', { method: 'POST', token, body: { productVariantId, quantity } })).status).toBe(200);
    }
    const placed = await request<Checkout>('/orders/checkout', { method: 'POST', token, body: { addressId: address } });
    expect(placed.status).toBe(201);
    return placed.body;
  };

  const initiate = async (parentOrderId: string, token = customer.token): Promise<Initiated> => {
    const response = await request<Initiated>('/payments/initiate', { method: 'POST', token, body: { parentOrderId } });
    expect(response.status).toBe(201);
    paymentIds.push(response.body.paymentId);
    return response.body;
  };

  /** The payer's decision on the sandbox bank page; returns the callback path the browser is redirected to. */
  const decide = async (paymentId: string, decision: 'PAY' | 'DECLINE'): Promise<string> => {
    const response = await request(`/sandbox/payment-page/${paymentId}/decision`, { method: 'POST', form: { decision } });
    expect(response.status).toBe(303);
    const location = new URL(String(response.headers['location']));
    expect(location.pathname).toBe(`${API}/payments/callback`);
    return `${location.pathname.slice(API.length)}${location.search}`;
  };

  const payThroughSandbox = async (parentOrderId: string, decision: 'PAY' | 'DECLINE'): Promise<{ initiated: Initiated; callbackPath: string; outcome: HttpResult<Outcome> }> => {
    const initiated = await initiate(parentOrderId);
    const callbackPath = await decide(initiated.paymentId, decision);
    const outcome = await request<Outcome>(callbackPath);
    return { initiated, callbackPath, outcome };
  };

  const wallet = async (token: string): Promise<Wallet> => {
    const response = await request<Wallet>('/vendor/wallet', { token });
    expect(response.status).toBe(200);
    return response.body;
  };

  const ledger = async (token: string, query = ''): Promise<LedgerRow[]> => {
    const response = await request<Page<LedgerRow>>(`/vendor/wallet/transactions?pageSize=100${query}`, { token });
    expect(response.status).toBe(200);
    return response.body.items;
  };

  const stockOf = async (variantId: string): Promise<{ stock: number; reserved: number }> => {
    const row = await prisma.productVariant.findUniqueOrThrow({ where: { id: variantId }, select: { stockQuantity: true, reservedQuantity: true } });
    return { stock: row.stockQuantity, reserved: row.reservedQuantity };
  };

  /** Ledger invariant: per bucket, SUM(amount) = wallet column and the latest balanceAfter = wallet column. */
  const expectReconciled = async (vendorId: string): Promise<void> => {
    const w = await prisma.vendorWallet.findUniqueOrThrow({ where: { vendorId } });
    const rows = await prisma.walletTransaction.findMany({ where: { walletId: w.id } });
    const columns: Record<WalletBalanceBucket, Prisma.Decimal> = {
      PENDING: w.pendingBalance,
      WITHDRAWABLE: w.withdrawableBalance,
      SETTLEMENT_HOLD: w.settlementHoldBalance,
      DISPUTE_HOLD: w.disputeHoldBalance,
    };
    for (const bucket of Object.values(WalletBalanceBucket)) {
      const inBucket = rows.filter((row) => row.bucket === bucket);
      const sum = inBucket.reduce((acc, row) => acc.plus(row.amount), d(0));
      expect(sum.toFixed(2)).toBe(columns[bucket].toFixed(2));
      // balanceAfter chains: each row = previous balance + amount (rows of one transaction share a timestamp, so check the chain as a set)
      const afters = new Set(inBucket.map((row) => row.balanceAfter.toFixed(2)));
      if (inBucket.length > 0) expect(afters.has(columns[bucket].toFixed(2))).toBe(true);
    }
  };

  const setConfig = async (key: string, value: string): Promise<void> => {
    await prisma.systemConfig.upsert({ where: { key }, update: { value }, create: { key, value, valueType: 'NUMBER', description: `finance e2e ${RUN}` } });
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
    adminToken = (await loginWithPassword(SEEDED_ADMIN_EMAIL, adminPassword)).token;
    supportToken = (await loginWithPassword(SEEDED_SUPPORT_EMAIL, staffPassword)).token;
    const finance = await loginWithPassword(SEEDED_FINANCE_EMAIL, staffPassword);
    financeToken = finance.token;
    financeUserId = finance.userId;

    const configKeys = [...Object.values(SHIPPING_CONFIG_KEYS), SETTLEMENT_MIN_AMOUNT_KEY];
    savedConfigs = (await prisma.systemConfig.findMany({
      where: { key: { in: configKeys } },
      select: { key: true, value: true, valueType: true, description: true },
    })) as never;
    await setConfig(SHIPPING_CONFIG_KEYS.defaultFeePerVendor, PLATFORM_FEE);
    await setConfig(SHIPPING_CONFIG_KEYS.freeThresholdPerVendor, PLATFORM_FREE_THRESHOLD);
    await setConfig(SETTLEMENT_MIN_AMOUNT_KEY, '5000000.00'); // the seeded value, pinned for determinism

    const category = await request<{ id: string }>('/admin/categories', {
      method: 'POST',
      token: adminToken,
      body: { slug: `e2e-fin-${RUN}`, titleFa: `دسته آزمون مالی ${RUN}`, defaultCommissionRate: 10 },
    });
    expect(category.status).toBe(201);
    categoryId = category.body.id;

    const a = await loginWithOtp(VENDOR_A_MOBILE);
    const b = await loginWithOtp(VENDOR_B_MOBILE);
    customer = await loginWithOtp(CUSTOMER_MOBILE);
    customer2 = await loginWithOtp(CUSTOMER_2_MOBILE);
    vendorA = { ...a, vendorId: await onboardStore(a, `fin-e2e-a-${RUN}`, IBAN_A, 7.5) };
    vendorB = { ...b, vendorId: await onboardStore(b, `fin-e2e-b-${RUN}`, IBAN_B, null) };
    v.A1 = await createProduct(vendorA.token, `لپ‌تاپ آزمون مالی ${RUN}`, `FIN-${TAG}-A1`, 3_000_000, 10);
    v.B1 = await createProduct(vendorB.token, `مانیتور آزمون مالی ${RUN}`, `FIN-${TAG}-B1`, 3_000_000, 10);

    const address = await request<{ id: string }>('/customer/addresses', {
      method: 'POST',
      token: customer.token,
      body: {
        province: 'تهران',
        city: 'تهران',
        postalAddress: 'خیابان آزادی، پلاک ۷',
        postalCode: '1458889999',
        buildingNumber: '7',
        unitNumber: '2',
        recipientName: 'مشتری آزمون مالی',
        recipientMobile: '09971150003',
      },
    });
    expect(address.status).toBe(201);
    addressId = address.body.id;
  }, 180_000);

  afterAll(async () => {
    if (prisma !== undefined) {
      const users = await prisma.user.findMany({ where: { mobile: { in: SUITE_MOBILES } }, select: { id: true } });
      const userIds = users.map((user) => user.id);
      const vendors = await prisma.vendor.findMany({ where: { userId: { in: userIds } }, select: { id: true } });
      const vendorIds = vendors.map((vendor) => vendor.id);
      const orders = await prisma.parentOrder.findMany({ where: { userId: { in: userIds } }, select: { id: true, subOrders: { select: { id: true } } } });
      const orderIds = orders.map((row) => row.id);
      const subIds = orders.flatMap((row) => row.subOrders.map((sub) => sub.id));
      const payments = await prisma.payment.findMany({ where: { parentOrderId: { in: orderIds } }, select: { id: true } });
      const settlements = await prisma.settlementRequest.findMany({ where: { vendorId: { in: vendorIds } }, select: { id: true } });
      const products = await prisma.product.findMany({ where: { vendorId: { in: vendorIds } }, select: { id: true, variants: { select: { id: true } } } });
      const productIds = products.map((row) => row.id);
      const variantIds = products.flatMap((row) => row.variants.map((variant) => variant.id));
      const entityIds = [...vendorIds, ...productIds, ...variantIds, ...orderIds, ...subIds, ...payments.map((p) => p.id), ...settlements.map((s) => s.id), categoryId];

      await prisma.auditLog.deleteMany({ where: { OR: [{ userId: { in: userIds } }, { userAgent: TEST_UA }, { entityId: { in: entityIds.filter(Boolean) } }] } });
      await prisma.vendorWallet.deleteMany({ where: { vendorId: { in: vendorIds } } }); // cascades to the ledger
      await prisma.settlementRequest.deleteMany({ where: { vendorId: { in: vendorIds } } });
      await prisma.payment.deleteMany({ where: { parentOrderId: { in: orderIds } } });
      await prisma.parentOrder.deleteMany({ where: { id: { in: orderIds } } });
      await prisma.cart.deleteMany({ where: { OR: [{ userId: { in: userIds } }, { items: { some: { productVariantId: { in: variantIds } } } }] } });
      await prisma.address.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.productVariant.deleteMany({ where: { productId: { in: productIds } } });
      await prisma.product.deleteMany({ where: { id: { in: productIds } } });
      if (categoryId !== undefined) await prisma.category.deleteMany({ where: { id: categoryId } });

      const storage = app.get<StorageProvider>(STORAGE_PROVIDER);
      const assets = await prisma.mediaAsset.findMany({ where: { ownerUserId: { in: userIds } }, select: { path: true } });
      for (const asset of assets) await storage.delete(asset.path).catch(() => false);
      await prisma.vendorVerification.deleteMany({ where: { vendorId: { in: vendorIds } } });
      await prisma.mediaAsset.deleteMany({ where: { ownerUserId: { in: userIds } } });
      await prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
      await prisma.customerProfile.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });

      await prisma.systemConfig.deleteMany({ where: { key: { in: [...Object.values(SHIPPING_CONFIG_KEYS), SETTLEMENT_MIN_AMOUNT_KEY] } } });
      for (const row of savedConfigs) await prisma.systemConfig.create({ data: row });
      await app.get(CategoriesService).invalidateTree();

      const redis = app.get(RedisService);
      for (const paymentId of paymentIds) {
        const authority = await redis.client.get(`payment:sandbox:payment:${paymentId}`);
        await redis.client.del(`payment:sandbox:payment:${paymentId}`, ...(authority ? [`payment:sandbox:session:${authority}`] : []));
      }
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
      ...[SEEDED_ADMIN_EMAIL, SEEDED_SUPPORT_EMAIL, SEEDED_FINANCE_EMAIL].flatMap((identifier) => [
        loginAttemptsKey(normalizeIdentifier(identifier)),
        loginLockKey(normalizeIdentifier(identifier)),
      ]),
    ];
    if (keys.length > 0) await redis.client.del(...keys);
  }

  // ─── 1. initiate ───────────────────────────────────────────────────────────

  describe('payment initiation', () => {
    beforeAll(async () => {
      order = await placeOrder([
        [v.A1, 2],
        [v.B1, 1],
      ]);
      subA = order.subOrders.find((sub) => sub.store.id === vendorA.vendorId)!.id;
      subB = order.subOrders.find((sub) => sub.store.id === vendorB.vendorId)!.id;
    });

    it('prices the order as documented (9,900,000 IRR)', () => {
      expect(order.finalPayableAmount).toBe('9900000.00');
    });

    it('enforces authentication, role and ownership', async () => {
      const body = { parentOrderId: order.parentOrderId };
      expect((await request('/payments/initiate', { method: 'POST', body })).status).toBe(401);
      expect((await request('/payments/initiate', { method: 'POST', token: vendorA.token, body })).status).toBe(403);
      expect((await request('/payments/initiate', { method: 'POST', token: customer2.token, body })).status).toBe(404);
      expect((await request('/payments/initiate', { method: 'POST', token: customer.token, body: { parentOrderId: 'not-a-uuid' } })).status).toBe(400);
    });

    it('creates an INITIATED payment and returns the sandbox bank page', async () => {
      const initiated = await initiate(order.parentOrderId);
      expect(initiated).toMatchObject({ gatewayName: 'SANDBOX', amount: '9900000.00', currency: 'IRR', orderNumber: order.orderNumber });
      expect(initiated.redirectUrl).toMatch(new RegExp(`/api/v1/sandbox/payment-page/${initiated.paymentId}$`));

      const row = await prisma.payment.findUniqueOrThrow({ where: { id: initiated.paymentId } });
      expect(row).toMatchObject({ status: 'INITIATED', gatewayName: 'SANDBOX', parentOrderId: order.parentOrderId });
      expect(row.cashAmount.toFixed(2)).toBe('9900000.00');
      expect(row.gatewayTrackingToken).toMatch(/^SBX[0-9A-F]{32}$/);
      expect(await prisma.auditLog.count({ where: { entityName: 'Payment', entityId: initiated.paymentId, action: AuditAction.CREATE } })).toBe(1);

      const page = await request<string>(`/sandbox/payment-page/${initiated.paymentId}`);
      expect(page.status).toBe(200);
      expect(String(page.headers['content-type'])).toContain('text/html');
      expect(page.body).toContain(order.orderNumber);
      expect(page.body).toContain('SANDBOX');
      expect(page.body).toContain('۹٬۹۰۰٬۰۰۰'); // fa-IR formatted amount
      expect((await request(`/sandbox/payment-page/${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}`)).status).toBe(404);
    });

    it('keeps packages hidden from vendors while the order is unpaid', async () => {
      const list = await request<Page<{ orderNumber: string }>>('/vendor/orders', { token: vendorA.token });
      expect(list.body.items.some((row) => row.orderNumber === order.orderNumber)).toBe(false);
    });
  });

  // ─── 2. failure, forged callbacks, retry, success ─────────────────────────

  describe('callback processing', () => {
    it('a declined payment fails the Payment but keeps the order payable with its stock reserved', async () => {
      const before = await stockOf(v.A1);
      const { outcome, initiated } = await payThroughSandbox(order.parentOrderId, 'DECLINE');
      expect(outcome.status).toBe(200);
      expect(outcome.body).toMatchObject({ outcome: 'FAILED', paymentStatus: 'FAILED', orderPaymentStatus: 'PENDING', canRetry: true, bankRrn: null });
      expect((await prisma.payment.findUniqueOrThrow({ where: { id: initiated.paymentId } })).status).toBe('FAILED');
      expect(await stockOf(v.A1)).toEqual(before);
      expect((await prisma.parentOrder.findUniqueOrThrow({ where: { id: order.parentOrderId } })).paymentStatus).toBe('PENDING');
      expect(await prisma.walletTransaction.count({ where: { subOrderId: { in: [subA, subB] } } })).toBe(0);
    });

    it('never trusts the redirect: a forged Status=OK for an unpaid bank session is verified and rejected', async () => {
      const initiated = await initiate(order.parentOrderId);
      const token = (await prisma.payment.findUniqueOrThrow({ where: { id: initiated.paymentId } })).gatewayTrackingToken!;
      const forged = await request<Outcome>(`/payments/callback?Authority=${token}&Status=OK`);
      expect(forged.status).toBe(200);
      expect(forged.body).toMatchObject({ outcome: 'FAILED', orderPaymentStatus: 'PENDING' });
      const row = await prisma.payment.findUniqueOrThrow({ where: { id: initiated.paymentId } });
      expect(row.status).toBe('FAILED');
      expect(row.metadata).toMatchObject({ code: 'NOT_PAID' });
    });

    it('rejects callbacks without a token (400) and with an unknown token (404)', async () => {
      expect((await request<ErrorBody>('/payments/callback?Status=OK')).body.code).toBe('INVALID_CALLBACK');
      expect((await request('/payments/callback?Status=OK')).status).toBe(400);
      expect((await request('/payments/callback?Authority=SBXDOESNOTEXIST&Status=OK')).status).toBe(404);
    });

    it('a successful payment completes the order atomically: PAID, PENDING_APPROVAL, stock committed, escrow credited', async () => {
      const stockA = await stockOf(v.A1);
      const stockB = await stockOf(v.B1);
      const { outcome, initiated, callbackPath } = await payThroughSandbox(order.parentOrderId, 'PAY');
      expect(callbackPath).toMatch(/Status=OK/);
      expect(outcome.status).toBe(200);
      expect(outcome.body).toMatchObject({ outcome: 'PAID', paymentStatus: 'SUCCESSFUL', orderPaymentStatus: 'PAID', orderNumber: order.orderNumber, canRetry: false });
      expect(outcome.body.bankRrn).toMatch(/^\d{12}$/);

      const payment = await prisma.payment.findUniqueOrThrow({ where: { id: initiated.paymentId } });
      expect(payment.status).toBe('SUCCESSFUL');
      expect(payment.bankRrn).toBe(outcome.body.bankRrn);
      expect(payment.paidAt).not.toBeNull();
      expect(payment.metadata).toMatchObject({ verifyCode: '100', escrowHeld: '8250000.00' });

      const parent = await prisma.parentOrder.findUniqueOrThrow({ where: { id: order.parentOrderId }, include: { subOrders: true } });
      expect(parent.paymentStatus).toBe('PAID');
      expect(parent.subOrders.map((sub) => sub.status)).toEqual(['PENDING_APPROVAL', 'PENDING_APPROVAL']);

      // stock -= q and reserved -= q
      expect(await stockOf(v.A1)).toEqual({ stock: stockA.stock - 2, reserved: stockA.reserved - 2 });
      expect(await stockOf(v.B1)).toEqual({ stock: stockB.stock - 1, reserved: stockB.reserved - 1 });

      // exact escrow credit: earnings = items − commission
      expect(await wallet(vendorA.token)).toMatchObject({ pendingBalance: '5550000.00', withdrawableBalance: '0.00', totalEarnedBalance: '0.00', currency: 'IRR' });
      expect(await wallet(vendorB.token)).toMatchObject({ pendingBalance: '2700000.00', withdrawableBalance: '0.00' });
      const rowsA = await ledger(vendorA.token);
      expect(rowsA).toHaveLength(1);
      expect(rowsA[0]).toMatchObject({
        type: 'CREDIT_SALE_ESCROW_HOLD',
        bucket: 'PENDING',
        amount: '5550000.00',
        balanceAfter: '5550000.00',
        subOrderId: subA,
      });
      expect(rowsA[0]!.subOrderNumber).toBe((await prisma.subOrder.findUniqueOrThrow({ where: { id: subA } })).subOrderNumber);
      await expectReconciled(vendorA.vendorId);
      await expectReconciled(vendorB.vendorId);

      expect(await prisma.auditLog.count({ where: { entityName: 'Payment', entityId: initiated.paymentId, action: AuditAction.PAYMENT_CAPTURE } })).toBe(1);
      expect(await prisma.auditLog.count({ where: { entityName: 'ParentOrder', entityId: order.parentOrderId, action: AuditAction.PAYMENT_CAPTURE } })).toBe(1);
    });

    it('repeated callbacks (GET or form POST) return the same outcome and never apply twice', async () => {
      const payment = await prisma.payment.findFirstOrThrow({ where: { parentOrderId: order.parentOrderId, status: 'SUCCESSFUL' } });
      const again = await request<Outcome>(`/payments/callback?Authority=${payment.gatewayTrackingToken!}&Status=OK`);
      expect(again.body).toMatchObject({ outcome: 'PAID', paymentId: payment.id, bankRrn: payment.bankRrn });
      const posted = await request<Outcome>('/payments/callback', { method: 'POST', form: { Authority: payment.gatewayTrackingToken!, Status: 'OK' } });
      expect(posted.status).toBe(200);
      expect(posted.body).toMatchObject({ outcome: 'PAID', paymentId: payment.id });
      expect(await prisma.walletTransaction.count({ where: { subOrderId: { in: [subA, subB] } } })).toBe(2);
      expect((await wallet(vendorA.token)).pendingBalance).toBe('5550000.00');
      expect(await prisma.auditLog.count({ where: { entityName: 'Payment', entityId: payment.id, action: AuditAction.PAYMENT_CAPTURE } })).toBe(1);
    });

    it('a paid order cannot be paid again', async () => {
      const response = await request<ErrorBody>('/payments/initiate', { method: 'POST', token: customer.token, body: { parentOrderId: order.parentOrderId } });
      expect(response.status).toBe(409);
      expect(response.body.code).toBe('ORDER_NOT_PAYABLE');
    });

    it('packages are now visible to their vendors in PENDING_APPROVAL', async () => {
      const list = await request<Page<{ id: string; status: string }>>('/vendor/orders', { token: vendorA.token });
      expect(list.body.items.find((row) => row.id === subA)?.status).toBe('PENDING_APPROVAL');
    });
  });

  // ─── 3. delivery releases escrow; cancellation reverses it ────────────────

  describe('escrow release and reversal', () => {
    it('customer confirmation of a SHIPPED package releases the escrow to withdrawable, exactly once', async () => {
      expect((await request(`/vendor/orders/${subA}/status`, { method: 'PATCH', token: vendorA.token, body: { status: 'PROCESSING' } })).status).toBe(200);
      // not shipped yet: cannot be confirmed
      const early = await request<ErrorBody>(`/customer/orders/${order.parentOrderId}/sub-orders/${subA}/confirm-delivery`, { method: 'POST', token: customer.token });
      expect(early.status).toBe(409);
      expect(
        (await request(`/vendor/orders/${subA}/status`, { method: 'PATCH', token: vendorA.token, body: { status: 'SHIPPED', trackingCode: `TRK-${TAG}`, shippingCarrier: 'پست پیشتاز' } })).status,
      ).toBe(200);
      expect((await request(`/customer/orders/${order.parentOrderId}/sub-orders/${subA}/confirm-delivery`, { method: 'POST', token: customer2.token })).status).toBe(404);

      const confirmed = await request<Transition & { order: { subOrders: Array<{ id: string; status: string }> } }>(
        `/customer/orders/${order.parentOrderId}/sub-orders/${subA}/confirm-delivery`,
        { method: 'POST', token: customer.token },
      );
      expect(confirmed.status).toBe(200);
      expect(confirmed.body).toMatchObject({ previousStatus: 'SHIPPED', walletAction: 'ESCROW_RELEASED' });
      expect(confirmed.body.order.subOrders.find((sub) => sub.id === subA)?.status).toBe('DELIVERED');

      expect(await wallet(vendorA.token)).toMatchObject({ pendingBalance: '0.00', withdrawableBalance: '5550000.00', totalEarnedBalance: '5550000.00' });
      const sub = await prisma.subOrder.findUniqueOrThrow({ where: { id: subA } });
      expect(sub.status).toBe('DELIVERED');
      expect(sub.escrowReleasedAt).not.toBeNull();
      expect(sub.deliveredAt).not.toBeNull();
      const release = await ledger(vendorA.token, '&type=ESCROW_RELEASE_TO_WITHDRAWABLE');
      expect(release.map((row) => [row.bucket, row.amount]).sort()).toEqual([
        ['PENDING', '-5550000.00'],
        ['WITHDRAWABLE', '5550000.00'],
      ]);
      await expectReconciled(vendorA.vendorId);

      // idempotent: HTTP rejects a second confirmation, staff cannot re-deliver, the ledger service refuses, the DB refuses
      expect((await request(`/customer/orders/${order.parentOrderId}/sub-orders/${subA}/confirm-delivery`, { method: 'POST', token: customer.token })).status).toBe(409);
      expect(
        (await request(`/admin/sub-orders/${subA}/force-status`, { method: 'PATCH', token: adminToken, body: { status: 'DELIVERED', reason: 'تأیید دوباره تحویل' } })).status,
      ).toBe(409);
      const ledgerService = app.get(WalletLedgerService);
      const again = await prisma.$transaction((tx) =>
        ledgerService.releaseEscrow(tx, { id: subA, vendorId: vendorA.vendorId, subOrderNumber: sub.subOrderNumber, vendorEarningsAmount: sub.vendorEarningsAmount }),
      );
      expect(again).toBe(false);
      const w = await prisma.vendorWallet.findUniqueOrThrow({ where: { vendorId: vendorA.vendorId } });
      await expect(
        prisma.walletTransaction.create({
          data: { walletId: w.id, subOrderId: subA, type: 'ESCROW_RELEASE_TO_WITHDRAWABLE', bucket: 'WITHDRAWABLE', amount: 1, balanceAfter: 1, description: 'duplicate' },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });
      expect((await wallet(vendorA.token)).withdrawableBalance).toBe('5550000.00');
    });

    it('a vendor cancel before delivery reverses the escrow and restocks; a later staff REFUNDED is a wallet no-op', async () => {
      const stockBefore = await stockOf(v.B1);
      const cancelled = await request<Transition>(`/vendor/orders/${subB}/status`, {
        method: 'PATCH',
        token: vendorB.token,
        body: { status: 'CANCELLED', reason: 'موجودی انبار با سیستم همخوانی نداشت' },
      });
      expect(cancelled.status).toBe(200);
      expect(cancelled.body).toMatchObject({ walletAction: 'ESCROW_REVERSED', stockAction: 'RESTOCKED' });
      expect(await stockOf(v.B1)).toEqual({ stock: stockBefore.stock + 1, reserved: stockBefore.reserved });
      expect(await wallet(vendorB.token)).toMatchObject({ pendingBalance: '0.00', withdrawableBalance: '0.00', totalEarnedBalance: '0.00' });
      const refund = await ledger(vendorB.token, '&type=REFUND_DEDUCTION');
      expect(refund).toHaveLength(1);
      expect(refund[0]).toMatchObject({ bucket: 'PENDING', amount: '-2700000.00', balanceAfter: '0.00', subOrderId: subB });

      const refunded = await request<Transition>(`/admin/sub-orders/${subB}/force-status`, {
        method: 'PATCH',
        token: adminToken,
        body: { status: 'REFUNDED', reason: 'بازگشت وجه به مشتری ثبت شد' },
      });
      expect(refunded.status).toBe(200);
      expect(refunded.body.walletAction).toBe('NONE');
      expect(await ledger(vendorB.token, '&type=REFUND_DEDUCTION')).toHaveLength(1);
      await expectReconciled(vendorB.vendorId);
    });
  });

  // ─── 4. settlements ────────────────────────────────────────────────────────

  describe('vendor settlements', () => {
    let rejectedId: string;
    let approvedId: string;

    it('guards the vendor wallet endpoints by role', async () => {
      expect((await request('/vendor/wallet')).status).toBe(401);
      expect((await request('/vendor/wallet', { token: customer.token })).status).toBe(403);
      expect((await request('/vendor/wallet/settlements', { method: 'POST', token: customer.token, body: { amount: 5_000_000, targetIban: IBAN_A } })).status).toBe(403);
    });

    it('validates amount and IBAN: > withdrawable 409, < minimum 400, foreign IBAN 409, invalid IBAN 400', async () => {
      const over = await request<ErrorBody & { available: string }>('/vendor/wallet/settlements', { method: 'POST', token: vendorA.token, body: { amount: 6_000_000, targetIban: IBAN_A } });
      expect(over.status).toBe(409);
      expect(over.body).toMatchObject({ code: 'INSUFFICIENT_WALLET_BALANCE', available: '5550000.00' });
      const under = await request<ErrorBody>('/vendor/wallet/settlements', { method: 'POST', token: vendorA.token, body: { amount: 1_000_000, targetIban: IBAN_A } });
      expect(under.status).toBe(400);
      expect(under.body.code).toBe('AMOUNT_BELOW_MINIMUM');
      const foreign = await request<ErrorBody>('/vendor/wallet/settlements', { method: 'POST', token: vendorA.token, body: { amount: 5_000_000, targetIban: OTHER_VALID_IBAN } });
      expect(foreign.status).toBe(409);
      expect(foreign.body.code).toBe('IBAN_MISMATCH');
      expect((await request('/vendor/wallet/settlements', { method: 'POST', token: vendorA.token, body: { amount: 5_000_000, targetIban: 'IR620540102680020817909001' } })).status).toBe(400);
      expect((await request('/vendor/wallet/settlements', { method: 'POST', token: vendorA.token, body: { amount: 5_000_000.001, targetIban: IBAN_A } })).status).toBe(400);
      expect(await prisma.settlementRequest.count({ where: { vendorId: vendorA.vendorId } })).toBe(0);
      expect((await wallet(vendorA.token)).withdrawableBalance).toBe('5550000.00');
    });

    it('a request holds the amount immediately (withdrawable → settlement hold); a second one cannot overdraw', async () => {
      const created = await request<Settlement>('/vendor/wallet/settlements', { method: 'POST', token: vendorA.token, body: { amount: 5_000_000, targetIban: IBAN_A } });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ status: 'REQUESTED', amount: '5000000.00', targetIban: IBAN_A, vendorId: vendorA.vendorId });
      rejectedId = created.body.id;
      expect(await wallet(vendorA.token)).toMatchObject({ withdrawableBalance: '550000.00', settlementHoldBalance: '5000000.00' });
      const second = await request<ErrorBody>('/vendor/wallet/settlements', { method: 'POST', token: vendorA.token, body: { amount: 5_000_000, targetIban: IBAN_A } });
      expect(second.status).toBe(409);
      expect(second.body.code).toBe('INSUFFICIENT_WALLET_BALANCE');
      const mine = await request<Page<Settlement>>('/vendor/wallet/settlements', { token: vendorA.token });
      expect(mine.body.items.map((row) => row.id)).toEqual([rejectedId]);
      expect((await request<Page<Settlement>>('/vendor/wallet/settlements', { token: vendorB.token })).body.total).toBe(0);
      await expectReconciled(vendorA.vendorId);
    });

    it('lists requests for finance staff with filters; support and vendors are refused', async () => {
      expect((await request('/admin/settlements', { token: supportToken })).status).toBe(403);
      expect((await request('/admin/settlements', { token: vendorA.token })).status).toBe(403);
      const listed = await request<Page<Settlement>>(`/admin/settlements?status=REQUESTED&vendorId=${vendorA.vendorId}`, { token: financeToken });
      expect(listed.status).toBe(200);
      expect(listed.body.items.map((row) => row.id)).toEqual([rejectedId]);
      expect((await request<Page<Settlement>>(`/admin/settlements?status=PAID_PAYA&vendorId=${vendorA.vendorId}`, { token: adminToken })).body.total).toBe(0);
      expect((await request('/admin/settlements?status=BOGUS', { token: financeToken })).status).toBe(400);
    });

    it('reject restores the held amount; a processed request cannot be processed again', async () => {
      expect((await request(`/admin/settlements/${rejectedId}/process`, { method: 'PATCH', token: supportToken, body: { action: 'REJECT', rejectionReason: 'x'.repeat(10) } })).status).toBe(403);
      expect((await request(`/admin/settlements/${rejectedId}/process`, { method: 'PATCH', token: financeToken, body: { action: 'REJECT' } })).status).toBe(400);
      const rejected = await request<Settlement>(`/admin/settlements/${rejectedId}/process`, {
        method: 'PATCH',
        token: financeToken,
        body: { action: 'REJECT', rejectionReason: 'شماره شبا با نام صاحب حساب مطابقت ندارد' },
      });
      expect(rejected.status).toBe(200);
      expect(rejected.body).toMatchObject({ status: 'REJECTED', rejectionReason: 'شماره شبا با نام صاحب حساب مطابقت ندارد', processedBy: { id: financeUserId } });
      expect(await wallet(vendorA.token)).toMatchObject({ withdrawableBalance: '5550000.00', settlementHoldBalance: '0.00', totalWithdrawnAmount: '0.00' });
      const again = await request<ErrorBody>(`/admin/settlements/${rejectedId}/process`, { method: 'PATCH', token: financeToken, body: { action: 'APPROVE', payaReferenceNumber: 'PAYA-1' } });
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('SETTLEMENT_ALREADY_PROCESSED');
      expect(await prisma.auditLog.count({ where: { entityName: 'SettlementRequest', entityId: rejectedId, action: AuditAction.SETTLEMENT_TRIGGER } })).toBe(1);
      await expectReconciled(vendorA.vendorId);
    });

    it('approve records the PAYA payout: PAID_PAYA, hold cleared, totalWithdrawnAmount increased', async () => {
      const created = await request<Settlement>('/vendor/wallet/settlements', { method: 'POST', token: vendorA.token, body: { amount: 5_000_000, targetIban: IBAN_A } });
      expect(created.status).toBe(201);
      approvedId = created.body.id;
      expect((await request(`/admin/settlements/${approvedId}/process`, { method: 'PATCH', token: financeToken, body: { action: 'APPROVE' } })).status).toBe(400);
      const approved = await request<Settlement>(`/admin/settlements/${approvedId}/process`, {
        method: 'PATCH',
        token: financeToken,
        body: { action: 'APPROVE', payaReferenceNumber: `PAYA-${TAG}-1` },
      });
      expect(approved.status).toBe(200);
      expect(approved.body).toMatchObject({ status: 'PAID_PAYA', bankPayaReference: `PAYA-${TAG}-1`, processedBy: { id: financeUserId } });
      expect(approved.body.auditLogId).toEqual(expect.any(String));
      expect(await wallet(vendorA.token)).toMatchObject({ withdrawableBalance: '550000.00', settlementHoldBalance: '0.00', totalWithdrawnAmount: '5000000.00', totalEarnedBalance: '5550000.00' });
      const payout = await ledger(vendorA.token, '&type=SETTLEMENT_PAYOUT');
      expect(payout).toEqual([expect.objectContaining({ bucket: 'SETTLEMENT_HOLD', amount: '-5000000.00', balanceAfter: '0.00', settlementRequestId: approvedId })]);
      await expectReconciled(vendorA.vendorId);
    });

    it('POST …/payout pays a request; a PAYA reference cannot be reused', async () => {
      await setConfig(SETTLEMENT_MIN_AMOUNT_KEY, '100000.00');
      try {
        const created = await request<Settlement>('/vendor/wallet/settlements', { method: 'POST', token: vendorA.token, body: { amount: 500_000, targetIban: IBAN_A } });
        expect(created.status).toBe(201);
        const reused = await request<ErrorBody>(`/admin/settlements/${created.body.id}/payout`, { method: 'POST', token: adminToken, body: { payaReferenceNumber: `PAYA-${TAG}-1` } });
        expect(reused.status).toBe(409);
        expect(reused.body.code).toBe('PAYA_REFERENCE_IN_USE');
        const paid = await request<Settlement>(`/admin/settlements/${created.body.id}/payout`, { method: 'POST', token: adminToken, body: { payaReferenceNumber: `PAYA-${TAG}-2` } });
        expect(paid.status).toBe(200);
        expect(paid.body.status).toBe('PAID_PAYA');
        expect(await wallet(vendorA.token)).toMatchObject({ withdrawableBalance: '50000.00', totalWithdrawnAmount: '5500000.00' });
        expect((await request(`/admin/settlements/${created.body.id}/payout`, { method: 'POST', token: adminToken, body: { payaReferenceNumber: `PAYA-${TAG}-3` } })).status).toBe(409);
      } finally {
        await setConfig(SETTLEMENT_MIN_AMOUNT_KEY, '5000000.00');
      }
      await expectReconciled(vendorA.vendorId);
    });

    it('a refund after delivery cannot drive the withdrawable balance negative (409, nothing changes)', async () => {
      const refused = await request<ErrorBody & { bucket: string }>(`/admin/sub-orders/${subA}/force-status`, {
        method: 'PATCH',
        token: adminToken,
        body: { status: 'REFUNDED', reason: 'مشتری کالا را مرجوع کرد' },
      });
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ code: 'INSUFFICIENT_WALLET_BALANCE', bucket: 'WITHDRAWABLE' });
      expect((await prisma.subOrder.findUniqueOrThrow({ where: { id: subA } })).status).toBe('DELIVERED');
      expect((await wallet(vendorA.token)).withdrawableBalance).toBe('50000.00');
    });
  });

  // ─── 5. expiry protection, late capture, concurrency ──────────────────────

  describe('payment edge cases', () => {
    it('the expiry sweeper spares an order whose payment is in flight, and a late capture is flagged for manual refund', async () => {
      const late = await placeOrder([[v.B1, 1]]);
      const initiated = await initiate(late.parentOrderId);
      await prisma.parentOrder.update({ where: { id: late.parentOrderId }, data: { paymentExpiresAt: new Date(Date.now() - 60_000) } });

      await lifecycle.expireOverdue();
      expect((await prisma.parentOrder.findUniqueOrThrow({ where: { id: late.parentOrderId } })).paymentStatus).toBe('PENDING');

      // the payer walked away: the attempt ages past the grace window, the sweeper cancels and releases stock
      await prisma.payment.update({ where: { id: initiated.paymentId }, data: { createdAt: new Date(Date.now() - 60 * 60_000) } });
      const reservedBefore = (await stockOf(v.B1)).reserved;
      await lifecycle.expireOverdue();
      expect((await prisma.parentOrder.findUniqueOrThrow({ where: { id: late.parentOrderId } })).paymentStatus).toBe('CANCELLED');
      expect((await stockOf(v.B1)).reserved).toBe(reservedBefore - 1);

      // ...then pays after all: the money is recorded, the order is not resurrected, finance is told to refund
      const walletBefore = await wallet(vendorB.token);
      const callbackPath = await decide(initiated.paymentId, 'PAY');
      const outcome = await request<Outcome>(callbackPath);
      expect(outcome.body).toMatchObject({ outcome: 'PAID_REQUIRES_REFUND', paymentStatus: 'SUCCESSFUL', orderPaymentStatus: 'CANCELLED' });
      const payment = await prisma.payment.findUniqueOrThrow({ where: { id: initiated.paymentId } });
      expect(payment.metadata).toMatchObject({ requiresManualRefund: true });
      expect(await wallet(vendorB.token)).toEqual(walletBefore);
      expect(await prisma.auditLog.count({ where: { entityName: 'Payment', entityId: initiated.paymentId, action: AuditAction.PAYMENT_CAPTURE } })).toBe(1);
    });

    it('concurrent callbacks for one payment apply it exactly once', async () => {
      const racing = await placeOrder([[v.A1, 1]]);
      const initiated = await initiate(racing.parentOrderId);
      const callbackPath = await decide(initiated.paymentId, 'PAY');
      const pendingBefore = d((await wallet(vendorA.token)).pendingBalance);
      const results = await Promise.all([request<Outcome>(callbackPath), request<Outcome>(callbackPath), request<Outcome>(callbackPath)]);
      for (const result of results) {
        expect(result.status).toBe(200);
        expect(result.body.outcome).toBe('PAID');
      }
      const subId = racing.subOrders[0]!.id;
      expect(await prisma.walletTransaction.count({ where: { subOrderId: subId, type: 'CREDIT_SALE_ESCROW_HOLD' } })).toBe(1);
      // 3,000,000 − 7.5% = 2,775,000
      expect(d((await wallet(vendorA.token)).pendingBalance).minus(pendingBefore).toFixed(2)).toBe('2775000.00');
      expect(await prisma.auditLog.count({ where: { entityName: 'Payment', entityId: initiated.paymentId, action: AuditAction.PAYMENT_CAPTURE } })).toBe(1);
      await expectReconciled(vendorA.vendorId);
    });

    it('limits open payment attempts per order', async () => {
      const spam = await placeOrder([[v.A1, 1]]);
      for (let i = 0; i < 5; i += 1) await initiate(spam.parentOrderId);
      const refused = await request('/payments/initiate', { method: 'POST', token: customer.token, body: { parentOrderId: spam.parentOrderId } });
      expect(refused.status).toBe(429);
    });
  });

  // ─── 6. financial overview ─────────────────────────────────────────────────

  describe('financial overview', () => {
    it('is restricted to finance staff and admins', async () => {
      expect((await request('/admin/financial/overview')).status).toBe(401);
      expect((await request('/admin/financial/overview', { token: supportToken })).status).toBe(403);
      expect((await request('/admin/financial/overview', { token: vendorA.token })).status).toBe(403);
      expect((await request('/admin/financial/overview', { token: adminToken })).status).toBe(200);
      expect((await request('/admin/financial/overview?from=2026-10-01T00:00:00Z&to=2026-09-01T00:00:00Z', { token: financeToken })).status).toBe(400);
    });

    it('matches independent aggregates of the live database and reports a consistent ledger', async () => {
      const response = await request<{
        currency: string;
        sales: { gmv: string; shippingFees: string; collectedByGateway: string };
        commission: { earned: string; pending: string; total: string };
        wallets: { escrowHeld: string; withdrawable: string; settlementHold: string; totalWithdrawn: string; ledgerConsistent: boolean; inconsistentWallets: number };
        settlements: { pendingCount: number; pendingAmount: string; paidCount: number };
        paymentsRequiringManualRefund: number;
      }>('/admin/financial/overview', { token: financeToken });
      expect(response.status).toBe(200);
      const body = response.body;
      expect(body.currency).toBe('IRR');

      const active = { parentOrder: { paymentStatus: 'PAID' as const }, status: { notIn: ['CANCELLED' as const, 'REFUNDED' as const] } };
      const gmv = await prisma.subOrder.aggregate({ where: active, _sum: { itemsSubtotal: true, shippingFee: true } });
      const earned = await prisma.subOrder.aggregate({ where: { parentOrder: { paymentStatus: 'PAID' }, status: 'DELIVERED' }, _sum: { platformCommissionAmount: true } });
      const pending = await prisma.subOrder.aggregate({
        where: { parentOrder: { paymentStatus: 'PAID' }, status: { in: ['PENDING_APPROVAL', 'PROCESSING', 'SHIPPED'] } },
        _sum: { platformCommissionAmount: true },
      });
      const wallets = await prisma.vendorWallet.aggregate({ _sum: { pendingBalance: true, withdrawableBalance: true, settlementHoldBalance: true, totalWithdrawnAmount: true } });
      const collected = await prisma.payment.aggregate({ where: { status: 'SUCCESSFUL', purpose: 'ORDER_CHECKOUT' }, _sum: { cashAmount: true } });
      const money = (value: Prisma.Decimal | null): string => d(value ?? 0).toFixed(2);

      expect(body.sales.gmv).toBe(money(gmv._sum.itemsSubtotal));
      expect(body.sales.shippingFees).toBe(money(gmv._sum.shippingFee));
      expect(body.sales.collectedByGateway).toBe(money(collected._sum.cashAmount));
      expect(body.commission.earned).toBe(money(earned._sum.platformCommissionAmount));
      expect(body.commission.pending).toBe(money(pending._sum.platformCommissionAmount));
      expect(body.wallets.escrowHeld).toBe(money(wallets._sum.pendingBalance));
      expect(body.wallets.withdrawable).toBe(money(wallets._sum.withdrawableBalance));
      expect(body.wallets.settlementHold).toBe(money(wallets._sum.settlementHoldBalance));
      expect(body.wallets.totalWithdrawn).toBe(money(wallets._sum.totalWithdrawnAmount));
      expect(body.wallets).toMatchObject({ ledgerConsistent: true, inconsistentWallets: 0 });
      expect(body.settlements.pendingCount).toBe(await prisma.settlementRequest.count({ where: { status: { in: ['REQUESTED', 'PROCESSING'] } } }));
      expect(body.paymentsRequiringManualRefund).toBeGreaterThanOrEqual(1);
      // this suite's own contribution is visible: store A's delivered package earned 450,000 commission
      expect(d(body.commission.earned).greaterThanOrEqualTo(450_000)).toBe(true);
    });
  });

  // ─── 7. contract ───────────────────────────────────────────────────────────

  describe('OpenAPI contract', () => {
    it('documents every Phase 7 route under its tag', () => {
      const document = buildOpenApiDocument(app) as unknown as { paths: Record<string, Record<string, { tags?: string[]; responses: Record<string, unknown> }>>; tags: Array<{ name: string }> };
      const expected: Array<[string, string, string]> = [
        ['/api/v1/payments/initiate', 'post', 'payments'],
        ['/api/v1/payments/callback', 'get', 'payments'],
        ['/api/v1/payments/callback', 'post', 'payments'],
        ['/api/v1/sandbox/payment-page/{paymentId}', 'get', 'sandbox-payments'],
        ['/api/v1/sandbox/payment-page/{paymentId}/decision', 'post', 'sandbox-payments'],
        ['/api/v1/vendor/wallet', 'get', 'vendor-wallet'],
        ['/api/v1/vendor/wallet/transactions', 'get', 'vendor-wallet'],
        ['/api/v1/vendor/wallet/settlements', 'post', 'vendor-wallet'],
        ['/api/v1/vendor/wallet/settlements', 'get', 'vendor-wallet'],
        ['/api/v1/admin/settlements', 'get', 'admin-settlements'],
        ['/api/v1/admin/settlements/{id}/process', 'patch', 'admin-settlements'],
        ['/api/v1/admin/settlements/{id}/payout', 'post', 'admin-settlements'],
        ['/api/v1/admin/financial/overview', 'get', 'admin-financial'],
        ['/api/v1/customer/orders/{id}/sub-orders/{subOrderId}/confirm-delivery', 'post', 'customer-orders'],
      ];
      for (const [path, method, tag] of expected) {
        const operation = document.paths[path]?.[method];
        expect({ path, method, documented: operation !== undefined }).toEqual({ path, method, documented: true });
        expect(operation!.tags).toContain(tag);
        expect(Object.keys(operation!.responses).length).toBeGreaterThanOrEqual(2);
      }
      const tags = document.tags.map((tag) => tag.name);
      for (const tag of ['payments', 'sandbox-payments', 'vendor-wallet', 'admin-settlements', 'admin-financial']) expect(tags).toContain(tag);
    });
  });
});
