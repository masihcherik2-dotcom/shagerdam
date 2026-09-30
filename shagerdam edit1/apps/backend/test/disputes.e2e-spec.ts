import { ConfigService } from '@nestjs/config';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { AuditAction, DisputeEventType, Prisma, WalletBalanceBucket, WalletTransactionType } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { GLOBAL_API_PREFIX } from '../src/common/constants';
import { PrismaService } from '../src/infra/prisma/prisma.service';
import { RedisService } from '../src/infra/redis/redis.service';
import { normalizeIdentifier } from '../src/modules/auth/auth.service';
import { OtpKeys } from '../src/modules/auth/otp.service';
import { loginAttemptsKey, loginLockKey } from '../src/modules/auth/token.service';
import { CategoriesService } from '../src/modules/categories/categories.service';
import { MAX_DISPUTES_PER_DAY } from '../src/modules/disputes/dispute-policy';
import { disputeOpenCountKey } from '../src/modules/disputes/disputes.service';
import { SETTLEMENT_MIN_AMOUNT_KEY } from '../src/modules/settlements/settlements.service';
import { SHIPPING_CONFIG_KEYS } from '../src/modules/shipping/shipping-calculator.service';
import { SMS_PROVIDER } from '../src/modules/sms/sms-provider.interface';
import type { SmsProvider } from '../src/modules/sms/sms-provider.interface';
import type { SandboxSmsProvider } from '../src/modules/sms/providers/sandbox-sms.provider';
import { STORAGE_PROVIDER, type StorageProvider } from '../src/modules/storage/storage-provider.interface';
import { applyGlobalPolicies, buildOpenApiDocument } from '../src/setup/app.setup';

/**
 * End-to-end verification of Phase 9 — disputes, evidence, the escrow freeze
 * (DISPUTE_HOLD) and arbitration with automatic financial resolution — against
 * the real PostgreSQL 16 and Redis 7 of docker-compose. Payments go through the
 * SANDBOX gateway exactly as a browser would; SMS through the SANDBOX provider.
 * Nothing is stubbed inside the API.
 *
 * Money (IRR), category commission 10%, platform shipping 450,000 per package:
 *   A1 2,000,000 → earnings 1,800,000
 *   B1 1,000,000 → earnings   900,000
 *   B2   300,000 → earnings   270,000
 *
 * Scenarios
 *   1. order1 = A1 + B1. Guards (unpaid, not yet accepted, ownership, roles, evidence).
 *   2. order1/A (PROCESSING): dispute freezes PENDING → DISPUTE_HOLD; transitions are
 *      blocked; the store ACCEPTS the return → REFUNDED, REFUND_DEDUCTION, restocked, SMS.
 *   3. order1/B (DELIVERED): freeze from WITHDRAWABLE; the store DEFENDS →
 *      UNDER_ARBITRATION; staff VENDOR_FAVOR → DELIVERED, released to WITHDRAWABLE.
 *   4. order2/A (SHIPPED): delivery confirmation refused while disputed; the customer
 *      cancels (hold back to PENDING, still SHIPPED), re-opens; staff BUYER_FAVOR without
 *      a returned item → REFUNDED, no restock.
 *   5. order3/B (DELIVERED) after store B moved most of its balance into a settlement:
 *      hold 500,000 + shortfall 400,000; later earnings of order4 (270,000) are used to
 *      recover part of the shortfall on BUYER_FAVOR; 130,000 stays unrecovered.
 */

const TEST_UA = 'shopino-disputes-e2e/1.0';
const RUN = Date.now().toString(36);
const TAG = RUN.toUpperCase();

const VENDOR_A_MOBILE = '+989971170001';
const VENDOR_B_MOBILE = '+989971170002';
const CUSTOMER_MOBILE = '+989971170003';
const CUSTOMER_2_MOBILE = '+989971170004';
const SUITE_MOBILES = [VENDOR_A_MOBILE, VENDOR_B_MOBILE, CUSTOMER_MOBILE, CUSTOMER_2_MOBILE];
const IBAN_A = 'IR820540102680020817909002';
const IBAN_B = 'IR570629600000001003242001';
const SEEDED_ADMIN_EMAIL = 'admin@shopino.local';
const SEEDED_SUPPORT_EMAIL = 'support@shopino.local';
const SEEDED_FINANCE_EMAIL = 'finance@shopino.local';

interface HttpResult<T> {
  status: number;
  body: T;
}

interface ErrorBody {
  code?: string;
  message: string | string[];
  disputeId?: string;
}

interface Checkout {
  parentOrderId: string;
  subOrders: Array<{ id: string; store: { id: string } }>;
}

interface Wallet {
  pendingBalance: string;
  withdrawableBalance: string;
  settlementHoldBalance: string;
  disputeHoldBalance: string;
  totalEarnedBalance: string;
  totalWithdrawnAmount: string;
}

interface Dispute {
  id: string;
  status: string;
  reason: string;
  package: { subOrderId: string; status: string; storeName: string };
  subOrderStatusAtOpen: string;
  vendorResponse: { action: string; defenseNotes: string } | null;
  resolution: { outcome: string; decidedBy: string; refundAmount: string | null; restocked: boolean; itemReturned: boolean | null } | null;
  cancelledAt: string | null;
  evidence: Array<{ uploadedBy: string; fileUrl: string; fileType: string | null }>;
  timeline: Array<{ type: string; actorRole: string; fromStatus: string | null; toStatus: string | null }>;
}

interface VendorDispute extends Dispute {
  customerName: string;
  customerMobileMasked: string;
  hold: { source: string | null; amount: string; shortfall: string; unrecovered: string };
}

interface Dossier extends VendorDispute {
  customer: { userId: string; mobile: string };
  order: { orderNumber: string; paymentStatus: string };
  items: Array<{ sku: string; quantity: number }>;
  packageHistory: Array<{ toStatus: string }>;
  payments: Array<{ status: string; cashAmount: string }>;
  vendorWallet: Wallet;
  vendorEarningsAmount: string;
}

interface ActionResult {
  dispute: Dispute;
  walletAction: string;
  subOrderStatus: string;
  stockAction: string;
}

interface Page<T> {
  items: T[];
  total: number;
}

const d = (value: string | number | Prisma.Decimal): Prisma.Decimal => new Prisma.Decimal(value);

describe('Phase 9 — disputes, escrow freeze and arbitration (live stack)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;

  let adminToken: string;
  let supportToken: string;
  let financeToken: string;
  let vendorA: { token: string; userId: string; vendorId: string };
  let vendorB: { token: string; userId: string; vendorId: string };
  let customer: { token: string; userId: string };
  let customer2: { token: string; userId: string };
  let categoryId: string;
  let addressId: string;
  const v: Record<'A1' | 'B1' | 'B2', string> = {} as never;
  let savedConfigs: Array<{ key: string; value: string; valueType: never; description: string | null }> = [];
  const paymentIds: string[] = [];

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
    const response = await app.inject({ method: options.method ?? 'GET', url: url.startsWith(API) ? url : `${API}${url}`, headers, ...(payload === undefined ? {} : { payload }) });
    const isJson = String(response.headers['content-type'] ?? '').includes('application/json');
    return { status: response.statusCode, body: (isJson && response.body.length > 0 ? JSON.parse(response.body) : response.body) as T };
  };

  const loginWithOtp = async (mobile: string): Promise<{ token: string; userId: string }> => {
    expect((await request('/auth/otp/request', { method: 'POST', body: { mobile } })).status).toBe(200);
    const code = (app.get<SmsProvider>(SMS_PROVIDER) as SandboxSmsProvider).latestOtpCode(mobile);
    const verified = await request<{ accessToken: string; user: { id: string } }>('/auth/otp/verify', { method: 'POST', body: { mobile, code } });
    expect(verified.status).toBe(200);
    return { token: verified.body.accessToken, userId: verified.body.user.id };
  };

  const loginWithPassword = async (identifier: string, password: string): Promise<string> => {
    const response = await request<{ accessToken: string }>('/auth/login/password', { method: 'POST', body: { identifier, password } });
    expect(response.status).toBe(200);
    return response.body.accessToken;
  };

  /** Uploads a private PDF through the real media route and returns its canonical download url. */
  const uploadDocument = async (token: string, purpose: string, label: string): Promise<string> => {
    const form = new FormData();
    const pdf = Buffer.concat([Buffer.from(`%PDF-1.7\n% disputes e2e ${RUN} ${label}\n`, 'latin1'), Buffer.from('%%EOF', 'latin1')]);
    form.append('file', new Blob([new Uint8Array(pdf)], { type: 'application/pdf' }), `${label}.pdf`);
    form.append('purpose', purpose);
    const serialized = new Response(form);
    const uploaded = await app.inject({
      method: 'POST',
      url: `${API}/media/upload/document`,
      headers: { authorization: `Bearer ${token}`, 'user-agent': TEST_UA, 'content-type': serialized.headers.get('content-type') ?? '' },
      payload: Buffer.from(await serialized.arrayBuffer()),
    });
    expect(uploaded.statusCode).toBe(201);
    return (JSON.parse(uploaded.body) as { url: string }).url;
  };

  const onboardStore = async (login: { token: string }, storeSlug: string, iban: string): Promise<string> => {
    const registered = await request<{ id: string }>('/vendors/register', {
      method: 'POST',
      token: login.token,
      body: { storeName: `فروشگاه آزمون اختلاف ${storeSlug}`, storeSlug, bio: 'فروشگاه آزمون فاز نه', bankIban: iban, bankAccountHolder: 'شرکت آزمون اختلاف' },
    });
    expect(registered.status).toBe(201);
    const nationalIdCardUrl = await uploadDocument(login.token, 'kyc_national_id', 'national-id');
    expect((await request('/vendors/verification/documents', { method: 'POST', token: login.token, body: { nationalIdCardUrl } })).status).toBe(200);
    const verified = await request(`/admin/vendors/${registered.body.id}/verify`, {
      method: 'POST',
      token: adminToken,
      body: { status: 'APPROVED', rejectionReason: null, commissionRateOverride: null },
    });
    expect(verified.status).toBe(200);
    return registered.body.id;
  };

  const createProduct = async (token: string, title: string, sku: string, price: number): Promise<string> => {
    const response = await request<{ variants: Array<{ id: string }> }>('/vendor/products', {
      method: 'POST',
      token,
      body: { title, categoryId, basePrice: price, isPublished: true, variants: [{ sku, price, stockQuantity: 20 }] },
    });
    expect(response.status).toBe(201);
    return response.body.variants[0]!.id;
  };

  const placeOrder = async (lines: Array<[string, number]>): Promise<Checkout> => {
    expect((await request('/cart/clear', { method: 'POST', token: customer.token })).status).toBe(200);
    for (const [productVariantId, quantity] of lines) {
      expect((await request('/cart/items', { method: 'POST', token: customer.token, body: { productVariantId, quantity } })).status).toBe(200);
    }
    const placed = await request<Checkout>('/orders/checkout', { method: 'POST', token: customer.token, body: { addressId } });
    expect(placed.status).toBe(201);
    return placed.body;
  };

  const pay = async (parentOrderId: string): Promise<void> => {
    const initiated = await request<{ paymentId: string }>('/payments/initiate', { method: 'POST', token: customer.token, body: { parentOrderId } });
    expect(initiated.status).toBe(201);
    paymentIds.push(initiated.body.paymentId);
    const decision = await app.inject({
      method: 'POST',
      url: `${API}/sandbox/payment-page/${initiated.body.paymentId}/decision`,
      headers: { 'user-agent': TEST_UA, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ decision: 'PAY' }).toString(),
    });
    expect(decision.statusCode).toBe(303);
    const location = new URL(String(decision.headers['location']));
    const outcome = await request<{ outcome: string }>(`${location.pathname}${location.search}`);
    expect(outcome.body.outcome).toBe('PAID');
  };

  const subOf = (order: Checkout, vendorId: string): string => order.subOrders.find((sub) => sub.store.id === vendorId)!.id;

  const vendorStatus = (token: string, subId: string, status: 'PROCESSING' | 'SHIPPED'): Promise<HttpResult<ErrorBody>> =>
    request<ErrorBody>(`/vendor/orders/${subId}/status`, {
      method: 'PATCH',
      token,
      body: status === 'SHIPPED' ? { status, trackingCode: `TRK-${TAG}-${subId.slice(0, 6)}`, shippingCarrier: 'پست پیشتاز' } : { status },
    });

  const confirmDelivery = (order: Checkout, subId: string): Promise<HttpResult<ErrorBody>> =>
    request<ErrorBody>(`/customer/orders/${order.parentOrderId}/sub-orders/${subId}/confirm-delivery`, { method: 'POST', token: customer.token });

  const deliver = async (order: Checkout, subId: string, token: string): Promise<void> => {
    expect((await vendorStatus(token, subId, 'PROCESSING')).status).toBe(200);
    expect((await vendorStatus(token, subId, 'SHIPPED')).status).toBe(200);
    expect((await confirmDelivery(order, subId)).status).toBe(200);
  };

  const wallet = async (token: string): Promise<Wallet> => {
    const response = await request<Wallet>('/vendor/wallet', { token });
    expect(response.status).toBe(200);
    return response.body;
  };

  const openDispute = (body: Record<string, unknown>, token = customer.token): Promise<HttpResult<ActionResult & ErrorBody>> =>
    request<ActionResult & ErrorBody>('/customer/disputes', { method: 'POST', token, body });

  const stockOf = async (variantId: string): Promise<number> =>
    (await prisma.productVariant.findUniqueOrThrow({ where: { id: variantId }, select: { stockQuantity: true } })).stockQuantity;

  /**
   * The TM invariant, checked on the live rows: earned = withdrawn + withdrawable +
   * settlementHold + disputeHold, and every balance column equals the SUM of its ledger rows.
   */
  const expectInvariants = async (vendorId: string): Promise<void> => {
    const w = await prisma.vendorWallet.findUniqueOrThrow({ where: { vendorId } });
    expect(w.totalEarnedBalance.toFixed(2)).toBe(w.totalWithdrawnAmount.plus(w.withdrawableBalance).plus(w.settlementHoldBalance).plus(w.disputeHoldBalance).toFixed(2));
    const rows = await prisma.walletTransaction.findMany({ where: { walletId: w.id } });
    const columns: Record<WalletBalanceBucket, Prisma.Decimal> = {
      PENDING: w.pendingBalance,
      WITHDRAWABLE: w.withdrawableBalance,
      SETTLEMENT_HOLD: w.settlementHoldBalance,
      DISPUTE_HOLD: w.disputeHoldBalance,
    };
    for (const bucket of Object.values(WalletBalanceBucket)) {
      const sum = rows.filter((row) => row.bucket === bucket).reduce((acc, row) => acc.plus(row.amount), d(0));
      expect({ bucket, sum: sum.toFixed(2) }).toEqual({ bucket, sum: columns[bucket].toFixed(2) });
    }
  };

  const disputeLedger = (disputeId: string): Promise<Array<{ type: WalletTransactionType; bucket: WalletBalanceBucket; amount: Prisma.Decimal }>> =>
    prisma.walletTransaction.findMany({ where: { disputeId }, select: { type: true, bucket: true, amount: true }, orderBy: [{ createdAt: 'asc' }, { amount: 'asc' }] });

  const setConfig = async (key: string, value: string): Promise<void> => {
    await prisma.systemConfig.upsert({ where: { key }, update: { value }, create: { key, value, valueType: 'NUMBER', description: `disputes e2e ${RUN}` } });
  };

  // ─── lifecycle ─────────────────────────────────────────────────────────────

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    applyGlobalPolicies(app, app.get(ConfigService));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = app.get(PrismaService);
    await resetRedisKeys();

    const adminPassword = process.env['SUPER_ADMIN_PASSWORD'];
    const staffPassword = process.env['SEED_STAFF_PASSWORD'];
    if (adminPassword === undefined || staffPassword === undefined) {
      throw new Error('This suite needs SUPER_ADMIN_PASSWORD and SEED_STAFF_PASSWORD from the root .env.');
    }
    adminToken = await loginWithPassword(SEEDED_ADMIN_EMAIL, adminPassword);
    supportToken = await loginWithPassword(SEEDED_SUPPORT_EMAIL, staffPassword);
    financeToken = await loginWithPassword(SEEDED_FINANCE_EMAIL, staffPassword);

    const configKeys = [...Object.values(SHIPPING_CONFIG_KEYS), SETTLEMENT_MIN_AMOUNT_KEY];
    savedConfigs = (await prisma.systemConfig.findMany({ where: { key: { in: configKeys } }, select: { key: true, value: true, valueType: true, description: true } })) as never;
    await setConfig(SHIPPING_CONFIG_KEYS.defaultFeePerVendor, '450000');
    await setConfig(SHIPPING_CONFIG_KEYS.freeThresholdPerVendor, '20000000');
    await setConfig(SETTLEMENT_MIN_AMOUNT_KEY, '100000.00');

    const category = await request<{ id: string }>('/admin/categories', {
      method: 'POST',
      token: adminToken,
      body: { slug: `e2e-dsp-${RUN}`, titleFa: `دسته آزمون اختلاف ${RUN}`, defaultCommissionRate: 10 },
    });
    expect(category.status).toBe(201);
    categoryId = category.body.id;

    const a = await loginWithOtp(VENDOR_A_MOBILE);
    const b = await loginWithOtp(VENDOR_B_MOBILE);
    customer = await loginWithOtp(CUSTOMER_MOBILE);
    customer2 = await loginWithOtp(CUSTOMER_2_MOBILE);
    await prisma.user.update({ where: { id: customer.userId }, data: { fullName: 'مشتری آزمون اختلاف' } });
    vendorA = { ...a, vendorId: await onboardStore(a, `dsp-e2e-a-${RUN}`, IBAN_A) };
    vendorB = { ...b, vendorId: await onboardStore(b, `dsp-e2e-b-${RUN}`, IBAN_B) };
    v.A1 = await createProduct(vendorA.token, `گوشی آزمون اختلاف ${RUN}`, `DSP-${TAG}-A1`, 2_000_000);
    v.B1 = await createProduct(vendorB.token, `هدفون آزمون اختلاف ${RUN}`, `DSP-${TAG}-B1`, 1_000_000);
    v.B2 = await createProduct(vendorB.token, `کابل آزمون اختلاف ${RUN}`, `DSP-${TAG}-B2`, 300_000);

    const address = await request<{ id: string }>('/customer/addresses', {
      method: 'POST',
      token: customer.token,
      body: {
        province: 'تهران',
        city: 'تهران',
        postalAddress: 'خیابان انقلاب، پلاک ۹',
        postalCode: '1458889999',
        buildingNumber: '9',
        unitNumber: '1',
        recipientName: 'مشتری آزمون اختلاف',
        recipientMobile: '09971170003',
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
      const disputes = await prisma.dispute.findMany({ where: { OR: [{ vendorId: { in: vendorIds } }, { raisedByUserId: { in: userIds } }] }, select: { id: true } });
      const payments = await prisma.payment.findMany({ where: { parentOrderId: { in: orderIds } }, select: { id: true } });
      const settlements = await prisma.settlementRequest.findMany({ where: { vendorId: { in: vendorIds } }, select: { id: true } });
      const products = await prisma.product.findMany({ where: { vendorId: { in: vendorIds } }, select: { id: true, variants: { select: { id: true } } } });
      const productIds = products.map((row) => row.id);
      const variantIds = products.flatMap((row) => row.variants.map((variant) => variant.id));
      const entityIds = [
        ...vendorIds,
        ...productIds,
        ...variantIds,
        ...orderIds,
        ...subIds,
        ...disputes.map((row) => row.id),
        ...payments.map((row) => row.id),
        ...settlements.map((row) => row.id),
        categoryId,
      ];

      await prisma.auditLog.deleteMany({ where: { OR: [{ userId: { in: userIds } }, { userAgent: TEST_UA }, { entityId: { in: entityIds.filter(Boolean) } }] } });
      await prisma.vendorWallet.deleteMany({ where: { vendorId: { in: vendorIds } } }); // cascades to the ledger
      await prisma.settlementRequest.deleteMany({ where: { vendorId: { in: vendorIds } } });
      await prisma.dispute.deleteMany({ where: { id: { in: disputes.map((row) => row.id) } } }); // cascades to evidence and events
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
      await resetRedisKeys(userIds);
    }
    await app?.close();
  }, 120_000);

  async function resetRedisKeys(userIds: string[] = []): Promise<void> {
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
      ...userIds.map((id) => disputeOpenCountKey(id)),
    ];
    if (keys.length > 0) await redis.client.del(...keys);
  }

  // ─── 1. guards ─────────────────────────────────────────────────────────────

  let order1: Checkout;
  let subA1: string;
  let subB1: string;
  let evidenceUrl: string;

  describe('opening: ownership, order state, reason and evidence', () => {
    beforeAll(async () => {
      order1 = await placeOrder([
        [v.A1, 1],
        [v.B1, 1],
      ]);
      subA1 = subOf(order1, vendorA.vendorId);
      subB1 = subOf(order1, vendorB.vendorId);
      evidenceUrl = await uploadDocument(customer.token, 'dispute_evidence', 'cracked-screen');
    });

    const valid = (): Record<string, unknown> => ({
      subOrderId: subA1,
      reason: 'DAMAGED',
      description: 'The screen arrived cracked and the box was dented on one corner.',
      evidenceUrls: [evidenceUrl],
    });

    it('requires a customer token', async () => {
      expect((await request('/customer/disputes', { method: 'POST', body: valid() })).status).toBe(401);
      expect((await openDispute(valid(), vendorA.token)).status).toBe(403);
      expect((await openDispute(valid(), supportToken)).status).toBe(403);
    });

    it('refuses packages of unpaid orders, then packages the store has not accepted yet', async () => {
      const unpaid = await openDispute(valid());
      expect(unpaid.status).toBe(409);
      expect(unpaid.body.code).toBe('ORDER_NOT_PAID');

      await pay(order1.parentOrderId);
      const pending = await openDispute(valid());
      expect(pending.status).toBe(409);
      expect(pending.body.code).toBe('SUB_ORDER_NOT_DISPUTABLE');
    });

    it('hides other customers’ packages (404) and validates the body', async () => {
      expect((await openDispute(valid(), customer2.token)).status).toBe(404);
      expect((await openDispute({ ...valid(), reason: 'CHANGED_MY_MIND' })).status).toBe(400);
      expect((await openDispute({ ...valid(), description: 'too short' })).status).toBe(400);
      expect((await openDispute({ ...valid(), subOrderId: 'not-a-uuid' })).status).toBe(400);
      expect((await openDispute({ ...valid(), evidenceUrls: ['https://evil.example/photo.jpg'] })).status).toBe(400);
      expect((await openDispute({ ...valid(), evidenceUrls: undefined })).status).toBe(400);
    });

    it('accepts only the caller’s own dispute_evidence uploads as evidence', async () => {
      expect((await vendorStatus(vendorA.token, subA1, 'PROCESSING')).status).toBe(200);
      const foreign = await uploadDocument(customer2.token, 'dispute_evidence', 'someone-else');
      const kyc = await uploadDocument(customer.token, 'kyc_national_id', 'my-id-card');
      for (const url of [foreign, kyc]) {
        const response = await openDispute({ ...valid(), evidenceUrls: [url] });
        expect(response.status).toBe(400);
        expect(response.body.code).toBe('EVIDENCE_NOT_ACCEPTED');
      }
      expect(await prisma.dispute.count({ where: { subOrderId: subA1 } })).toBe(0);
    });

    it(`limits a customer to ${MAX_DISPUTES_PER_DAY} dispute attempts per day (429, Redis counter)`, async () => {
      const redis = app.get(RedisService);
      const key = disputeOpenCountKey(customer.userId);
      await redis.client.set(key, String(MAX_DISPUTES_PER_DAY), 'EX', 60);
      const limited = await openDispute(valid());
      expect(limited.status).toBe(429);
      await redis.client.del(key);
      expect(await prisma.dispute.count({ where: { subOrderId: subA1 } })).toBe(0);
    });
  });

  // ─── 2. PROCESSING → store accepts the return ──────────────────────────────

  describe('not-yet-shipped package: freeze, blocked transitions, store accepts the return', () => {
    let disputeId: string;
    let stockBefore: number;

    it('opens the dispute and freezes the escrow PENDING → DISPUTE_HOLD in the same transaction', async () => {
      const before = await wallet(vendorA.token);
      expect(before.pendingBalance).toBe('1800000.00');
      stockBefore = await stockOf(v.A1);

      const opened = await openDispute({ subOrderId: subA1, reason: 'DAMAGED', description: 'The screen arrived cracked and the box was dented on one corner.', evidenceUrls: [evidenceUrl] });
      expect(opened.status).toBe(201);
      expect(opened.body).toMatchObject({ walletAction: 'FROZEN', subOrderStatus: 'PROCESSING', stockAction: 'NONE' });
      expect(opened.body.dispute).toMatchObject({ status: 'OPEN', reason: 'DAMAGED', subOrderStatusAtOpen: 'PROCESSING', vendorResponse: null, resolution: null });
      expect(opened.body.dispute.evidence).toEqual([expect.objectContaining({ uploadedBy: 'CUSTOMER', fileUrl: evidenceUrl, fileType: 'application/pdf' })]);
      expect(opened.body.dispute.timeline.map((event) => event.type)).toEqual([DisputeEventType.OPENED]);
      disputeId = opened.body.dispute.id;

      const after = await wallet(vendorA.token);
      expect(after).toMatchObject({ pendingBalance: '0.00', disputeHoldBalance: '1800000.00', totalEarnedBalance: '1800000.00', withdrawableBalance: '0.00' });
      const rows = await disputeLedger(disputeId);
      expect(rows.map((row) => [row.type, row.bucket, row.amount.toFixed(2)])).toEqual(
        expect.arrayContaining([
          [WalletTransactionType.DISPUTE_HOLD_LOCK, WalletBalanceBucket.PENDING, '-1800000.00'],
          [WalletTransactionType.DISPUTE_HOLD_LOCK, WalletBalanceBucket.DISPUTE_HOLD, '1800000.00'],
        ]),
      );
      await expectInvariants(vendorA.vendorId);
      const audit = await prisma.auditLog.findFirst({ where: { entityName: 'Dispute', entityId: disputeId, action: AuditAction.CREATE } });
      expect(audit?.userId).toBe(customer.userId);
    });

    it('allows one active dispute per package', async () => {
      const again = await openDispute({ subOrderId: subA1, reason: 'WRONG_ITEM', description: 'Trying to open a second dispute on the same package.', evidenceUrls: [] });
      expect(again.status).toBe(409);
      expect(again.body).toMatchObject({ code: 'DISPUTE_ALREADY_ACTIVE', disputeId });
    });

    it('blocks every status change of the disputed package (409 SUB_ORDER_UNDER_DISPUTE)', async () => {
      const ship = await vendorStatus(vendorA.token, subA1, 'SHIPPED');
      expect(ship.status).toBe(409);
      expect(ship.body.code).toBe('SUB_ORDER_UNDER_DISPUTE');
      const forced = await request<ErrorBody>(`/admin/sub-orders/${subA1}/force-status`, { method: 'PATCH', token: adminToken, body: { status: 'DELIVERED', reason: 'تحویل دستی حین اختلاف' } });
      expect(forced.status).toBe(409);
      expect(forced.body.code).toBe('SUB_ORDER_UNDER_DISPUTE');
      expect((await wallet(vendorA.token)).disputeHoldBalance).toBe('1800000.00');
    });

    it('shows the dispute to its customer and its store only; the store may read the buyer’s evidence', async () => {
      const mine = await request<Page<Dispute>>('/customer/disputes', { token: customer.token });
      expect(mine.status).toBe(200);
      expect(mine.body.items.map((item) => item.id)).toContain(disputeId);
      expect((await request<Page<Dispute>>('/customer/disputes', { token: customer2.token })).body.total).toBe(0);
      expect((await request(`/customer/disputes/${disputeId}`, { token: customer2.token })).status).toBe(404);
      expect((await request(`/vendor/disputes/${disputeId}`, { token: vendorB.token })).status).toBe(404);
      expect((await request(`/customer/disputes/${disputeId}`, { token: vendorA.token })).status).toBe(403);

      const forStore = await request<VendorDispute>(`/vendor/disputes/${disputeId}`, { token: vendorA.token });
      expect(forStore.status).toBe(200);
      expect(forStore.body.customerMobileMasked).toBe('+98997***0003');
      expect(forStore.body.customerName).toBe('مشتری آزمون اختلاف');
      expect(forStore.body.hold).toEqual({ source: 'PENDING', amount: '1800000.00', shortfall: '0.00', unrecovered: '0.00' });
      expect((await request<Page<VendorDispute>>('/vendor/disputes?status=OPEN', { token: vendorA.token })).body.items.map((item) => item.id)).toContain(disputeId);

      expect((await request(evidenceUrl, { token: vendorA.token })).status).toBe(200);
      expect((await request(evidenceUrl, { token: vendorB.token })).status).toBe(403);
      expect((await request(evidenceUrl, { token: customer2.token })).status).toBe(403);
    });

    it('refuses arbitration to customers, stores, finance officers and anonymous callers', async () => {
      const body = { decision: 'BUYER_FAVOR', resolutionNotes: 'Not allowed to decide this dispute.' };
      expect((await request(`/admin/disputes/${disputeId}/arbitrate`, { method: 'POST', body })).status).toBe(401);
      for (const token of [customer.token, vendorA.token, vendorB.token, financeToken]) {
        expect((await request(`/admin/disputes/${disputeId}/arbitrate`, { method: 'POST', token, body })).status).toBe(403);
      }
      expect((await request(`/admin/disputes/${disputeId}`, { token: vendorA.token })).status).toBe(403);
      expect((await request(`/vendor/disputes/${disputeId}/respond`, { method: 'POST', token: vendorB.token, body: { action: 'ACCEPT_RETURN', defenseNotes: 'Not my store at all.' } })).status).toBe(404);
    });

    it('store ACCEPT_RETURN resolves for the buyer: REFUNDED, REFUND_DEDUCTION from the hold, restocked, refund notice', async () => {
      const accepted = await request<ActionResult>(`/vendor/disputes/${disputeId}/respond`, {
        method: 'POST',
        token: vendorA.token,
        body: { action: 'ACCEPT_RETURN', defenseNotes: 'We accept; the item will be collected and refunded.' },
      });
      expect(accepted.status).toBe(200);
      expect(accepted.body).toMatchObject({ walletAction: 'REFUNDED', subOrderStatus: 'REFUNDED', stockAction: 'RESTOCKED' });
      expect(accepted.body.dispute).toMatchObject({
        status: 'RESOLVED_BUYER_FAVOR',
        vendorResponse: { action: 'ACCEPT_RETURN' },
        resolution: { outcome: 'RESOLVED_BUYER_FAVOR', decidedBy: 'VENDOR', refundAmount: '2450000.00', restocked: true },
      });
      expect(await stockOf(v.A1)).toBe(stockBefore + 1);

      expect(await wallet(vendorA.token)).toMatchObject({ pendingBalance: '0.00', disputeHoldBalance: '0.00', withdrawableBalance: '0.00', totalEarnedBalance: '0.00' });
      const rows = await disputeLedger(disputeId);
      expect(rows.map((row) => [row.type, row.bucket, row.amount.toFixed(2)])).toContainEqual([WalletTransactionType.REFUND_DEDUCTION, WalletBalanceBucket.DISPUTE_HOLD, '-1800000.00']);
      await expectInvariants(vendorA.vendorId);

      const sub = await prisma.subOrder.findUniqueOrThrow({ where: { id: subA1 }, select: { status: true } });
      expect(sub.status).toBe('REFUNDED');
      const audits = await prisma.auditLog.findMany({ where: { action: AuditAction.DISPUTE_RESOLUTION, entityId: { in: [disputeId, subA1] } } });
      expect(audits.map((row) => row.entityName).sort()).toEqual(['Dispute', 'SubOrder']);

      const detail = await request<Dispute>(`/customer/disputes/${disputeId}`, { token: customer.token });
      expect(detail.body.timeline.map((event) => event.type)).toEqual([DisputeEventType.OPENED, DisputeEventType.VENDOR_ACCEPTED_RETURN, DisputeEventType.REFUND_NOTICE_SENT]);
    });

    it('a decided dispute cannot be answered again and its package cannot be disputed again', async () => {
      const again = await request<ErrorBody>(`/vendor/disputes/${disputeId}/respond`, { method: 'POST', token: vendorA.token, body: { action: 'REJECT_WITH_DEFENSE', defenseNotes: 'Changed our mind about this.' } });
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('DISPUTE_NOT_AWAITING_VENDOR');
      const reopen = await openDispute({ subOrderId: subA1, reason: 'DAMAGED', description: 'Trying to reopen an already refunded package.', evidenceUrls: [] });
      expect(reopen.status).toBe(409);
      expect(reopen.body.code).toBe('SUB_ORDER_NOT_DISPUTABLE');
    });
  });

  // ─── 3. DELIVERED → store defends → staff VENDOR_FAVOR ─────────────────────

  describe('delivered package: freeze from WITHDRAWABLE, store defends, staff decides for the store', () => {
    let disputeId: string;

    it('freezes the already released earnings (WITHDRAWABLE → DISPUTE_HOLD)', async () => {
      await deliver(order1, subB1, vendorB.token);
      expect(await wallet(vendorB.token)).toMatchObject({ withdrawableBalance: '900000.00', totalEarnedBalance: '900000.00' });

      const opened = await openDispute({ subOrderId: subB1, reason: 'NOT_AS_DESCRIBED', description: 'The headphones are wired, the listing said wireless.', evidenceUrls: [] });
      expect(opened.status).toBe(201);
      expect(opened.body).toMatchObject({ walletAction: 'FROZEN', subOrderStatus: 'DELIVERED' });
      disputeId = opened.body.dispute.id;
      expect(await wallet(vendorB.token)).toMatchObject({ withdrawableBalance: '0.00', disputeHoldBalance: '900000.00', totalEarnedBalance: '900000.00' });
      await expectInvariants(vendorB.vendorId);
    });

    it('store REJECT_WITH_DEFENSE with its own evidence → UNDER_ARBITRATION', async () => {
      const storeEvidence = await uploadDocument(vendorB.token, 'dispute_evidence', 'listing-screenshot');
      const defended = await request<ActionResult>(`/vendor/disputes/${disputeId}/respond`, {
        method: 'POST',
        token: vendorB.token,
        body: { action: 'REJECT_WITH_DEFENSE', defenseNotes: 'The listing clearly says wired; see the screenshot.', evidenceUrls: [storeEvidence] },
      });
      expect(defended.status).toBe(200);
      expect(defended.body).toMatchObject({ walletAction: 'NONE', subOrderStatus: 'DELIVERED' });
      expect(defended.body.dispute).toMatchObject({ status: 'UNDER_ARBITRATION', vendorResponse: { action: 'REJECT_WITH_DEFENSE' } });
      expect(defended.body.dispute.evidence.map((item) => item.uploadedBy)).toEqual(['VENDOR']);
      expect((await request(storeEvidence, { token: customer.token })).status).toBe(200);
      expect(await wallet(vendorB.token)).toMatchObject({ disputeHoldBalance: '900000.00' });
    });

    it('gives staff the full dossier', async () => {
      const dossier = await request<Dossier>(`/admin/disputes/${disputeId}`, { token: supportToken });
      expect(dossier.status).toBe(200);
      expect(dossier.body).toMatchObject({
        status: 'UNDER_ARBITRATION',
        customer: { userId: customer.userId, mobile: CUSTOMER_MOBILE },
        order: { paymentStatus: 'PAID' },
        hold: { source: 'WITHDRAWABLE', amount: '900000.00', shortfall: '0.00' },
        vendorWallet: { disputeHoldBalance: '900000.00' },
        vendorEarningsAmount: '900000.00',
      });
      expect(dossier.body.items).toEqual([expect.objectContaining({ sku: `DSP-${TAG}-B1`, quantity: 1 })]);
      expect(dossier.body.packageHistory.map((entry) => entry.toStatus)).toEqual(expect.arrayContaining(['PROCESSING', 'SHIPPED', 'DELIVERED']));
      expect(dossier.body.payments).toEqual([expect.objectContaining({ status: 'SUCCESSFUL' })]);
      const listed = await request<Page<VendorDispute>>(`/admin/disputes?status=UNDER_ARBITRATION&vendorId=${vendorB.vendorId}`, { token: adminToken });
      expect(listed.body.items.map((item) => item.id)).toEqual([disputeId]);
      expect((await request('/admin/disputes?status=NOPE', { token: adminToken })).status).toBe(400);
    });

    it('validates the arbitration body', async () => {
      expect((await request(`/admin/disputes/${disputeId}/arbitrate`, { method: 'POST', token: supportToken, body: { decision: 'SPLIT', resolutionNotes: 'Half and half for both.' } })).status).toBe(400);
      expect((await request(`/admin/disputes/${disputeId}/arbitrate`, { method: 'POST', token: supportToken, body: { decision: 'VENDOR_FAVOR', resolutionNotes: 'short' } })).status).toBe(400);
    });

    it('VENDOR_FAVOR: package DELIVERED, hold released to WITHDRAWABLE (DISPUTE_HOLD_RELEASE), audited', async () => {
      const decided = await request<ActionResult>(`/admin/disputes/${disputeId}/arbitrate`, {
        method: 'POST',
        token: supportToken,
        body: { decision: 'VENDOR_FAVOR', resolutionNotes: 'The listing matches the delivered item.' },
      });
      expect(decided.status).toBe(200);
      expect(decided.body).toMatchObject({ walletAction: 'RELEASED_TO_WITHDRAWABLE', subOrderStatus: 'DELIVERED', stockAction: 'NONE' });
      expect(decided.body.dispute).toMatchObject({ status: 'RESOLVED_VENDOR_FAVOR', resolution: { decidedBy: 'STAFF', refundAmount: null } });
      expect(await wallet(vendorB.token)).toMatchObject({ withdrawableBalance: '900000.00', disputeHoldBalance: '0.00', totalEarnedBalance: '900000.00' });
      const rows = await disputeLedger(disputeId);
      expect(rows.map((row) => [row.type, row.bucket, row.amount.toFixed(2)])).toEqual(
        expect.arrayContaining([
          [WalletTransactionType.DISPUTE_HOLD_RELEASE, WalletBalanceBucket.DISPUTE_HOLD, '-900000.00'],
          [WalletTransactionType.DISPUTE_HOLD_RELEASE, WalletBalanceBucket.WITHDRAWABLE, '900000.00'],
        ]),
      );
      await expectInvariants(vendorB.vendorId);
      const sub = await prisma.subOrder.findUniqueOrThrow({ where: { id: subB1 }, select: { status: true, escrowReleasedAt: true } });
      expect(sub.status).toBe('DELIVERED');
      expect(sub.escrowReleasedAt).not.toBeNull();
      const audit = await prisma.auditLog.findFirst({ where: { action: AuditAction.DISPUTE_RESOLUTION, entityName: 'Dispute', entityId: disputeId } });
      expect(audit).not.toBeNull();
    });

    it('a decided dispute cannot be arbitrated again, and the package cannot be disputed again', async () => {
      const again = await request<ErrorBody>(`/admin/disputes/${disputeId}/arbitrate`, { method: 'POST', token: adminToken, body: { decision: 'BUYER_FAVOR', resolutionNotes: 'Second thoughts on this one.' } });
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('DISPUTE_ALREADY_CLOSED');
      const reopen = await openDispute({ subOrderId: subB1, reason: 'COUNTERFEIT', description: 'Now I think these headphones are counterfeit.', evidenceUrls: [] });
      expect(reopen.status).toBe(409);
      expect(reopen.body).toMatchObject({ code: 'DISPUTE_ALREADY_DECIDED', disputeId });
    });
  });

  // ─── 4. SHIPPED: cancel, re-open, staff BUYER_FAVOR without return ─────────

  describe('shipped package: delivery blocked, customer cancels and re-opens, staff decides for the buyer', () => {
    let order2: Checkout;
    let subA2: string;
    let firstId: string;
    let secondId: string;

    beforeAll(async () => {
      order2 = await placeOrder([[v.A1, 1]]);
      subA2 = subOf(order2, vendorA.vendorId);
      await pay(order2.parentOrderId);
      expect((await vendorStatus(vendorA.token, subA2, 'PROCESSING')).status).toBe(200);
      expect((await vendorStatus(vendorA.token, subA2, 'SHIPPED')).status).toBe(200);
    });

    it('delivery confirmation cannot release escrow while the dispute is active', async () => {
      const opened = await openDispute({ subOrderId: subA2, reason: 'NOT_DELIVERED', description: 'Tracking says delivered but nothing arrived at my door.', evidenceUrls: [] });
      expect(opened.status).toBe(201);
      firstId = opened.body.dispute.id;
      expect(await wallet(vendorA.token)).toMatchObject({ pendingBalance: '0.00', disputeHoldBalance: '1800000.00' });

      const confirm = await confirmDelivery(order2, subA2);
      expect(confirm.status).toBe(409);
      expect(confirm.body.code).toBe('SUB_ORDER_UNDER_DISPUTE');
      expect(await wallet(vendorA.token)).toMatchObject({ withdrawableBalance: '0.00', disputeHoldBalance: '1800000.00' });
    });

    it('customer cancel returns the hold to escrow PENDING; the package stays SHIPPED', async () => {
      expect((await request(`/customer/disputes/${firstId}/cancel`, { method: 'POST', token: customer2.token, body: {} })).status).toBe(404);
      const cancelled = await request<ActionResult>(`/customer/disputes/${firstId}/cancel`, { method: 'POST', token: customer.token, body: { reason: 'The parcel was at the neighbour.' } });
      expect(cancelled.status).toBe(200);
      expect(cancelled.body).toMatchObject({ walletAction: 'RETURNED_TO_ESCROW', subOrderStatus: 'SHIPPED' });
      expect(cancelled.body.dispute.status).toBe('CANCELLED');
      expect(cancelled.body.dispute.cancelledAt).not.toBeNull();
      expect(await wallet(vendorA.token)).toMatchObject({ pendingBalance: '1800000.00', disputeHoldBalance: '0.00', totalEarnedBalance: '0.00' });
      await expectInvariants(vendorA.vendorId);

      const twice = await request<ErrorBody>(`/customer/disputes/${firstId}/cancel`, { method: 'POST', token: customer.token, body: {} });
      expect(twice.status).toBe(409);
      expect(twice.body.code).toBe('DISPUTE_NOT_CANCELLABLE');
    });

    it('a cancelled dispute does not block a new one', async () => {
      const reopened = await openDispute({ subOrderId: subA2, reason: 'WRONG_ITEM', description: 'The parcel finally came but holds a different phone model.', evidenceUrls: [] });
      expect(reopened.status).toBe(201);
      secondId = reopened.body.dispute.id;
      expect(secondId).not.toBe(firstId);
      expect(await wallet(vendorA.token)).toMatchObject({ pendingBalance: '0.00', disputeHoldBalance: '1800000.00' });
    });

    it('staff BUYER_FAVOR without a returned item: REFUNDED, deducted, stock untouched', async () => {
      const stockBefore = await stockOf(v.A1);
      const decided = await request<ActionResult>(`/admin/disputes/${secondId}/arbitrate`, {
        method: 'POST',
        token: adminToken,
        body: { decision: 'BUYER_FAVOR', resolutionNotes: 'Carrier photo shows a different model.', itemReturned: false },
      });
      expect(decided.status).toBe(200);
      expect(decided.body).toMatchObject({ walletAction: 'REFUNDED', subOrderStatus: 'REFUNDED', stockAction: 'NONE' });
      expect(decided.body.dispute.resolution).toMatchObject({ decidedBy: 'STAFF', refundAmount: '2450000.00', restocked: false, itemReturned: false });
      expect(await stockOf(v.A1)).toBe(stockBefore);
      expect(await wallet(vendorA.token)).toMatchObject({ pendingBalance: '0.00', disputeHoldBalance: '0.00', totalEarnedBalance: '0.00' });
      await expectInvariants(vendorA.vendorId);
    });
  });

  // ─── 5. DELIVERED with a shortfall: partial recovery ───────────────────────

  describe('delivered package whose earnings were partly withdrawn: shortfall, recovery, unrecovered remainder', () => {
    let order3: Checkout;
    let subB3: string;
    let disputeId: string;
    let settlementId: string;

    beforeAll(async () => {
      await app.get(RedisService).client.del(disputeOpenCountKey(customer.userId));
      order3 = await placeOrder([[v.B1, 1]]);
      subB3 = subOf(order3, vendorB.vendorId);
      await pay(order3.parentOrderId);
      await deliver(order3, subB3, vendorB.token);
      expect((await wallet(vendorB.token)).withdrawableBalance).toBe('1800000.00');
      const settlement = await request<{ id: string }>('/vendor/wallet/settlements', { method: 'POST', token: vendorB.token, body: { amount: 1_300_000, targetIban: IBAN_B } });
      expect(settlement.status).toBe(201);
      settlementId = settlement.body.id;
      expect((await wallet(vendorB.token)).withdrawableBalance).toBe('500000.00');
    });

    it('freezes what is left and records the shortfall', async () => {
      const opened = await openDispute({ subOrderId: subB3, reason: 'COUNTERFEIT', description: 'The serial number is not recognised by the brand.', evidenceUrls: [] });
      expect(opened.status).toBe(201);
      disputeId = opened.body.dispute.id;
      expect(opened.body.dispute.timeline[0]).toMatchObject({ type: 'OPENED' });
      const row = await prisma.dispute.findUniqueOrThrow({ where: { id: disputeId }, select: { holdSource: true, holdAmount: true, holdShortfall: true } });
      expect({ source: row.holdSource, amount: row.holdAmount.toFixed(2), shortfall: row.holdShortfall.toFixed(2) }).toEqual({ source: 'WITHDRAWABLE', amount: '500000.00', shortfall: '400000.00' });
      expect(await wallet(vendorB.token)).toMatchObject({ withdrawableBalance: '0.00', settlementHoldBalance: '1300000.00', disputeHoldBalance: '500000.00' });
      await expectInvariants(vendorB.vendorId);
    });

    it('BUYER_FAVOR deducts the hold, recovers from later earnings and reports the rest as unrecovered', async () => {
      const paid = await request(`/admin/settlements/${settlementId}/process`, { method: 'PATCH', token: financeToken, body: { action: 'APPROVE', payaReferenceNumber: `PAYA-${TAG}` } });
      expect(paid.status).toBe(200);
      const order4 = await placeOrder([[v.B2, 1]]);
      const subB4 = subOf(order4, vendorB.vendorId);
      await pay(order4.parentOrderId);
      await deliver(order4, subB4, vendorB.token);
      expect((await wallet(vendorB.token)).withdrawableBalance).toBe('270000.00');

      const decided = await request<ActionResult>(`/admin/disputes/${disputeId}/arbitrate`, {
        method: 'POST',
        token: supportToken,
        body: { decision: 'BUYER_FAVOR', resolutionNotes: 'Brand confirmed the serial is fake.', itemReturned: true },
      });
      expect(decided.status).toBe(200);
      expect(decided.body).toMatchObject({ walletAction: 'REFUNDED', subOrderStatus: 'REFUNDED', stockAction: 'RESTOCKED' });
      expect(decided.body.dispute.resolution).toMatchObject({ refundAmount: '1450000.00', restocked: true, itemReturned: true });

      const rows = await disputeLedger(disputeId);
      expect(rows.filter((row) => row.type === WalletTransactionType.REFUND_DEDUCTION).map((row) => [row.bucket, row.amount.toFixed(2)])).toEqual(
        expect.arrayContaining([
          [WalletBalanceBucket.DISPUTE_HOLD, '-500000.00'],
          [WalletBalanceBucket.WITHDRAWABLE, '-270000.00'],
        ]),
      );
      const w = await wallet(vendorB.token);
      expect(w).toMatchObject({ withdrawableBalance: '0.00', disputeHoldBalance: '0.00', settlementHoldBalance: '0.00', totalWithdrawnAmount: '1300000.00' });
      await expectInvariants(vendorB.vendorId);

      const staffView = await request<Dossier>(`/admin/disputes/${disputeId}`, { token: adminToken });
      expect(staffView.body.hold).toEqual({ source: 'WITHDRAWABLE', amount: '500000.00', shortfall: '400000.00', unrecovered: '130000.00' });
    });

    it('surfaces disputes and the dispute hold in the financial overview', async () => {
      const overview = await request<{ wallets: { disputeHold: string; ledgerConsistent: boolean }; disputes: Record<string, unknown> }>('/admin/financial/overview', { token: financeToken });
      expect(overview.status).toBe(200);
      expect(overview.body.wallets.ledgerConsistent).toBe(true);
      for (const key of ['open', 'underArbitration', 'resolvedForBuyer']) expect(typeof overview.body.disputes[key]).toBe('number');
      expect(overview.body.disputes['resolvedForBuyer'] as number).toBeGreaterThanOrEqual(3);
      expect(d(overview.body.disputes['unrecoveredVendorEarnings'] as string).greaterThanOrEqualTo(130_000)).toBe(true);
      expect(d(overview.body.disputes['refundsOwedToCustomers'] as string).greaterThanOrEqualTo(2_450_000 * 2 + 1_450_000)).toBe(true);
    });
  });

  // ─── contract ──────────────────────────────────────────────────────────────

  describe('OpenAPI contract', () => {
    it('documents every Phase 9 route under its tag', () => {
      const document = buildOpenApiDocument(app) as unknown as { paths: Record<string, Record<string, { tags?: string[]; responses: Record<string, unknown> }>>; tags: Array<{ name: string }> };
      const expected: Array<[string, string, string]> = [
        ['/api/v1/customer/disputes', 'post', 'customer-disputes'],
        ['/api/v1/customer/disputes', 'get', 'customer-disputes'],
        ['/api/v1/customer/disputes/{id}', 'get', 'customer-disputes'],
        ['/api/v1/customer/disputes/{id}/cancel', 'post', 'customer-disputes'],
        ['/api/v1/vendor/disputes', 'get', 'vendor-disputes'],
        ['/api/v1/vendor/disputes/{id}', 'get', 'vendor-disputes'],
        ['/api/v1/vendor/disputes/{id}/respond', 'post', 'vendor-disputes'],
        ['/api/v1/admin/disputes', 'get', 'admin-disputes'],
        ['/api/v1/admin/disputes/{id}', 'get', 'admin-disputes'],
        ['/api/v1/admin/disputes/{id}/arbitrate', 'post', 'admin-disputes'],
      ];
      for (const [path, method, tag] of expected) {
        const operation = document.paths[path]?.[method];
        expect({ path, method, documented: operation !== undefined }).toEqual({ path, method, documented: true });
        expect(operation!.tags).toContain(tag);
        expect(Object.keys(operation!.responses).length).toBeGreaterThanOrEqual(3);
      }
      const tags = document.tags.map((tag) => tag.name);
      for (const tag of ['customer-disputes', 'vendor-disputes', 'admin-disputes']) expect(tags).toContain(tag);
    });
  });
});
