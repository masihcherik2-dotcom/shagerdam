/**
 * Deterministic master-data seed.
 *
 * Run with:  pnpm db:seed      (turbo → @shopino/backend → prisma/seed.ts)
 * Reset:     pnpm db:reset     (drops the schema, re-applies migrations, re-seeds)
 *
 * Purpose: after a development volume is wiped, or on a brand-new environment,
 * one command restores the data the platform cannot operate without — staff
 * accounts, a verified vendor with a real catalogue, the category tree with its
 * commission rates, the credit provider portfolio and the system configuration.
 *
 * Properties, by design:
 *   • Deterministic    — the same input always produces the same rows; every
 *                        entity is addressed by a stable natural key
 *                        (mobile / slug / sku / provider code / config key).
 *   • Idempotent       — running it any number of times leaves the same state;
 *                        safe to execute on every deploy.
 *   • Non-destructive  — existing rows are corrected, never deleted, and user
 *                        passwords are never rotated unless the corresponding
 *                        SEED_RESET_*_PASSWORD flag is set explicitly.
 *   • No fabricated financial data — no wallet balance, no credit line, no order
 *                        and no payment is invented here. Those rows are created
 *                        by the real business flows (checkout, settlement,
 *                        credit decision) and by nothing else.
 *
 * Credentials come from the environment; no secret is hard-coded. Passwords are
 * hashed with Argon2id before they reach the database.
 *
 * Profiles (SEED_PROFILE, default: `production` when NODE_ENV=production, else
 * `development`):
 *   • development — everything above: fixed staff accounts, the sample vendor
 *                   and its catalogue; seeded rows are corrected on every run.
 *   • production  — master data only: the super admin (identity from
 *                   SUPER_ADMIN_MOBILE / SUPER_ADMIN_EMAIL / SUPER_ADMIN_FULL_NAME),
 *                   optional support/finance accounts (SEED_SUPPORT_* /
 *                   SEED_FINANCE_*), the category tree, the credit portfolio and
 *                   the system configuration. No sample vendor, product or
 *                   document. Categories, providers, plans and configs are
 *                   create-only: values an operator changed are never
 *                   overwritten by a later deploy. Credit starts disabled
 *                   (`credit.enabled=false`, no active provider) until a real
 *                   bank integration is configured.
 */
import { ConfigValueType, PrismaClient, UserRole, VendorStatus, type CreditProvider } from '@prisma/client';
import type { PrismaClient as PrismaClientInstance } from '@prisma/client';
import { hashPassword } from '../src/infra/security/password';

// ─── Seed inputs ─────────────────────────────────────────────────────────────

export type SeedProfile = 'development' | 'production';

export interface SeedSummary {
  profile: SeedProfile;
  users: { created: string[]; updated: number };
  categories: { upserted: number; roots: number };
  /** Null in the production profile, which seeds no sample vendor. */
  vendor: { slug: string; created: boolean; products: number; variants: number } | null;
  credit: { providers: number; plans: number };
  configs: number;
}

interface SeedUser {
  /**
   * Stable natural key — unique in the database.
   *
   * Stored in canonical E.164 (`+989XXXXXXXXX`) because that is the single format
   * the authentication layer reads and writes: the login flow normalizes every
   * input to it, and the unique index on `users.mobile` would not catch a number
   * registered under two different spellings. `09…` is presentation only.
   */
  mobile: string;
  email: string;
  fullName: string;
  role: UserRole;
  /** Environment variable holding the password; absent for non-login accounts. */
  passwordEnv?: string;
  resetPasswordEnv?: string;
}

const STAFF_USERS: readonly SeedUser[] = [
  {
    mobile: '+989120000001',
    email: 'admin@shopino.local',
    fullName: 'مدیر ارشد پلتفرم',
    role: UserRole.SUPER_ADMIN,
    passwordEnv: 'SUPER_ADMIN_PASSWORD',
    resetPasswordEnv: 'SEED_RESET_ADMIN_PASSWORD',
  },
  {
    mobile: '+989120000002',
    email: 'support@shopino.local',
    fullName: 'کارشناس پشتیبانی',
    role: UserRole.SUPPORT,
    passwordEnv: 'SEED_STAFF_PASSWORD',
  },
  {
    mobile: '+989120000003',
    email: 'finance@shopino.local',
    fullName: 'کارشناس مالی',
    role: UserRole.FINANCIAL_OFFICER,
    passwordEnv: 'SEED_STAFF_PASSWORD',
  },
];

/** Owner account of the sample vendor shop. */
const VENDOR_OWNER: SeedUser = {
  mobile: '+989120000010',
  email: 'vendor@shopino.local',
  fullName: 'مدیر فروشگاه نمونه',
  role: UserRole.VENDOR,
  passwordEnv: 'SEED_VENDOR_PASSWORD',
};

interface CategorySeed {
  slug: string;
  titleFa: string;
  titleEn: string;
  /** Platform commission for products in this category, in percent. */
  defaultCommissionRate: string;
  sortOrder: number;
  children: Omit<CategorySeed, 'children'>[];
}

/**
 * Baseline taxonomy and the commission the platform charges per category: the
 * four root departments of the storefront (commission rates set by the
 * architect). Categories of earlier taxonomies are deactivated by the
 * `20261010090000_storefront_root_categories` migration.
 */
export const CATEGORY_TREE: readonly CategorySeed[] = [
  {
    slug: 'digital-goods',
    titleFa: 'کالای دیجیتال',
    titleEn: 'Digital Goods',
    defaultCommissionRate: '5.00',
    sortOrder: 10,
    children: [],
  },
  {
    slug: 'home-decor',
    titleFa: 'دکوراسیون',
    titleEn: 'Home Decor',
    defaultCommissionRate: '9.00',
    sortOrder: 20,
    children: [],
  },
  {
    slug: 'beauty-products',
    titleFa: 'محصولات زیبایی',
    titleEn: 'Beauty Products',
    defaultCommissionRate: '11.00',
    sortOrder: 30,
    children: [],
  },
  {
    slug: 'barber-salon-equipment',
    titleFa: 'محصولات و تجهیزات آرایشگاهی',
    titleEn: 'Barber & Salon Equipment',
    defaultCommissionRate: '9.00',
    sortOrder: 40,
    children: [],
  },
];

interface VariantSeed {
  sku: string;
  colorName?: string;
  colorHex?: string;
  size?: string;
  guarantee?: string;
  price: string;
  compareAtPrice?: string;
  stockQuantity: number;
  weightGrams?: number;
}

interface MediaSeed {
  url: string;
  thumbnailUrl?: string;
  isPrimary: boolean;
  sortOrder: number;
}

interface ProductSeed {
  slug: string;
  title: string;
  description: string;
  brand: string;
  basePrice: string;
  categorySlug: string;
  isPublished: boolean;
  media: MediaSeed[];
  variants: VariantSeed[];
}

/**
 * Catalogue of the sample vendor. Prices are the real catalogue values the shop
 * sells at — the seed does not invent promotional numbers, and no stock figure
 * here is a placeholder for a database-backed counter.
 */
const VENDOR_PRODUCTS: readonly ProductSeed[] = [
  {
    slug: 'shopino-sample-smartphone-x1',
    title: 'گوشی موبایل نمونه X1',
    description: 'گوشی هوشمند با نمایشگر ۶.۷ اینچی، حافظهٔ ۲۵۶ گیگابایت و دوربین سه‌گانه.',
    brand: 'Shagerdam Sample',
    basePrice: '42500000.00',
    categorySlug: 'digital-goods',
    isPublished: true,
    media: [
      { url: 'https://cdn.shopino.local/products/sample-smartphone-x1/front.jpg', thumbnailUrl: 'https://cdn.shopino.local/products/sample-smartphone-x1/front-thumb.jpg', isPrimary: true, sortOrder: 10 },
      { url: 'https://cdn.shopino.local/products/sample-smartphone-x1/back.jpg', thumbnailUrl: 'https://cdn.shopino.local/products/sample-smartphone-x1/back-thumb.jpg', isPrimary: false, sortOrder: 20 },
    ],
    variants: [
      { sku: 'SHP-X1-256-BLK', colorName: 'مشکی', colorHex: '#111827', guarantee: '۱۸ ماه گارانتی شرکتی', price: '42500000.00', compareAtPrice: '45000000.00', stockQuantity: 12, weightGrams: 202 },
      { sku: 'SHP-X1-256-BLU', colorName: 'آبی', colorHex: '#1D4ED8', guarantee: '۱۸ ماه گارانتی شرکتی', price: '42900000.00', compareAtPrice: '45000000.00', stockQuantity: 7, weightGrams: 202 },
    ],
  },
  {
    slug: 'shopino-sample-laptop-pro14',
    title: 'لپ‌تاپ نمونه پرو ۱۴ اینچ',
    description: 'لپ‌تاپ ۱۴ اینچی با پردازندهٔ نسل جدید، ۱۶ گیگابایت رم و حافظهٔ SSD یک ترابایتی.',
    brand: 'Shagerdam Sample',
    basePrice: '78900000.00',
    categorySlug: 'digital-goods',
    isPublished: true,
    media: [
      { url: 'https://cdn.shopino.local/products/sample-laptop-pro14/main.jpg', thumbnailUrl: 'https://cdn.shopino.local/products/sample-laptop-pro14/main-thumb.jpg', isPrimary: true, sortOrder: 10 },
    ],
    variants: [
      { sku: 'SHP-PRO14-16-1T-SLV', colorName: 'نقره‌ای', colorHex: '#D1D5DB', guarantee: '۲۴ ماه گارانتی بین‌المللی', price: '78900000.00', stockQuantity: 5, weightGrams: 1450 },
      { sku: 'SHP-PRO14-16-1T-GRY', colorName: 'خاکستری', colorHex: '#4B5563', guarantee: '۲۴ ماه گارانتی بین‌المللی', price: '79900000.00', stockQuantity: 3, weightGrams: 1450 },
    ],
  },
  {
    slug: 'shopino-sample-velvet-cushion',
    title: 'کوسن دکوراتیو مخمل نمونه',
    description: 'کوسن مخمل با پرکنندهٔ الیاف میکرو و روکش جداشونده با زیپ مخفی، مناسب مبل و تخت.',
    brand: 'Shagerdam Sample',
    basePrice: '1450000.00',
    categorySlug: 'home-decor',
    isPublished: true,
    media: [
      { url: 'https://cdn.shopino.local/products/sample-velvet-cushion/green.jpg', thumbnailUrl: 'https://cdn.shopino.local/products/sample-velvet-cushion/green-thumb.jpg', isPrimary: true, sortOrder: 10 },
    ],
    variants: [
      { sku: 'SHP-CUSHION-GRN-45', colorName: 'سبز یشمی', colorHex: '#047857', size: '45×45', price: '1450000.00', compareAtPrice: '1690000.00', stockQuantity: 30, weightGrams: 520 },
      { sku: 'SHP-CUSHION-GRN-50', colorName: 'سبز یشمی', colorHex: '#047857', size: '50×50', price: '1690000.00', stockQuantity: 18, weightGrams: 640 },
      { sku: 'SHP-CUSHION-BEG-45', colorName: 'کرم', colorHex: '#E7DCC8', size: '45×45', price: '1450000.00', stockQuantity: 22, weightGrams: 520 },
    ],
  },
];

const SAMPLE_VENDOR = {
  storeSlug: 'shopino-sample-store',
  storeName: 'فروشگاه نمونه شاگردم',
  instagramHandle: 'shopino.sample',
  bio: 'فروشگاه نمونهٔ پلتفرم با کاتالوگ واقعی برای توسعه و تست جریان‌های خرید.',
  bankIban: 'IR620170000000000000000001',
};

interface CreditProviderSeed {
  code: string;
  name: string;
  isActive: boolean;
  config: Record<string, string>;
  plans: { durationMonths: number; title: string; interestRatePercent: string; penaltyRatePercentPerMonth: string }[];
}

/**
 * Credit portfolio. Only the sandbox provider is active in development; the real
 * banks are seeded as inactive so that switching provider is a configuration
 * change (`credits.activeProvider` / provider row) rather than a code change.
 */
const CREDIT_PROVIDERS: readonly CreditProviderSeed[] = [
  {
    code: 'SANDBOX_BANK',
    name: 'بانک آزمایشی (Sandbox)',
    isActive: true,
    config: {
      environment: 'sandbox',
      baseUrl: 'https://sandbox.credit.local/api/v1',
      merchantId: 'shopino-sandbox-merchant',
      // Simulation rules of the development-only SandboxBankProvider (Phase 8):
      // approve when the simulated score (derived from the national code) is at
      // least minApprovalScore and the requested limit is at least
      // minRequestedLimit; the approved limit is capped at maxApprovedLimit.
      // Whole rials. Not business data of any real bank.
      minApprovalScore: '600',
      minRequestedLimit: '10000000',
      maxApprovedLimit: '500000000',
    },
    plans: [
      { durationMonths: 3, title: 'خرید اعتباری ۳ ماهه (بدون سود)', interestRatePercent: '0.00', penaltyRatePercentPerMonth: '2.00' },
      { durationMonths: 6, title: 'خرید اعتباری ۶ ماهه', interestRatePercent: '9.00', penaltyRatePercentPerMonth: '2.00' },
      { durationMonths: 12, title: 'خرید اعتباری ۱۲ ماهه', interestRatePercent: '18.00', penaltyRatePercentPerMonth: '2.50' },
    ],
  },
  {
    code: 'SAMAN_BANK',
    name: 'بانک سامان',
    isActive: false,
    config: { environment: 'production', baseUrl: '', merchantId: '' },
    plans: [],
  },
  {
    code: 'BLUBANK',
    name: 'بلوبانک',
    isActive: false,
    config: { environment: 'production', baseUrl: '', merchantId: '' },
    plans: [],
  },
  {
    code: 'DIGIPAY',
    name: 'دیجی‌پی',
    isActive: false,
    config: { environment: 'production', baseUrl: '', merchantId: '' },
    plans: [],
  },
];

interface ConfigSeed {
  key: string;
  value: string;
  valueType: ConfigValueType;
  description: string;
}

/**
 * Baseline platform configuration. The BNPL flow exists since Phase 8, so
 * `credit.enabled` is true; `credits.activeProvider` names the sandbox
 * explicitly so the active (development-only) provider is always visible in
 * configuration. Production must point it at a real bank integration.
 */
const SYSTEM_CONFIGS: readonly ConfigSeed[] = [
  { key: 'platform.name', value: 'شاگردم', valueType: ConfigValueType.STRING, description: 'نام نمایشی پلتفرم' },
  { key: 'platform.currency', value: 'IRR', valueType: ConfigValueType.STRING, description: 'کد ارز پایه پلتفرم (ISO 4217)' },
  { key: 'platform.locale', value: 'fa-IR', valueType: ConfigValueType.STRING, description: 'زبان و قالب پیش‌فرض رابط کاربری' },
  { key: 'platform.timezone', value: 'Asia/Tehran', valueType: ConfigValueType.STRING, description: 'منطقهٔ زمانی مرجع برای گزارش‌ها و تسویه' },
  { key: 'credit.enabled', value: 'true', valueType: ConfigValueType.BOOLEAN, description: 'فعال بودن خرید اعتباری (BNPL). با false هیچ درخواست اعتبار یا خرید اعتباری جدیدی پذیرفته نمی‌شود.' },
  { key: 'credits.activeProvider', value: 'SANDBOX_BANK', valueType: ConfigValueType.STRING, description: 'کد ارائه‌دهندهٔ اعتبار فعال در محیط جاری' },
  { key: 'commerce.defaultCommissionRate', value: '12.00', valueType: ConfigValueType.NUMBER, description: 'نرخ کمیسیون پیش‌فرض پلتفرم (درصد) وقتی دسته‌بندی نرخ اختصاصی ندارد' },
  { key: 'commerce.escrowHoldDays', value: '7', valueType: ConfigValueType.NUMBER, description: 'مدت نگه‌داری وجه در حساب امانی پس از تحویل (روز)' },
  { key: 'commerce.settlementMinimumAmount', value: '5000000.00', valueType: ConfigValueType.NUMBER, description: 'حداقل مبلغ قابل درخواست تسویه (ریال)' },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(
      `${name} is not set. Add it to the root .env (see .env.example) — the seed is not allowed to invent credentials.`,
    );
  }
  return value;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function parseBooleanFlag(name: string): boolean {
  return (process.env[name] ?? '').trim().toLowerCase() === 'true';
}

/** SEED_PROFILE, defaulting to `production` under NODE_ENV=production. */
export function resolveSeedProfile(env: NodeJS.ProcessEnv = process.env): SeedProfile {
  const raw = (env.SEED_PROFILE ?? '').trim().toLowerCase();
  if (raw === '') {
    return env.NODE_ENV === 'production' ? 'production' : 'development';
  }
  if (raw === 'development' || raw === 'production') {
    return raw;
  }
  throw new Error(`SEED_PROFILE must be "development", "production" or "demo" (got "${raw}").`);
}

/** Iranian mobile in E.164 (+989XXXXXXXXX); accepts 09XXXXXXXXX as well. */
export function normalizeIranMobile(name: string, value: string): string {
  const digits = value.trim().replace(/[\s-]/g, '');
  const normalized = digits.startsWith('+98') ? digits : digits.startsWith('0098') ? `+${digits.slice(2)}` : digits.startsWith('0') ? `+98${digits.slice(1)}` : digits;
  if (!/^\+989\d{9}$/.test(normalized)) {
    throw new Error(`${name} must be an Iranian mobile number such as 09121234567 (got "${value}").`);
  }
  return normalized;
}

/** An optional staff account: all of its variables or none of them. */
function optionalStaff(prefix: 'SEED_SUPPORT' | 'SEED_FINANCE', role: UserRole, env: NodeJS.ProcessEnv): SeedUser | null {
  const mobile = env[`${prefix}_MOBILE`]?.trim() ?? '';
  const email = env[`${prefix}_EMAIL`]?.trim() ?? '';
  const fullName = env[`${prefix}_FULL_NAME`]?.trim() ?? '';
  if (mobile === '' && email === '' && fullName === '') {
    return null;
  }
  if (mobile === '' || email === '' || fullName === '') {
    throw new Error(`${prefix}_MOBILE, ${prefix}_EMAIL and ${prefix}_FULL_NAME must be set together (or all left empty).`);
  }
  return { mobile: normalizeIranMobile(`${prefix}_MOBILE`, mobile), email, fullName, role, passwordEnv: 'SEED_STAFF_PASSWORD' };
}

/** Accounts of the production profile: the super admin plus optional support/finance staff, all from the environment. */
export function productionStaffUsers(env: NodeJS.ProcessEnv = process.env): SeedUser[] {
  const admin: SeedUser = {
    mobile: normalizeIranMobile('SUPER_ADMIN_MOBILE', requireEnv('SUPER_ADMIN_MOBILE')),
    email: requireEnv('SUPER_ADMIN_EMAIL').trim(),
    fullName: requireEnv('SUPER_ADMIN_FULL_NAME').trim(),
    role: UserRole.SUPER_ADMIN,
    passwordEnv: 'SUPER_ADMIN_PASSWORD',
    resetPasswordEnv: 'SEED_RESET_ADMIN_PASSWORD',
  };
  return [admin, optionalStaff('SEED_SUPPORT', UserRole.SUPPORT, env), optionalStaff('SEED_FINANCE', UserRole.FINANCIAL_OFFICER, env)].filter(
    (user): user is SeedUser => user !== null,
  );
}

/**
 * Production starting values that differ from development: credit is off and no
 * provider is active until a real bank integration exists (SANDBOX_BANK is also
 * refused by the API in production).
 */
const PRODUCTION_CONFIG_VALUES: Readonly<Record<string, string>> = {
  'credit.enabled': 'false',
  'credits.activeProvider': '',
};

// ─── Seed sections ───────────────────────────────────────────────────────────

async function seedUsers(
  prisma: PrismaClientInstance,
  users: readonly SeedUser[],
): Promise<{ created: string[]; updated: number }> {
  const created: string[] = [];
  let updated = 0;

  for (const user of users) {
    const email = normalizeEmail(user.email);
    const existing = await prisma.user.findUnique({ where: { mobile: user.mobile } });
    const passwordHash =
      user.passwordEnv === undefined
        ? undefined
        : await hashPassword(requireEnv(user.passwordEnv));
    const resetPassword =
      user.resetPasswordEnv !== undefined && parseBooleanFlag(user.resetPasswordEnv);

    if (existing === null) {
      if (passwordHash === undefined) {
        throw new Error(`${email} has no password source configured; refusing to create a login account without one.`);
      }
      await prisma.user.create({
        data: {
          mobile: user.mobile,
          email,
          fullName: user.fullName,
          role: user.role,
          passwordHash,
          isActive: true,
        },
      });
      created.push(email);
      continue;
    }

    // Repair identity drift (name/role/email) without touching the credential.
    await prisma.user.update({
      where: { mobile: user.mobile },
      data: {
        email,
        fullName: user.fullName,
        role: user.role,
        isActive: true,
        ...(resetPassword && passwordHash !== undefined ? { passwordHash } : {}),
      },
    });
    updated += 1;
  }

  return { created, updated };
}

async function seedCategories(prisma: PrismaClientInstance, createOnly: boolean): Promise<{ upserted: number; roots: number }> {
  let upserted = 0;

  for (const root of CATEGORY_TREE) {
    const parent = await prisma.category.upsert({
      where: { slug: root.slug },
      update: createOnly ? {} : {
        titleFa: root.titleFa,
        titleEn: root.titleEn,
        defaultCommissionRate: root.defaultCommissionRate,
        sortOrder: root.sortOrder,
        isActive: true,
      },
      create: {
        slug: root.slug,
        titleFa: root.titleFa,
        titleEn: root.titleEn,
        defaultCommissionRate: root.defaultCommissionRate,
        sortOrder: root.sortOrder,
        isActive: true,
      },
    });
    upserted += 1;

    for (const child of root.children) {
      await prisma.category.upsert({
        where: { slug: child.slug },
        update: createOnly ? {} : {
          titleFa: child.titleFa,
          titleEn: child.titleEn,
          defaultCommissionRate: child.defaultCommissionRate,
          sortOrder: child.sortOrder,
          parentId: parent.id,
          isActive: true,
        },
        create: {
          slug: child.slug,
          titleFa: child.titleFa,
          titleEn: child.titleEn,
          defaultCommissionRate: child.defaultCommissionRate,
          sortOrder: child.sortOrder,
          parentId: parent.id,
          isActive: true,
        },
      });
      upserted += 1;
    }
  }

  return { upserted, roots: CATEGORY_TREE.length };
}

async function seedVendor(
  prisma: PrismaClientInstance,
): Promise<{ slug: string; created: boolean; products: number; variants: number }> {
  const owner = await prisma.user.findUniqueOrThrow({ where: { mobile: VENDOR_OWNER.mobile } });

  const existingVendor = await prisma.vendor.findUnique({ where: { storeSlug: SAMPLE_VENDOR.storeSlug } });

  const vendor = await prisma.vendor.upsert({
    where: { storeSlug: SAMPLE_VENDOR.storeSlug },
    update: {
      storeName: SAMPLE_VENDOR.storeName,
      instagramHandle: SAMPLE_VENDOR.instagramHandle,
      bio: SAMPLE_VENDOR.bio,
      bankIban: SAMPLE_VENDOR.bankIban,
      status: VendorStatus.APPROVED,
    },
    create: {
      userId: owner.id,
      storeName: SAMPLE_VENDOR.storeName,
      storeSlug: SAMPLE_VENDOR.storeSlug,
      instagramHandle: SAMPLE_VENDOR.instagramHandle,
      bio: SAMPLE_VENDOR.bio,
      bankIban: SAMPLE_VENDOR.bankIban,
      status: VendorStatus.APPROVED,
      verifiedAt: new Date('2026-01-05T09:00:00.000Z'),
    },
  });

  // A wallet is created when the vendor is approved; balances stay at zero until
  // real sales move them (the seed never fabricates a balance).
  await prisma.vendorWallet.upsert({
    where: { vendorId: vendor.id },
    update: {},
    create: { vendorId: vendor.id },
  });

  // Verification dossier of the approved vendor, keyed by its national card file.
  const nationalCardDocUrl = 'https://cdn.shopino.local/vendor-docs/sample/national-card.jpg';
  const existingVerification = await prisma.vendorVerification.findFirst({
    where: { vendorId: vendor.id, nationalCardDocUrl },
  });
  if (existingVerification === null) {
    await prisma.vendorVerification.create({
      data: {
        vendorId: vendor.id,
        nationalCardDocUrl,
        businessDocUrl: 'https://cdn.shopino.local/vendor-docs/sample/business-license.jpg',
        reviewedAt: new Date('2026-01-05T09:00:00.000Z'),
      },
    });
  }

  let products = 0;
  let variants = 0;

  for (const product of VENDOR_PRODUCTS) {
    const category = await prisma.category.findUniqueOrThrow({ where: { slug: product.categorySlug } });

    const row = await prisma.product.upsert({
      where: { slug: product.slug },
      update: {
        title: product.title,
        description: product.description,
        brand: product.brand,
        basePrice: product.basePrice,
        categoryId: category.id,
        vendorId: vendor.id,
        isPublished: product.isPublished,
      },
      create: {
        vendorId: vendor.id,
        categoryId: category.id,
        title: product.title,
        slug: product.slug,
        description: product.description,
        brand: product.brand,
        basePrice: product.basePrice,
        isPublished: product.isPublished,
      },
    });
    products += 1;

    for (const variant of product.variants) {
      await prisma.productVariant.upsert({
        where: { sku: variant.sku },
        update: {
          productId: row.id,
          colorName: variant.colorName ?? null,
          colorHex: variant.colorHex ?? null,
          size: variant.size ?? null,
          guarantee: variant.guarantee ?? null,
          price: variant.price,
          compareAtPrice: variant.compareAtPrice ?? null,
          stockQuantity: variant.stockQuantity,
          weightGrams: variant.weightGrams ?? null,
          isActive: true,
        },
        create: {
          productId: row.id,
          sku: variant.sku,
          colorName: variant.colorName ?? null,
          colorHex: variant.colorHex ?? null,
          size: variant.size ?? null,
          guarantee: variant.guarantee ?? null,
          price: variant.price,
          compareAtPrice: variant.compareAtPrice ?? null,
          stockQuantity: variant.stockQuantity,
          weightGrams: variant.weightGrams ?? null,
          isActive: true,
        },
      });
      variants += 1;
    }

    for (const media of product.media) {
      const existingMedia = await prisma.productMedia.findFirst({
        where: { productId: row.id, url: media.url },
      });
      if (existingMedia === null) {
        await prisma.productMedia.create({
          data: {
            productId: row.id,
            url: media.url,
            thumbnailUrl: media.thumbnailUrl ?? null,
            isPrimary: media.isPrimary,
            sortOrder: media.sortOrder,
          },
        });
      }
    }
  }

  return {
    slug: vendor.storeSlug,
    created: existingVendor === null,
    products,
    variants,
  };
}

async function seedCreditPortfolio(
  prisma: PrismaClientInstance,
  profile: SeedProfile,
): Promise<{ providers: number; plans: number }> {
  const createOnly = profile === 'production';
  let plans = 0;

  for (const provider of CREDIT_PROVIDERS) {
    // The sandbox is created inactive in production (the API refuses it there anyway).
    const isActive = profile === 'production' && provider.code === 'SANDBOX_BANK' ? false : provider.isActive;
    const row: CreditProvider = await prisma.creditProvider.upsert({
      where: { code: provider.code },
      update: createOnly ? {} : { name: provider.name, isActive, config: provider.config },
      create: { code: provider.code, name: provider.name, isActive, config: provider.config },
    });

    for (const plan of provider.plans) {
      await prisma.installmentPlan.upsert({
        where: { providerId_durationMonths: { providerId: row.id, durationMonths: plan.durationMonths } },
        update: createOnly ? {} : {
          title: plan.title,
          interestRatePercent: plan.interestRatePercent,
          penaltyRatePercentPerMonth: plan.penaltyRatePercentPerMonth,
          isActive: true,
        },
        create: {
          providerId: row.id,
          title: plan.title,
          durationMonths: plan.durationMonths,
          interestRatePercent: plan.interestRatePercent,
          penaltyRatePercentPerMonth: plan.penaltyRatePercentPerMonth,
          isActive: true,
        },
      });
      plans += 1;
    }
  }

  return { providers: CREDIT_PROVIDERS.length, plans };
}

async function seedSystemConfigs(prisma: PrismaClientInstance, profile: SeedProfile): Promise<number> {
  for (const config of SYSTEM_CONFIGS) {
    const value = profile === 'production' ? (PRODUCTION_CONFIG_VALUES[config.key] ?? config.value) : config.value;
    await prisma.systemConfig.upsert({
      where: { key: config.key },
      update: profile === 'production' ? {} : { value, valueType: config.valueType, description: config.description },
      create: {
        key: config.key,
        value,
        valueType: config.valueType,
        description: config.description,
      },
    });
  }
  return SYSTEM_CONFIGS.length;
}

/**
 * Seeds master data. Accepts a PrismaClient so tests and scripts can reuse the
 * exact same logic inside an existing connection or transaction scope.
 */
export async function seedDatabase(prisma: PrismaClientInstance, profile: SeedProfile = resolveSeedProfile()): Promise<SeedSummary> {
  const production = profile === 'production';
  const users = await seedUsers(prisma, production ? productionStaffUsers() : [...STAFF_USERS, VENDOR_OWNER]);
  const categories = await seedCategories(prisma, production);
  const vendor = production ? null : await seedVendor(prisma);
  const credit = await seedCreditPortfolio(prisma, profile);
  const configs = await seedSystemConfigs(prisma, profile);

  return { profile, users, categories, vendor, credit, configs };
}

/**
 * `SEED_PROFILE=demo`: the base seed of the environment (production under
 * NODE_ENV=production, else development) followed by the demo catalogue
 * (`prisma/demo/demo-catalog.ts` — hidden in production, live elsewhere).
 */
export function isDemoRequest(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.SEED_PROFILE ?? '').trim().toLowerCase() === 'demo';
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  const demo = isDemoRequest();
  try {
    const summary = await seedDatabase(prisma, demo ? resolveSeedProfile({ ...process.env, SEED_PROFILE: '' }) : resolveSeedProfile());
    console.warn(
      `[seed] master data ready (profile: ${summary.profile})\n` +
        `  users          : ${summary.users.created.length} created (${summary.users.created.join(', ') || '—'}), ${summary.users.updated} updated\n` +
        `  categories     : ${summary.categories.upserted} rows (${summary.categories.roots} roots) with commission rates\n` +
        (summary.vendor
          ? `  vendor         : ${summary.vendor.slug} (${summary.vendor.created ? 'created' : 'updated'}) — ${summary.vendor.products} products, ${summary.vendor.variants} variants\n`
          : `  vendor         : none (production profile seeds no sample data)\n`) +
        `  credit         : ${summary.credit.providers} providers, ${summary.credit.plans} installment plans\n` +
        `  system configs : ${summary.configs} keys`,
    );
  } finally {
    await prisma.$disconnect();
  }
  if (demo) {
    // Loaded lazily: it boots the Nest application context (media storage, services).
    const { loadDemoCatalog } = await import('./demo/demo-catalog');
    const result = await loadDemoCatalog();
    console.warn(
      `[seed] demo catalogue (${result.visibility}): stores ${result.storesCreated} created / ${result.storesExisting} existing, ` +
        `products ${result.productsCreated} created / ${result.productsExisting} existing, ${result.images} images stored`,
    );
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(`[seed] FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
