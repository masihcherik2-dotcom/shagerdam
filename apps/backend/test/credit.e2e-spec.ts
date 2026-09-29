import { ConfigService } from '@nestjs/config';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { AuditAction, CreditTransactionType, Prisma } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { GLOBAL_API_PREFIX } from '../src/common/constants';
import { isValidNationalCode } from '../src/common/validators/iranian-national-code';
import { PrismaService } from '../src/infra/prisma/prisma.service';
import { RedisService } from '../src/infra/redis/redis.service';
import { normalizeIdentifier } from '../src/modules/auth/auth.service';
import { OtpKeys } from '../src/modules/auth/otp.service';
import { loginAttemptsKey, loginLockKey } from '../src/modules/auth/token.service';
import { InstallmentsService } from '../src/modules/bnpl/installments.service';
import { CategoriesService } from '../src/modules/categories/categories.service';
import { holdsInvariant, replayCreditLedger } from '../src/modules/credit/credit-math';
import { creditApplyCountKey, creditApplyLockKey } from '../src/modules/credit/credit.service';
import { addDays, calendarDateToDb, dbDateToCalendar, platformDate } from '../src/modules/credit/installment-math';
import { CREDIT_CONFIG_KEYS } from '../src/modules/credit/providers/credit-provider.registry';
import { parseSandboxRules, sandboxCreditScore, sandboxReservationKey } from '../src/modules/credit/providers/sandbox-bank.provider';
import { SHIPPING_CONFIG_KEYS } from '../src/modules/shipping/shipping-calculator.service';
import { SMS_PROVIDER } from '../src/modules/sms/sms-provider.interface';
import type { SmsProvider } from '../src/modules/sms/sms-provider.interface';
import type { SandboxSmsProvider } from '../src/modules/sms/providers/sandbox-sms.provider';
import { STORAGE_PROVIDER, type StorageProvider } from '../src/modules/storage/storage-provider.interface';
import { applyGlobalPolicies, buildOpenApiDocument } from '../src/setup/app.setup';

/**
 * End-to-end verification of Phase 8 — credit engine, credit applications,
 * instalment schedules, BANK_CREDIT / HYBRID checkout and instalment repayment —
 * against the real PostgreSQL 16 and Redis 7 of docker-compose.
 *
 * Providers: the credit provider is SANDBOX_BANK (development only; decisions
 * are derived deterministically from the national code, reservations live in
 * Redis) and the card gateway is the Phase 7 SANDBOX gateway, driven exactly as
 * a browser would (bank page → decision form → callback → server-side verify).
 * Nothing is stubbed inside the API.
 *
 * Money (IRR). One store, category commission 10 %, platform shipping 450,000
 * per package (free from 20,000,000):
 *   order 1  P × 2 =  6,000,000 + 450,000 =  6,450,000   BANK_CREDIT, 6-month plan (9 %)
 *            interest = floor(6,450,000 × 9 %) = 580,500; 6 × (1,075,000 + 96,750)
 *   order 2  P × 5 = 15,000,000 + 450,000 = 15,450,000   HYBRID, 3-month plan (0 %)
 *            credit = available 13,550,000; card 1,900,000; principal 4,516,666 × 2 + 4,516,668
 */

const TEST_UA = 'shopino-credit-e2e/1.0';
const RUN = Date.now().toString(36);
const TAG = RUN.toUpperCase();

const VENDOR_MOBILE = '+989971160001';
const CUSTOMER_MOBILE = '+989971160002';
const CUSTOMER_2_MOBILE = '+989971160003';
const CUSTOMER_3_MOBILE = '+989971160004';
const SUITE_MOBILES = [VENDOR_MOBILE, CUSTOMER_MOBILE, CUSTOMER_2_MOBILE, CUSTOMER_3_MOBILE];
const VENDOR_IBAN = 'IR820540102680020817909002';
const SEEDED_ADMIN_EMAIL = 'admin@shopino.local';
const SEEDED_SUPPORT_EMAIL = 'support@shopino.local';
const SEEDED_FINANCE_EMAIL = 'finance@shopino.local';

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

interface Account {
  id: string;
  provider: { code: string; name: string; isSandbox: boolean };
  status: string;
  totalLimit: string;
  usedAmount: string;
  reservedAmount: string;
  availableAmount: string;
  currency: string;
  outstanding: { count: number; overdueCount: number; principal: string; interest: string; nextDueDate: string | null };
}

interface Application {
  id: string;
  status: 'APPROVED' | 'REJECTED' | 'DOCS_REQUIRED';
  provider: { code: string; isSandbox: boolean };
  requestedLimit: string;
  approvedLimit: string | null;
  trackingCode: string | null;
  score: number | null;
  decisionReason: string | null;
  decidedAt: string | null;
  account: Account | null;
}

interface Plan {
  id: string;
  title: string;
  durationMonths: number;
  interestRatePercent: string;
  installmentIntervalDays: number;
}

interface CreditInitiate {
  status: 'COMPLETED' | 'IPG_REQUIRED';
  paymentId: string;
  parentOrderId: string;
  orderNumber: string;
  paymentMethod: string;
  creditAmount: string;
  cashAmount: string;
  orderPaymentStatus: string;
  redirectUrl: string | null;
  gatewayName: string | null;
  schedule: { installments: number; creditAmount: string; totalInterest: string; totalPayable: string; firstDueDate: string; lastDueDate: string } | null;
}

interface Outcome {
  outcome: 'PAID' | 'FAILED' | 'VERIFICATION_PENDING' | 'PAID_REQUIRES_REFUND';
  paymentId: string;
  paymentStatus: string;
  orderPaymentStatus: string;
  bankRrn: string | null;
  canRetry: boolean;
  purpose: string;
  paymentMethod: string;
  cashAmount: string;
  creditAmount: string;
  installmentScheduleId: string | null;
}

interface Installment {
  id: string;
  installmentNumber: number;
  totalInstallments: number;
  dueDate: string;
  principalAmount: string;
  interestAmount: string;
  totalAmount: string;
  paidAmount: string;
  amountDue: string;
  status: 'PENDING' | 'PAID' | 'OVERDUE' | 'WAIVED';
  paidAt: string | null;
}

interface InstallmentsOverview {
  orders: Array<{
    parentOrderId: string;
    orderNumber: string;
    paymentMethod: string;
    plan: { id: string; durationMonths: number } | null;
    creditAmount: string;
    totalInterest: string;
    totalPayable: string;
    paidAmount: string;
    remainingAmount: string;
    paidCount: number;
    overdueCount: number;
    installments: Installment[];
  }>;
  totalRemaining: string;
  overdueCount: number;
}

interface Page<T> {
  items: T[];
  total: number;
}

const d = (value: string | number | Prisma.Decimal): Prisma.Decimal => new Prisma.Decimal(value);

/** A random national code with a valid check digit whose sandbox score satisfies `wanted`. */
function generateNationalCode(wanted: (score: number) => boolean, exclude: Set<string>): string {
  for (let attempt = 0; attempt < 100_000; attempt += 1) {
    const nine = String(Math.floor(Math.random() * 1e9)).padStart(9, '0');
    let sum = 0;
    for (let i = 0; i < 9; i += 1) sum += Number(nine[i]) * (10 - i);
    const remainder = sum % 11;
    const code = `${nine}${remainder < 2 ? remainder : 11 - remainder}`;
    if (isValidNationalCode(code) && !exclude.has(code) && wanted(sandboxCreditScore(code))) {
      exclude.add(code);
      return code;
    }
  }
  throw new Error('Could not generate a national code');
}

describe('Phase 8 — credit engine, BNPL checkout and instalments (live stack)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let redis: RedisService;

  let adminToken: string;
  let supportToken: string;
  let financeToken: string;
  let vendor: { token: string; userId: string; vendorId: string };
  let customer: { token: string; userId: string };
  let customer2: { token: string; userId: string };
  let customer3: { token: string; userId: string };
  let categoryId: string;
  let variantId: string;
  let addressId: string;
  let address3Id: string;
  let minApprovalScore: number;
  const codes: Record<'approved' | 'rejected' | 'approved3', string> = {} as never;
  const plans: Record<3 | 6 | 12, Plan> = {} as never;
  let savedConfigs: Array<{ key: string; value: string; valueType: never; description: string | null }> = [];
  const paymentIds: string[] = [];

  let application: Application;
  let accountId: string;
  let creditOrder: Checkout; // order 1 — BANK_CREDIT
  let hybridOrder: Checkout; // order 2 — HYBRID

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

  const onboardStore = async (login: { token: string }, storeSlug: string): Promise<string> => {
    const registered = await request<{ id: string }>('/vendors/register', {
      method: 'POST',
      token: login.token,
      body: { storeName: `فروشگاه آزمون اعتباری ${storeSlug}`, storeSlug, bio: 'فروشگاه آزمون فاز هشت', bankIban: VENDOR_IBAN, bankAccountHolder: 'شرکت آزمون اعتباری' },
    });
    expect(registered.status).toBe(201);
    const form = new FormData();
    const pdf = Buffer.concat([Buffer.from(`%PDF-1.7\n% credit e2e ${RUN}\n`, 'latin1'), Buffer.from('%%EOF', 'latin1')]);
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
      body: { status: 'APPROVED', rejectionReason: null, commissionRateOverride: null },
    });
    expect(verified.status).toBe(200);
    return registered.body.id;
  };

  const createAddress = async (token: string, recipientMobile: string): Promise<string> => {
    const address = await request<{ id: string }>('/customer/addresses', {
      method: 'POST',
      token,
      body: {
        province: 'تهران',
        city: 'تهران',
        postalAddress: 'خیابان انقلاب، پلاک ۸',
        postalCode: '1458889999',
        buildingNumber: '8',
        unitNumber: '1',
        recipientName: 'مشتری آزمون اعتباری',
        recipientMobile,
      },
    });
    expect(address.status).toBe(201);
    return address.body.id;
  };

  const placeOrder = async (quantity: number, token = customer.token, address = addressId): Promise<Checkout> => {
    expect((await request('/cart/clear', { method: 'POST', token })).status).toBe(200);
    expect((await request('/cart/items', { method: 'POST', token, body: { productVariantId: variantId, quantity } })).status).toBe(200);
    const placed = await request<Checkout>('/orders/checkout', { method: 'POST', token, body: { addressId: address } });
    expect(placed.status).toBe(201);
    return placed.body;
  };

  const creditInitiate = (parentOrderId: string, planId: string, paymentMethod: string, token = customer.token): Promise<HttpResult<CreditInitiate & ErrorBody>> =>
    request<CreditInitiate & ErrorBody>('/payments/credit/initiate', { method: 'POST', token, body: { parentOrderId, planId, paymentMethod } });

  /** The payer's decision on the sandbox bank page; returns the callback path the browser is redirected to. */
  const decide = async (paymentId: string, decision: 'PAY' | 'DECLINE'): Promise<string> => {
    paymentIds.push(paymentId);
    const response = await request(`/sandbox/payment-page/${paymentId}/decision`, { method: 'POST', form: { decision } });
    expect(response.status).toBe(303);
    const location = new URL(String(response.headers['location']));
    return `${location.pathname.slice(API.length)}${location.search}`;
  };

  const account = async (token = customer.token): Promise<Account> => {
    const response = await request<Account>('/credit/account', { token });
    expect(response.status).toBe(200);
    return response.body;
  };

  const installments = async (token = customer.token): Promise<InstallmentsOverview> => {
    const response = await request<InstallmentsOverview>('/credit/installments', { token });
    expect(response.status).toBe(200);
    return response.body;
  };

  /**
   * The acceptance invariant: the stored balances satisfy total = used + reserved
   * + available, equal the replay of the account's credit ledger, the latest
   * balanceAfter equals availableAmount, and match the expected figures.
   */
  const expectAccount = async (id: string, expected: { total: number; used: number; reserved: number; available: number }): Promise<void> => {
    const row = await prisma.creditAccount.findUniqueOrThrow({ where: { id } });
    const balances = { totalLimit: row.totalLimit, usedAmount: row.usedAmount, reservedAmount: row.reservedAmount, availableAmount: row.availableAmount };
    expect([row.totalLimit, row.usedAmount, row.reservedAmount, row.availableAmount].map((v) => v.toFixed(2))).toEqual(
      [expected.total, expected.used, expected.reserved, expected.available].map((v) => d(v).toFixed(2)),
    );
    expect(holdsInvariant(balances)).toBe(true);
    const ledgerRows = await prisma.creditTransaction.findMany({ where: { creditAccountId: id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    const replayed = replayCreditLedger(ledgerRows);
    expect([replayed.totalLimit, replayed.usedAmount, replayed.reservedAmount, replayed.availableAmount].map((v) => v.toFixed(2))).toEqual(
      [row.totalLimit, row.usedAmount, row.reservedAmount, row.availableAmount].map((v) => v.toFixed(2)),
    );
    // rows written by one transaction may share a timestamp: one of the latest rows carries the current available balance
    const latestAt = Math.max(...ledgerRows.map((r) => r.createdAt.getTime()));
    const latest = ledgerRows.filter((r) => r.createdAt.getTime() === latestAt).map((r) => r.balanceAfter.toFixed(2));
    expect(latest).toContain(row.availableAmount.toFixed(2));
  };

  const sandboxReservation = async (ref: string): Promise<string | null> => {
    const raw = await redis.client.get(sandboxReservationKey(ref));
    return raw ? (JSON.parse(raw) as { status: string }).status : null;
  };

  const setConfig = async (key: string, value: string, valueType: 'NUMBER' | 'BOOLEAN' = 'NUMBER'): Promise<void> => {
    await prisma.systemConfig.upsert({ where: { key }, update: { value }, create: { key, value, valueType, description: `credit e2e ${RUN}` } });
  };

  const vendorWallet = async (): Promise<{ pendingBalance: string }> => {
    const response = await request<{ pendingBalance: string }>('/vendor/wallet', { token: vendor.token });
    expect(response.status).toBe(200);
    return response.body;
  };

  // ─── lifecycle ─────────────────────────────────────────────────────────────

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    applyGlobalPolicies(app, app.get(ConfigService));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = app.get(PrismaService);
    redis = app.get(RedisService);
    await resetKeys();

    const adminPassword = process.env['SUPER_ADMIN_PASSWORD'];
    const staffPassword = process.env['SEED_STAFF_PASSWORD'];
    if (adminPassword === undefined || staffPassword === undefined) {
      throw new Error('This suite needs SUPER_ADMIN_PASSWORD and SEED_STAFF_PASSWORD from the root .env.');
    }
    adminToken = (await loginWithPassword(SEEDED_ADMIN_EMAIL, adminPassword)).token;
    supportToken = (await loginWithPassword(SEEDED_SUPPORT_EMAIL, staffPassword)).token;
    financeToken = (await loginWithPassword(SEEDED_FINANCE_EMAIL, staffPassword)).token;

    const configKeys = [...Object.values(SHIPPING_CONFIG_KEYS), CREDIT_CONFIG_KEYS.enabled, CREDIT_CONFIG_KEYS.activeProvider];
    savedConfigs = (await prisma.systemConfig.findMany({ where: { key: { in: configKeys } }, select: { key: true, value: true, valueType: true, description: true } })) as never;
    await setConfig(SHIPPING_CONFIG_KEYS.defaultFeePerVendor, '450000');
    await setConfig(SHIPPING_CONFIG_KEYS.freeThresholdPerVendor, '20000000');
    await setConfig(CREDIT_CONFIG_KEYS.enabled, 'true', 'BOOLEAN');
    await prisma.systemConfig.update({ where: { key: CREDIT_CONFIG_KEYS.activeProvider }, data: { value: 'SANDBOX_BANK' } });

    const sandbox = await prisma.creditProvider.findUniqueOrThrow({ where: { code: 'SANDBOX_BANK' } });
    expect(sandbox.isActive).toBe(true);
    minApprovalScore = parseSandboxRules(sandbox.config).minApprovalScore;
    const taken = new Set((await prisma.user.findMany({ where: { nationalCode: { not: null } }, select: { nationalCode: true } })).map((u) => u.nationalCode!));
    codes.approved = generateNationalCode((score) => score >= minApprovalScore, taken);
    codes.approved3 = generateNationalCode((score) => score >= minApprovalScore, taken);
    codes.rejected = generateNationalCode((score) => score < minApprovalScore, taken);

    const category = await request<{ id: string }>('/admin/categories', {
      method: 'POST',
      token: adminToken,
      body: { slug: `e2e-credit-${RUN}`, titleFa: `دسته آزمون اعتباری ${RUN}`, defaultCommissionRate: 10 },
    });
    expect(category.status).toBe(201);
    categoryId = category.body.id;

    const v = await loginWithOtp(VENDOR_MOBILE);
    customer = await loginWithOtp(CUSTOMER_MOBILE);
    customer2 = await loginWithOtp(CUSTOMER_2_MOBILE);
    customer3 = await loginWithOtp(CUSTOMER_3_MOBILE);
    vendor = { ...v, vendorId: await onboardStore(v, `credit-e2e-${RUN}`) };
    const product = await request<{ variants: Array<{ id: string }> }>('/vendor/products', {
      method: 'POST',
      token: vendor.token,
      body: { title: `یخچال آزمون اعتباری ${RUN}`, categoryId, basePrice: 3_000_000, isPublished: true, variants: [{ sku: `CRD-${TAG}-P1`, price: 3_000_000, stockQuantity: 50 }] },
    });
    expect(product.status).toBe(201);
    variantId = product.body.variants[0]!.id;
    addressId = await createAddress(customer.token, '09971160002');
    address3Id = await createAddress(customer3.token, '09971160004');
  }, 180_000);

  afterAll(async () => {
    if (prisma !== undefined) {
      const users = await prisma.user.findMany({ where: { mobile: { in: SUITE_MOBILES } }, select: { id: true } });
      const userIds = users.map((user) => user.id);
      const vendors = await prisma.vendor.findMany({ where: { userId: { in: userIds } }, select: { id: true } });
      const vendorIds = vendors.map((row) => row.id);
      const orders = await prisma.parentOrder.findMany({ where: { userId: { in: userIds } }, select: { id: true, subOrders: { select: { id: true } } } });
      const orderIds = orders.map((row) => row.id);
      const subIds = orders.flatMap((row) => row.subOrders.map((sub) => sub.id));
      const payments = await prisma.payment.findMany({ where: { parentOrderId: { in: orderIds } }, select: { id: true, creditReservationRef: true } });
      const accounts = await prisma.creditAccount.findMany({ where: { userId: { in: userIds } }, select: { id: true } });
      const accountIds = accounts.map((row) => row.id);
      const applications = await prisma.creditApplication.findMany({ where: { userId: { in: userIds } }, select: { id: true } });
      const schedules = await prisma.installmentSchedule.findMany({ where: { parentOrderId: { in: orderIds } }, select: { id: true } });
      const reservationRefs = (await prisma.creditTransaction.findMany({ where: { creditAccountId: { in: accountIds }, type: CreditTransactionType.PURCHASE_RESERVE_HOLD }, select: { referenceCode: true } })).map((r) => r.referenceCode);
      const products = await prisma.product.findMany({ where: { vendorId: { in: vendorIds } }, select: { id: true, variants: { select: { id: true } } } });
      const productIds = products.map((row) => row.id);
      const variantIds = products.flatMap((row) => row.variants.map((variant) => variant.id));
      const entityIds = [
        ...vendorIds,
        ...productIds,
        ...variantIds,
        ...orderIds,
        ...subIds,
        ...payments.map((p) => p.id),
        ...accountIds,
        ...applications.map((a) => a.id),
        ...schedules.map((s) => s.id),
        categoryId,
      ].filter(Boolean);

      await prisma.auditLog.deleteMany({ where: { OR: [{ userId: { in: userIds } }, { userAgent: TEST_UA }, { entityId: { in: entityIds } }] } });
      await prisma.vendorWallet.deleteMany({ where: { vendorId: { in: vendorIds } } });
      await prisma.payment.deleteMany({ where: { parentOrderId: { in: orderIds } } });
      await prisma.installmentSchedule.deleteMany({ where: { parentOrderId: { in: orderIds } } });
      await prisma.creditTransaction.deleteMany({ where: { creditAccountId: { in: accountIds } } });
      await prisma.parentOrder.deleteMany({ where: { id: { in: orderIds } } });
      await prisma.creditAccount.deleteMany({ where: { id: { in: accountIds } } });
      await prisma.creditApplication.deleteMany({ where: { userId: { in: userIds } } });
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

      const configKeys = [...Object.values(SHIPPING_CONFIG_KEYS), CREDIT_CONFIG_KEYS.enabled, CREDIT_CONFIG_KEYS.activeProvider];
      await prisma.systemConfig.deleteMany({ where: { key: { in: configKeys } } });
      for (const row of savedConfigs) await prisma.systemConfig.create({ data: row });
      await app.get(CategoriesService).invalidateTree();

      for (const paymentId of [...new Set([...paymentIds, ...payments.map((p) => p.id)])]) {
        const authority = await redis.client.get(`payment:sandbox:payment:${paymentId}`);
        await redis.client.del(`payment:sandbox:payment:${paymentId}`, ...(authority ? [`payment:sandbox:session:${authority}`] : []));
      }
      const refs = [...new Set([...reservationRefs, ...payments.map((p) => p.creditReservationRef).filter((r): r is string => r !== null)])];
      if (refs.length > 0) await redis.client.del(...refs.map(sandboxReservationKey));
      // Reservations whose transaction rolled back (e.g. the loser of the concurrency test) never reach the DB:
      // find them by the suite's orders in the sandbox bank's own records.
      const suiteOrders = new Set(orderIds);
      for (const key of await redis.client.keys(sandboxReservationKey('*'))) {
        const raw = await redis.client.get(key);
        const record = raw === null ? null : (JSON.parse(raw) as { parentOrderId?: string });
        if (record?.parentOrderId !== undefined && suiteOrders.has(record.parentOrderId)) await redis.client.del(key);
      }
      if (userIds.length > 0) await redis.client.del(...userIds.flatMap((id) => [creditApplyCountKey(id), creditApplyLockKey(id)]));
      await resetKeys();
    }
    await app?.close();
  }, 120_000);

  async function resetKeys(): Promise<void> {
    const client = app.get(RedisService).client;
    const keys = [
      ...(await client.keys('auth:otp:hourly:ip:*')),
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
    if (keys.length > 0) await client.del(...keys);
  }

  // ─── 1. plans ──────────────────────────────────────────────────────────────

  describe('instalment plans', () => {
    it('lists the active plans of the active (sandbox) provider publicly', async () => {
      const response = await request<{ creditEnabled: boolean; provider: { code: string; isSandbox: boolean }; items: Plan[] }>('/credit/plans');
      expect(response.status).toBe(200);
      expect(response.body.creditEnabled).toBe(true);
      expect(response.body.provider).toMatchObject({ code: 'SANDBOX_BANK', isSandbox: true });
      expect(response.body.items.map((plan) => [plan.durationMonths, plan.interestRatePercent])).toEqual([
        [3, '0.00'],
        [6, '9.00'],
        [12, '18.00'],
      ]);
      expect(response.body.items.every((plan) => plan.installmentIntervalDays === 30)).toBe(true);
      for (const plan of response.body.items) plans[plan.durationMonths as 3 | 6 | 12] = plan;
    });

    it('offers nothing and refuses credit operations while credit.enabled is false', async () => {
      await setConfig(CREDIT_CONFIG_KEYS.enabled, 'false', 'BOOLEAN');
      try {
        const listed = await request<{ creditEnabled: boolean; items: Plan[] }>('/credit/plans');
        expect(listed.body).toMatchObject({ creditEnabled: false, items: [] });
        const applied = await request<ErrorBody>('/credit/applications', {
          method: 'POST',
          token: customer.token,
          body: { requestedLimit: 20_000_000, nationalCode: codes.approved, providerCode: 'SANDBOX_BANK' },
        });
        expect(applied.status).toBe(503);
        expect(applied.body.code).toBe('CREDIT_DISABLED');
      } finally {
        await setConfig(CREDIT_CONFIG_KEYS.enabled, 'true', 'BOOLEAN');
      }
    });
  });

  // ─── 2. applications ───────────────────────────────────────────────────────

  describe('credit applications', () => {
    const body = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
      requestedLimit: 20_000_000,
      nationalCode: codes.approved,
      providerCode: 'SANDBOX_BANK',
      ...overrides,
    });

    it('enforces authentication, role and validation', async () => {
      expect((await request('/credit/applications', { method: 'POST', body: body() })).status).toBe(401);
      expect((await request('/credit/applications', { method: 'POST', token: vendor.token, body: body() })).status).toBe(403);
      const badChecksum = `${codes.approved.slice(0, 9)}${(Number(codes.approved[9]) + 1) % 10}`;
      expect((await request('/credit/applications', { method: 'POST', token: customer.token, body: body({ nationalCode: badChecksum }) })).status).toBe(400);
      expect((await request('/credit/applications', { method: 'POST', token: customer.token, body: body({ requestedLimit: 20_000_000.5 }) })).status).toBe(400);
      expect((await request('/credit/applications', { method: 'POST', token: customer.token, body: body({ requestedLimit: 0 }) })).status).toBe(400);
      const inactive = await request<ErrorBody>('/credit/applications', { method: 'POST', token: customer.token, body: body({ providerCode: 'BLUBANK' }) });
      expect(inactive.status).toBe(409);
      expect(inactive.body.code).toBe('CREDIT_PROVIDER_NOT_ACTIVE');
    });

    it('records a rejection with its reason and opens no account (score below threshold)', async () => {
      const response = await request<Application>('/credit/applications', { method: 'POST', token: customer2.token, body: body({ nationalCode: codes.rejected }) });
      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({ status: 'REJECTED', decisionReason: 'SCORE_BELOW_THRESHOLD', approvedLimit: null, account: null, score: sandboxCreditScore(codes.rejected) });
      expect(response.body.provider).toMatchObject({ code: 'SANDBOX_BANK', isSandbox: true });
      expect(await prisma.creditAccount.count({ where: { userId: customer2.userId } })).toBe(0);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: customer2.userId } })).nationalCode).toBeNull();
      const missing = await request<ErrorBody>('/credit/account', { token: customer2.token });
      expect(missing.status).toBe(404);
      expect(missing.body.code).toBe('CREDIT_ACCOUNT_NOT_FOUND');
    });

    it('approves instantly: application, account with the exact limit and one CREDIT_ALLOCATION row, in one step', async () => {
      const response = await request<Application>('/credit/applications', { method: 'POST', token: customer.token, body: body() });
      expect(response.status).toBe(201);
      application = response.body;
      expect(application).toMatchObject({ status: 'APPROVED', requestedLimit: '20000000.00', approvedLimit: '20000000.00', decisionReason: null, score: sandboxCreditScore(codes.approved) });
      expect(application.trackingCode).toMatch(/^SBXA-[0-9A-F]{16}$/);
      expect(application.account).toMatchObject({ status: 'ACTIVE', totalLimit: '20000000.00', usedAmount: '0.00', reservedAmount: '0.00', availableAmount: '20000000.00', currency: 'IRR' });
      accountId = application.account!.id;

      const ledgerRows = await prisma.creditTransaction.findMany({ where: { creditAccountId: accountId } });
      expect(ledgerRows).toHaveLength(1);
      expect(ledgerRows[0]).toMatchObject({ type: 'CREDIT_ALLOCATION', referenceCode: application.id });
      expect(ledgerRows[0]!.amount.toFixed(2)).toBe('20000000.00');
      expect(ledgerRows[0]!.balanceAfter.toFixed(2)).toBe('20000000.00');
      await expectAccount(accountId, { total: 20_000_000, used: 0, reserved: 0, available: 20_000_000 });

      expect((await prisma.user.findUniqueOrThrow({ where: { id: customer.userId } })).nationalCode).toBe(codes.approved);
      expect(await prisma.auditLog.count({ where: { entityName: 'CreditApplication', entityId: application.id, action: AuditAction.CREDIT_DECISION } })).toBe(1);
    });

    it('GET /credit/account returns the balances and the active provider', async () => {
      const current = await account();
      expect(current).toMatchObject({
        id: accountId,
        provider: { code: 'SANDBOX_BANK', isSandbox: true },
        status: 'ACTIVE',
        totalLimit: '20000000.00',
        usedAmount: '0.00',
        reservedAmount: '0.00',
        availableAmount: '20000000.00',
        outstanding: { count: 0, overdueCount: 0, principal: '0.00', interest: '0.00', nextDueDate: null },
      });
      expect((await request('/credit/account')).status).toBe(401);
    });

    it('refuses a second account with the same provider and a national code of another user', async () => {
      const again = await request<ErrorBody>('/credit/applications', { method: 'POST', token: customer.token, body: body() });
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('CREDIT_ACCOUNT_EXISTS');
      const stolen = await request<ErrorBody>('/credit/applications', { method: 'POST', token: customer3.token, body: body() });
      expect(stolen.status).toBe(409);
      expect(stolen.body.code).toBe('NATIONAL_CODE_IN_USE');
    });

    it('opens the account of the third customer (used by the concurrency test)', async () => {
      const response = await request<Application>('/credit/applications', {
        method: 'POST',
        token: customer3.token,
        body: body({ nationalCode: codes.approved3, requestedLimit: 10_000_000 }),
      });
      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({ status: 'APPROVED', approvedLimit: '10000000.00' });
    });
  });

  // ─── 3. BANK_CREDIT ────────────────────────────────────────────────────────

  describe('BANK_CREDIT checkout', () => {
    beforeAll(async () => {
      creditOrder = await placeOrder(2);
    });

    it('prices the order as documented (6,450,000 IRR)', () => {
      expect(creditOrder.finalPayableAmount).toBe('6450000.00');
    });

    it('validates the request: role, ownership, plan and method', async () => {
      const payload = { parentOrderId: creditOrder.parentOrderId, planId: plans[6].id, paymentMethod: 'BANK_CREDIT' };
      expect((await request('/payments/credit/initiate', { method: 'POST', body: payload })).status).toBe(401);
      expect((await request('/payments/credit/initiate', { method: 'POST', token: vendor.token, body: payload })).status).toBe(403);
      expect((await creditInitiate(creditOrder.parentOrderId, plans[6].id, 'BANK_CREDIT', customer2.token)).status).toBe(404);
      expect((await creditInitiate(creditOrder.parentOrderId, plans[6].id, 'CASH_IPG')).status).toBe(400);
      const unknownPlan = await creditInitiate(creditOrder.parentOrderId, '00000000-0000-4000-8000-000000000000', 'BANK_CREDIT');
      expect(unknownPlan.status).toBe(400);
      expect(unknownPlan.body.code).toBe('INSTALLMENT_PLAN_NOT_AVAILABLE');
      const hybrid = await creditInitiate(creditOrder.parentOrderId, plans[6].id, 'HYBRID');
      expect(hybrid.status).toBe(409);
      expect(hybrid.body.code).toBe('HYBRID_NOT_REQUIRED');
      await expectAccount(accountId, { total: 20_000_000, used: 0, reserved: 0, available: 20_000_000 });
    });

    it('completes immediately: order PAID, packages PENDING_APPROVAL, credit committed, schedule written, escrow funded', async () => {
      const escrowBefore = d((await vendorWallet()).pendingBalance);
      const stockBefore = await prisma.productVariant.findUniqueOrThrow({ where: { id: variantId } });
      const response = await creditInitiate(creditOrder.parentOrderId, plans[6].id, 'BANK_CREDIT');
      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        status: 'COMPLETED',
        orderNumber: creditOrder.orderNumber,
        paymentMethod: 'BANK_CREDIT',
        creditAmount: '6450000.00',
        cashAmount: '0.00',
        orderPaymentStatus: 'PAID',
        redirectUrl: null,
        schedule: { installments: 6, creditAmount: '6450000.00', totalInterest: '580500.00', totalPayable: '7030500.00' },
      });

      const order = await prisma.parentOrder.findUniqueOrThrow({ where: { id: creditOrder.parentOrderId }, include: { subOrders: true } });
      expect(order).toMatchObject({ paymentStatus: 'PAID', paymentMethod: 'BANK_CREDIT' });
      expect(order.subOrders.map((sub) => sub.status)).toEqual(['PENDING_APPROVAL']);
      const payment = await prisma.payment.findUniqueOrThrow({ where: { id: response.body.paymentId } });
      expect(payment).toMatchObject({ status: 'SUCCESSFUL', paymentMethod: 'BANK_CREDIT', purpose: 'ORDER_CHECKOUT', gatewayName: 'SANDBOX_BANK', creditAccountId: accountId, installmentPlanId: plans[6].id });
      expect(payment.creditAmount.toFixed(2)).toBe('6450000.00');
      expect(payment.cashAmount.toFixed(2)).toBe('0.00');

      // Schedule: 6 rows, 30 days apart from the (Tehran) payment date, principal sum = creditAmount exactly.
      const rows = await prisma.installmentSchedule.findMany({ where: { parentOrderId: creditOrder.parentOrderId }, orderBy: { installmentNumber: 'asc' } });
      expect(rows).toHaveLength(6);
      const purchaseDate = platformDate(order.paidAt!);
      rows.forEach((row, index) => {
        expect(row.installmentNumber).toBe(index + 1);
        expect(row.totalInstallments).toBe(6);
        expect(row.status).toBe('PENDING');
        expect(row.creditAccountId).toBe(accountId);
        expect(dbDateToCalendar(row.dueDate)).toBe(addDays(purchaseDate, 30 * (index + 1)));
        expect(row.principalAmount.toFixed(2)).toBe('1075000.00');
        expect(row.interestAmount.toFixed(2)).toBe('96750.00');
        expect(row.totalAmount.toFixed(2)).toBe('1171750.00');
      });
      expect(rows.reduce((acc, row) => acc.plus(row.principalAmount), d(0)).toFixed(2)).toBe('6450000.00');
      expect(response.body.schedule).toMatchObject({ firstDueDate: addDays(purchaseDate, 30), lastDueDate: addDays(purchaseDate, 180) });

      // Credit: HOLD then COMMIT of the same reservation; provider side COMMITTED.
      const ref = payment.creditReservationRef!;
      const movements = await prisma.creditTransaction.findMany({ where: { creditAccountId: accountId, referenceCode: ref }, orderBy: { createdAt: 'asc' } });
      expect(movements.map((m) => m.type).sort()).toEqual(['PURCHASE_COMMIT', 'PURCHASE_RESERVE_HOLD']);
      expect(movements.every((m) => m.amount.equals(6_450_000) && m.parentOrderId === creditOrder.parentOrderId)).toBe(true);
      expect(await sandboxReservation(ref)).toBe('COMMITTED');
      await expectAccount(accountId, { total: 20_000_000, used: 6_450_000, reserved: 0, available: 13_550_000 });

      // Escrow: 6,000,000 − 10 % = 5,400,000; stock committed.
      expect(d((await vendorWallet()).pendingBalance).minus(escrowBefore).toFixed(2)).toBe('5400000.00');
      const stockAfter = await prisma.productVariant.findUniqueOrThrow({ where: { id: variantId } });
      expect(stockAfter.stockQuantity).toBe(stockBefore.stockQuantity - 2);
      expect(stockAfter.reservedQuantity).toBe(stockBefore.reservedQuantity - 2);
      expect(await prisma.auditLog.count({ where: { entityName: 'Payment', entityId: payment.id, action: AuditAction.PAYMENT_CAPTURE } })).toBe(1);

      const current = await account();
      expect(current.outstanding).toMatchObject({ count: 6, overdueCount: 0, principal: '6450000.00', interest: '580500.00', nextDueDate: addDays(purchaseDate, 30) });
    });

    it('cannot be paid twice, and credit orders cannot be cancelled by the store yet', async () => {
      const again = await creditInitiate(creditOrder.parentOrderId, plans[6].id, 'BANK_CREDIT');
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('ORDER_NOT_PAYABLE');
      const cancel = await request<ErrorBody>(`/vendor/orders/${creditOrder.subOrders[0]!.id}/status`, {
        method: 'PATCH',
        token: vendor.token,
        body: { status: 'CANCELLED', reason: 'ناموجود' },
      });
      expect(cancel.status).toBe(409);
      expect(cancel.body.code).toBe('CREDIT_ORDER_REFUND_UNSUPPORTED');
      await expectAccount(accountId, { total: 20_000_000, used: 6_450_000, reserved: 0, available: 13_550_000 });
    });

    it('concurrent BANK_CREDIT submissions for one order complete it exactly once', async () => {
      const order3 = await placeOrder(1, customer3.token, address3Id);
      expect(order3.finalPayableAmount).toBe('3450000.00');
      const results = await Promise.all([
        creditInitiate(order3.parentOrderId, plans[3].id, 'BANK_CREDIT', customer3.token),
        creditInitiate(order3.parentOrderId, plans[3].id, 'BANK_CREDIT', customer3.token),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      const account3 = await prisma.creditAccount.findFirstOrThrow({ where: { userId: customer3.userId } });
      await expectAccount(account3.id, { total: 10_000_000, used: 3_450_000, reserved: 0, available: 6_550_000 });
      expect(await prisma.creditTransaction.count({ where: { creditAccountId: account3.id, type: 'PURCHASE_COMMIT' } })).toBe(1);
      expect(await prisma.installmentSchedule.count({ where: { parentOrderId: order3.parentOrderId } })).toBe(3);
    });
  });

  // ─── 4. HYBRID ─────────────────────────────────────────────────────────────

  describe('HYBRID checkout', () => {
    beforeAll(async () => {
      hybridOrder = await placeOrder(5);
    });

    it('prices the order (15,450,000) above the available credit; BANK_CREDIT is refused', async () => {
      expect(hybridOrder.finalPayableAmount).toBe('15450000.00');
      const refused = await creditInitiate(hybridOrder.parentOrderId, plans[3].id, 'BANK_CREDIT');
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('INSUFFICIENT_CREDIT');
    });

    it('a failed card part rolls the credit reservation back; the order stays payable', async () => {
      const started = await creditInitiate(hybridOrder.parentOrderId, plans[3].id, 'HYBRID');
      expect(started.status).toBe(201);
      expect(started.body).toMatchObject({ status: 'IPG_REQUIRED', paymentMethod: 'HYBRID', creditAmount: '13550000.00', cashAmount: '1900000.00', gatewayName: 'SANDBOX', orderPaymentStatus: 'PENDING', schedule: null });
      expect(started.body.redirectUrl).toMatch(new RegExp(`/api/v1/sandbox/payment-page/${started.body.paymentId}$`));
      const payment = await prisma.payment.findUniqueOrThrow({ where: { id: started.body.paymentId } });
      expect(payment).toMatchObject({ status: 'INITIATED', paymentMethod: 'HYBRID' });
      expect(payment.cashAmount.toFixed(2)).toBe('1900000.00');
      expect(payment.creditAmount.toFixed(2)).toBe('13550000.00');
      await expectAccount(accountId, { total: 20_000_000, used: 6_450_000, reserved: 13_550_000, available: 0 });
      expect(await sandboxReservation(payment.creditReservationRef!)).toBe('RESERVED');

      const outcome = await request<Outcome>(await decide(started.body.paymentId, 'DECLINE'));
      expect(outcome.status).toBe(200);
      expect(outcome.body).toMatchObject({ outcome: 'FAILED', paymentStatus: 'FAILED', orderPaymentStatus: 'PENDING', canRetry: true, paymentMethod: 'HYBRID', creditAmount: '13550000.00', cashAmount: '1900000.00' });
      await expectAccount(accountId, { total: 20_000_000, used: 6_450_000, reserved: 0, available: 13_550_000 });
      const release = await prisma.creditTransaction.findFirstOrThrow({ where: { type: 'RESERVATION_RELEASE', referenceCode: payment.creditReservationRef! } });
      expect(release.amount.toFixed(2)).toBe('13550000.00');
      expect(await sandboxReservation(payment.creditReservationRef!)).toBe('RELEASED');
      expect(await prisma.installmentSchedule.count({ where: { parentOrderId: hybridOrder.parentOrderId } })).toBe(0);
    });

    it('a verified card part completes the order: PAID, credit committed, cash recorded, schedule written', async () => {
      const escrowBefore = d((await vendorWallet()).pendingBalance);
      const started = await creditInitiate(hybridOrder.parentOrderId, plans[3].id, 'HYBRID');
      expect(started.status).toBe(201);
      const outcome = await request<Outcome>(await decide(started.body.paymentId, 'PAY'));
      expect(outcome.status).toBe(200);
      expect(outcome.body).toMatchObject({ outcome: 'PAID', paymentStatus: 'SUCCESSFUL', orderPaymentStatus: 'PAID', purpose: 'ORDER_CHECKOUT', paymentMethod: 'HYBRID' });
      expect(outcome.body.bankRrn).toMatch(/^\d{12}$/);

      const payment = await prisma.payment.findUniqueOrThrow({ where: { id: started.body.paymentId } });
      expect(payment.status).toBe('SUCCESSFUL');
      expect(payment.cashAmount.toFixed(2)).toBe('1900000.00');
      expect(payment.bankRrn).toBe(outcome.body.bankRrn);
      const order = await prisma.parentOrder.findUniqueOrThrow({ where: { id: hybridOrder.parentOrderId } });
      expect(order).toMatchObject({ paymentStatus: 'PAID', paymentMethod: 'HYBRID' });
      await expectAccount(accountId, { total: 20_000_000, used: 20_000_000, reserved: 0, available: 0 });
      expect(await sandboxReservation(payment.creditReservationRef!)).toBe('COMMITTED');

      const rows = await prisma.installmentSchedule.findMany({ where: { parentOrderId: hybridOrder.parentOrderId }, orderBy: { installmentNumber: 'asc' } });
      expect(rows.map((row) => row.principalAmount.toFixed(0))).toEqual(['4516666', '4516666', '4516668']);
      expect(rows.every((row) => row.interestAmount.isZero())).toBe(true);
      const purchaseDate = platformDate(order.paidAt!);
      expect(rows.map((row) => dbDateToCalendar(row.dueDate))).toEqual([30, 60, 90].map((days) => addDays(purchaseDate, days)));
      // 15,000,000 − 10 % = 13,500,000 into escrow
      expect(d((await vendorWallet()).pendingBalance).minus(escrowBefore).toFixed(2)).toBe('13500000.00');

      const repeated = await request<Outcome>(`/payments/callback?Authority=${payment.gatewayTrackingToken!}&Status=OK`);
      expect(repeated.body.outcome).toBe('PAID');
      expect(await prisma.creditTransaction.count({ where: { type: 'PURCHASE_COMMIT', referenceCode: payment.creditReservationRef! } })).toBe(1);
    });
  });

  // ─── 5. instalments ────────────────────────────────────────────────────────

  describe('instalments and repayment', () => {
    it('lists instalments grouped by order', async () => {
      const overview = await installments();
      expect(overview.orders.map((o) => o.orderNumber).sort()).toEqual([creditOrder.orderNumber, hybridOrder.orderNumber].sort());
      const first = overview.orders.find((o) => o.parentOrderId === creditOrder.parentOrderId)!;
      expect(first).toMatchObject({ paymentMethod: 'BANK_CREDIT', creditAmount: '6450000.00', totalInterest: '580500.00', totalPayable: '7030500.00', paidAmount: '0.00', remainingAmount: '7030500.00', paidCount: 0 });
      expect(first.plan).toMatchObject({ id: plans[6].id, durationMonths: 6 });
      expect(first.installments.map((i) => i.status)).toEqual(Array(6).fill('PENDING'));
      expect(first.installments[0]).toMatchObject({ amountDue: '1171750.00', paidAt: null });
      expect(overview.totalRemaining).toBe('20580500.00'); // 7,030,500 + 13,550,000
    });

    it('marks an instalment whose due date has passed as OVERDUE', async () => {
      const second = await prisma.installmentSchedule.findFirstOrThrow({ where: { parentOrderId: creditOrder.parentOrderId, installmentNumber: 2 } });
      await prisma.installmentSchedule.update({ where: { id: second.id }, data: { dueDate: calendarDateToDb(addDays(platformDate(new Date()), -1)) } });
      const overview = await installments();
      const first = overview.orders.find((o) => o.parentOrderId === creditOrder.parentOrderId)!;
      expect(first.installments.map((i) => i.status)).toEqual(['PENDING', 'OVERDUE', 'PENDING', 'PENDING', 'PENDING', 'PENDING']);
      expect(overview.overdueCount).toBe(1);
      // the scheduler's sweep is idempotent
      expect(await app.get(InstallmentsService).markOverdue()).toBe(0);
    });

    it('guards the pay endpoint: auth, ownership, id format', async () => {
      const target = (await installments()).orders.find((o) => o.parentOrderId === creditOrder.parentOrderId)!.installments[0]!;
      expect((await request(`/credit/installments/${target.id}/pay`, { method: 'POST' })).status).toBe(401);
      expect((await request(`/credit/installments/${target.id}/pay`, { method: 'POST', token: customer2.token })).status).toBe(404);
      expect((await request('/credit/installments/not-a-uuid/pay', { method: 'POST', token: customer.token })).status).toBe(400);
    });

    it('a declined repayment leaves the instalment unpaid and payable', async () => {
      const target = (await installments()).orders.find((o) => o.parentOrderId === creditOrder.parentOrderId)!.installments[2]!;
      const started = await request<{ paymentId: string; amount: string; redirectUrl: string }>(`/credit/installments/${target.id}/pay`, { method: 'POST', token: customer.token });
      expect(started.status).toBe(201);
      const outcome = await request<Outcome>(await decide(started.body.paymentId, 'DECLINE'));
      expect(outcome.body).toMatchObject({ outcome: 'FAILED', purpose: 'INSTALLMENT_REPAYMENT', installmentScheduleId: target.id, canRetry: true });
      expect((await prisma.installmentSchedule.findUniqueOrThrow({ where: { id: target.id } })).status).toBe('PENDING');
      await expectAccount(accountId, { total: 20_000_000, used: 20_000_000, reserved: 0, available: 0 });
    });

    it('paying an instalment marks it PAID and restores its principal to the credit line', async () => {
      const target = (await installments()).orders.find((o) => o.parentOrderId === creditOrder.parentOrderId)!.installments[0]!;
      const started = await request<{ paymentId: string; amount: string; redirectUrl: string; installmentNumber: number; gatewayName: string }>(
        `/credit/installments/${target.id}/pay`,
        { method: 'POST', token: customer.token },
      );
      expect(started.status).toBe(201);
      expect(started.body).toMatchObject({ amount: '1171750.00', installmentNumber: 1, gatewayName: 'SANDBOX' });
      const outcome = await request<Outcome>(await decide(started.body.paymentId, 'PAY'));
      expect(outcome.body).toMatchObject({ outcome: 'PAID', paymentStatus: 'SUCCESSFUL', purpose: 'INSTALLMENT_REPAYMENT', paymentMethod: 'CASH_IPG', cashAmount: '1171750.00', installmentScheduleId: target.id });

      const row = await prisma.installmentSchedule.findUniqueOrThrow({ where: { id: target.id } });
      expect(row.status).toBe('PAID');
      expect(row.paidAt).not.toBeNull();
      expect(row.paidAmount.toFixed(2)).toBe('1171750.00');
      expect(row.bankTransactionId).toBe(outcome.body.bankRrn);
      const restore = await prisma.creditTransaction.findFirstOrThrow({ where: { type: 'INSTALLMENT_REPAYMENT_RESTORE', referenceCode: target.id } });
      expect(restore.amount.toFixed(2)).toBe('1075000.00');
      await expectAccount(accountId, { total: 20_000_000, used: 18_925_000, reserved: 0, available: 1_075_000 });

      const again = await request<ErrorBody>(`/credit/installments/${target.id}/pay`, { method: 'POST', token: customer.token });
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('INSTALLMENT_NOT_PAYABLE');
    });

    it('an OVERDUE instalment can be paid too', async () => {
      const overdue = (await installments()).orders.find((o) => o.parentOrderId === creditOrder.parentOrderId)!.installments[1]!;
      expect(overdue.status).toBe('OVERDUE');
      const started = await request<{ paymentId: string }>(`/credit/installments/${overdue.id}/pay`, { method: 'POST', token: customer.token });
      expect(started.status).toBe(201);
      expect((await request<Outcome>(await decide(started.body.paymentId, 'PAY'))).body.outcome).toBe('PAID');
      await expectAccount(accountId, { total: 20_000_000, used: 17_850_000, reserved: 0, available: 2_150_000 });
      const overview = await installments();
      const first = overview.orders.find((o) => o.parentOrderId === creditOrder.parentOrderId)!;
      expect(first).toMatchObject({ paidCount: 2, overdueCount: 0, paidAmount: '2343500.00', remainingAmount: '4687000.00' });
    });
  });

  // ─── 6. cancellation releases credit ───────────────────────────────────────

  describe('unpaid order closure', () => {
    it('cancelling an order with a HYBRID attempt in flight releases the reservation; a late capture is flagged and never re-uses credit', async () => {
      const order = await placeOrder(1);
      const started = await creditInitiate(order.parentOrderId, plans[3].id, 'HYBRID');
      expect(started.status).toBe(201);
      expect(started.body).toMatchObject({ creditAmount: '2150000.00', cashAmount: '1300000.00' });
      await expectAccount(accountId, { total: 20_000_000, used: 17_850_000, reserved: 2_150_000, available: 0 });

      const cancelled = await request(`/customer/orders/${order.parentOrderId}/cancel`, { method: 'POST', token: customer.token, body: {} });
      expect(cancelled.status).toBe(200);
      await expectAccount(accountId, { total: 20_000_000, used: 17_850_000, reserved: 0, available: 2_150_000 });
      const payment = await prisma.payment.findUniqueOrThrow({ where: { id: started.body.paymentId } });
      expect(await sandboxReservation(payment.creditReservationRef!)).toBe('RELEASED');

      const late = await request<Outcome>(await decide(started.body.paymentId, 'PAY'));
      expect(late.body).toMatchObject({ outcome: 'PAID_REQUIRES_REFUND', orderPaymentStatus: 'CANCELLED' });
      await expectAccount(accountId, { total: 20_000_000, used: 17_850_000, reserved: 0, available: 2_150_000 });
      expect(await prisma.installmentSchedule.count({ where: { parentOrderId: order.parentOrderId } })).toBe(0);
    });
  });

  // ─── 7. staff views ────────────────────────────────────────────────────────

  describe('staff credit views', () => {
    it('are restricted to finance staff and admins', async () => {
      for (const path of ['/admin/credit/applications', '/admin/credit/accounts']) {
        expect((await request(path)).status).toBe(401);
        expect((await request(path, { token: supportToken })).status).toBe(403);
        expect((await request(path, { token: customer.token })).status).toBe(403);
        expect((await request(path, { token: adminToken })).status).toBe(200);
      }
    });

    it('lists applications with masked national codes and filters', async () => {
      const mine = await request<Page<Application & { user: { id: string; nationalCodeMasked: string | null } }>>(`/admin/credit/applications?userId=${customer.userId}`, { token: financeToken });
      expect(mine.status).toBe(200);
      expect(mine.body.total).toBe(1);
      expect(mine.body.items[0]).toMatchObject({ id: application.id, status: 'APPROVED', user: { id: customer.userId, nationalCodeMasked: `******${codes.approved.slice(-4)}` } });
      expect(mine.body.items[0]!.account).toMatchObject({ id: accountId });
      expect(JSON.stringify(mine.body)).not.toContain(codes.approved);
      const rejected = await request<Page<Application>>(`/admin/credit/applications?status=REJECTED&userId=${customer2.userId}`, { token: financeToken });
      expect(rejected.body.items.map((row) => row.decisionReason)).toEqual(['SCORE_BELOW_THRESHOLD']);
      expect((await request('/admin/credit/applications?status=NOPE', { token: financeToken })).status).toBe(400);
    });

    it('lists accounts with the aggregated exposure and a consistent ledger', async () => {
      const scoped = await request<Page<Account> & { exposure: Record<string, unknown> }>(`/admin/credit/accounts?userId=${customer.userId}`, { token: financeToken });
      expect(scoped.status).toBe(200);
      expect(scoped.body.items.map((row) => row.id)).toEqual([accountId]);
      expect(scoped.body.exposure).toMatchObject({
        accounts: 1,
        totalLimit: '20000000.00',
        used: '17850000.00',
        reserved: '0.00',
        available: '2150000.00',
        outstandingInstallments: '18237000.00', // order 1: 4 × 1,171,750 = 4,687,000; order 2: 13,550,000
        overdueInstallments: 0,
        ledgerConsistent: true,
        inconsistentAccounts: 0,
      });

      const all = await request<Page<Account> & { exposure: { accounts: number; totalLimit: string; used: string; ledgerConsistent: boolean } }>('/admin/credit/accounts', { token: financeToken });
      const totals = await prisma.creditAccount.aggregate({ _count: { _all: true }, _sum: { totalLimit: true, usedAmount: true } });
      expect(all.body.exposure.accounts).toBe(totals._count._all);
      expect(all.body.exposure.totalLimit).toBe(d(totals._sum.totalLimit ?? 0).toFixed(2));
      expect(all.body.exposure.used).toBe(d(totals._sum.usedAmount ?? 0).toFixed(2));
      expect(all.body.exposure.ledgerConsistent).toBe(true);
    });

    it('the financial overview separates card money, credit-funded sales and instalment collections', async () => {
      const response = await request<{ sales: { collectedByGateway: string; fundedByCredit: string; installmentsCollected: string } }>('/admin/financial/overview', { token: financeToken });
      expect(response.status).toBe(200);
      const sum = async (purpose: 'ORDER_CHECKOUT' | 'INSTALLMENT_REPAYMENT'): Promise<{ cash: string; credit: string }> => {
        const agg = await prisma.payment.aggregate({ where: { status: 'SUCCESSFUL', purpose }, _sum: { cashAmount: true, creditAmount: true } });
        return { cash: d(agg._sum.cashAmount ?? 0).toFixed(2), credit: d(agg._sum.creditAmount ?? 0).toFixed(2) };
      };
      const checkout = await sum('ORDER_CHECKOUT');
      const repayment = await sum('INSTALLMENT_REPAYMENT');
      expect(response.body.sales).toMatchObject({ collectedByGateway: checkout.cash, fundedByCredit: checkout.credit, installmentsCollected: repayment.cash });
      expect(d(response.body.sales.installmentsCollected).greaterThanOrEqualTo(2_343_500)).toBe(true);
    });
  });

  // ─── 8. invariant across everything ────────────────────────────────────────

  describe('credit invariant', () => {
    it('holds for every account touched by the suite and equals the replay of its ledger', async () => {
      const accounts = await prisma.creditAccount.findMany({ where: { user: { mobile: { in: SUITE_MOBILES } } }, select: { id: true } });
      expect(accounts).toHaveLength(2);
      for (const { id } of accounts) {
        const row = await prisma.creditAccount.findUniqueOrThrow({ where: { id } });
        await expectAccount(id, { total: row.totalLimit.toNumber(), used: row.usedAmount.toNumber(), reserved: row.reservedAmount.toNumber(), available: row.availableAmount.toNumber() });
      }
      // the database CHECK constraint refuses a write that would break it
      await expect(prisma.creditAccount.update({ where: { id: accountId }, data: { availableAmount: { increment: 1 } } })).rejects.toThrow();
    });
  });

  // ─── 9. contract ───────────────────────────────────────────────────────────

  describe('OpenAPI contract', () => {
    it('documents every Phase 8 route under its tag', () => {
      const document = buildOpenApiDocument(app) as unknown as { paths: Record<string, Record<string, { tags?: string[]; responses: Record<string, unknown> }>>; tags: Array<{ name: string }> };
      const expected: Array<[string, string, string]> = [
        ['/api/v1/credit/applications', 'post', 'credit'],
        ['/api/v1/credit/account', 'get', 'credit'],
        ['/api/v1/credit/plans', 'get', 'credit'],
        ['/api/v1/payments/credit/initiate', 'post', 'credit-payments'],
        ['/api/v1/credit/installments', 'get', 'credit-installments'],
        ['/api/v1/credit/installments/{id}/pay', 'post', 'credit-installments'],
        ['/api/v1/admin/credit/applications', 'get', 'admin-credit'],
        ['/api/v1/admin/credit/accounts', 'get', 'admin-credit'],
      ];
      for (const [path, method, tag] of expected) {
        const operation = document.paths[path]?.[method];
        expect({ path, method, documented: operation !== undefined }).toEqual({ path, method, documented: true });
        expect(operation!.tags).toContain(tag);
        expect(Object.keys(operation!.responses).length).toBeGreaterThanOrEqual(2);
      }
      const tags = document.tags.map((tag) => tag.name);
      for (const tag of ['credit', 'credit-payments', 'credit-installments', 'admin-credit']) expect(tags).toContain(tag);
    });
  });
});
