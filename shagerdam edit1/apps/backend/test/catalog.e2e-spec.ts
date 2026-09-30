import { ConfigService } from '@nestjs/config';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { AuditAction, PaymentMethod, SubOrderStatus, VendorStatus } from '@prisma/client';
import sharp from 'sharp';
import { AppModule } from '../src/app.module';
import { GLOBAL_API_PREFIX } from '../src/common/constants';
import { PrismaService } from '../src/infra/prisma/prisma.service';
import { RedisService } from '../src/infra/redis/redis.service';
import { normalizeIdentifier } from '../src/modules/auth/auth.service';
import { OtpKeys } from '../src/modules/auth/otp.service';
import { loginAttemptsKey, loginLockKey } from '../src/modules/auth/token.service';
import { CategoriesService } from '../src/modules/categories/categories.service';
import { InventoryService } from '../src/modules/products/inventory.service';
import { SMS_PROVIDER } from '../src/modules/sms/sms-provider.interface';
import type { SmsProvider } from '../src/modules/sms/sms-provider.interface';
import type { SandboxSmsProvider } from '../src/modules/sms/providers/sandbox-sms.provider';
import { STORAGE_PROVIDER, type StorageProvider } from '../src/modules/storage/storage-provider.interface';
import { applyGlobalPolicies, buildOpenApiDocument } from '../src/setup/app.setup';

/**
 * End-to-end verification of the Phase-5 catalogue against the real stack:
 * PostgreSQL 16 (pg_trgm, CHECK constraints, row locks), Redis 7 (category tree
 * cache, auth state), the real media pipeline and the real auth flow.
 *
 * Vendors are onboarded the way production onboards them — OTP sign-in, store
 * registration, staff approval over the admin API — and product images are real
 * uploads. Sold units for the "popular" sort are genuine order rows. Every row,
 * file and audit entry the suite creates is removed in `afterAll`; every name,
 * slug and SKU carries a per-run tag so the seeded catalogue never interferes.
 */

const TEST_UA = 'shopino-catalog-e2e/1.0';
const RUN = Date.now().toString(36);
/** SKUs are stored upper-cased; fixtures refer to them through this tag. */
const TAG = RUN.toUpperCase();

const VENDOR_A_MOBILE = '+989971130001';
const VENDOR_B_MOBILE = '+989971130002';
const PENDING_VENDOR_MOBILE = '+989971130003';
const CUSTOMER_MOBILE = '+989971130004';
const SUITE_MOBILES = [VENDOR_A_MOBILE, VENDOR_B_MOBILE, PENDING_VENDOR_MOBILE, CUSTOMER_MOBILE];

/** Checksum-valid Iranian IBANs (MOD 97-10 verified). */
const IBANS = ['IR820540102680020817909002', 'IR570629600000001003242001', 'IR550540102680020817909003'];

const SEEDED_ADMIN_EMAIL = 'admin@shopino.local';
const SEEDED_SUPPORT_EMAIL = 'support@shopino.local';

const ORDER_PREFIX = `E5${RUN}`.slice(0, 12).toUpperCase();

interface HttpResult<T> {
  status: number;
  body: T;
}

interface Category {
  id: string;
  slug: string;
  titleFa: string;
  titleEn: string | null;
  parentId: string | null;
  defaultCommissionRate: string;
  isActive: boolean;
  auditLogId?: string;
}

interface TreeNode {
  id: string;
  slug: string;
  depth: number;
  productCount: number;
  totalProductCount: number;
  children: TreeNode[];
}

interface Variant {
  id: string;
  sku: string;
  colorName: string | null;
  colorHex: string | null;
  size: string | null;
  price: string;
  compareAtPrice: string | null;
  discountPercent: number | null;
  stockQuantity: number;
  reservedQuantity: number;
  availableQuantity: number;
  isActive: boolean;
}

interface VendorProduct {
  id: string;
  slug: string;
  title: string;
  isPublished: boolean;
  isSellable: boolean;
  moderation: { isBlockedByAdmin: boolean; blockedReason: string | null };
  category: { slug: string };
  priceRange: { min: string; max: string } | null;
  stock: { variantCount: number; activeVariantCount: number; totalStock: number; totalAvailable: number };
  media?: Array<{ id: string; mediaAssetId: string | null; isPrimary: boolean; sortOrder: number; url: string }>;
  variants?: Variant[];
}

interface ListItem {
  slug: string;
  priceRange: { min: string; max: string };
  colors: Array<{ name: string; hex: string | null }>;
  sizes: string[];
  inStock: boolean;
  primaryImage: { url: string; thumbnailUrl: string | null } | null;
  vendor: { storeSlug: string };
  category: { slug: string };
  maxDiscountPercent: number | null;
  startingCompareAtPrice: string | null;
}

interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

describe('Phase 5 — categories, product catalogue and discovery (live stack)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let storage: StorageProvider;
  let inventory: InventoryService;

  let adminToken: string;
  let supportToken: string;
  let vendorA: { token: string; userId: string; vendorId: string; storeSlug: string };
  let vendorB: { token: string; userId: string; vendorId: string; storeSlug: string };
  let pending: { token: string; userId: string };
  let customer: { token: string; userId: string };

  const cat: Record<'root' | 'cams' | 'mirrorless' | 'lenses', Category> = {} as never;
  const media: { a1: string; a2: string; a3: string; b1: string } = {} as never;
  const product: Record<'p1' | 'p2' | 'p3' | 'pb' | 'draft', VendorProduct> = {} as never;

  const API = `/${GLOBAL_API_PREFIX}`;

  const request = async <T>(
    url: string,
    options: { method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; token?: string; body?: unknown; form?: FormData } = {},
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
      url: `${API}${url}`,
      headers,
      ...(payload === undefined ? {} : { payload }),
    });
    return {
      status: response.statusCode,
      body: response.body.length > 0 ? (JSON.parse(response.body) as T) : (undefined as T),
    };
  };

  const search = (params: Record<string, string | number | boolean | string[]>): Promise<HttpResult<Page<ListItem>>> => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (Array.isArray(value)) value.forEach((entry) => query.append(key, entry));
      else query.append(key, String(value));
    }
    return request<Page<ListItem>>(`/products?${query.toString()}`);
  };

  const slugs = (result: HttpResult<Page<ListItem>>): string[] => result.body.items.map((item) => item.slug);

  const loginWithOtp = async (mobile: string): Promise<{ token: string; userId: string }> => {
    const requested = await request('/auth/otp/request', { method: 'POST', body: { mobile } });
    expect(requested.status).toBe(200);
    const code = (app.get<SmsProvider>(SMS_PROVIDER) as SandboxSmsProvider).latestOtpCode(mobile);
    expect(code).toBeDefined();
    const verified = await request<{ accessToken: string; user: { id: string } }>('/auth/otp/verify', {
      method: 'POST',
      body: { mobile, code },
    });
    expect(verified.status).toBe(200);
    return { token: verified.body.accessToken, userId: verified.body.user.id };
  };

  const loginWithPassword = async (identifier: string, password: string): Promise<string> => {
    const response = await request<{ accessToken: string }>('/auth/login/password', {
      method: 'POST',
      body: { identifier, password },
    });
    expect(response.status).toBe(200);
    return response.body.accessToken;
  };

  const registerStore = async (token: string, storeSlug: string, iban: string): Promise<string> => {
    const response = await request<{ id: string }>('/vendors/register', {
      method: 'POST',
      token,
      body: {
        storeName: `فروشگاه آزمون کاتالوگ ${storeSlug}`,
        storeSlug,
        bio: 'فروشگاه ساخته‌شده در آزمون کاتالوگ',
        bankIban: iban,
        bankAccountHolder: 'شرکت آزمون کاتالوگ',
      },
    });
    expect(response.status).toBe(201);
    return response.body.id;
  };

  /** Uploads a national-ID document and submits it, as Phase 4 requires before review. */
  const submitVerification = async (token: string): Promise<void> => {
    const form = new FormData();
    const pdf = Buffer.concat([Buffer.from(`%PDF-1.7\n% catalog e2e ${RUN}\n`, 'latin1'), Buffer.from('%%EOF', 'latin1')]);
    form.append('file', new Blob([new Uint8Array(pdf)], { type: 'application/pdf' }), 'national-id.pdf');
    form.append('purpose', 'kyc_national_id');
    const uploaded = await request<{ url: string }>('/media/upload/document', { method: 'POST', token, form });
    expect(uploaded.status).toBe(201);
    const submitted = await request('/vendors/verification/documents', {
      method: 'POST',
      token,
      body: { nationalIdCardUrl: uploaded.body.url },
    });
    expect(submitted.status).toBe(200);
  };

  const approveStore = async (vendorId: string): Promise<void> => {
    const response = await request(`/admin/vendors/${vendorId}/verify`, {
      method: 'POST',
      token: adminToken,
      body: { status: 'APPROVED', rejectionReason: null },
    });
    expect(response.status).toBe(200);
  };

  const uploadImage = async (token: string, width: number, rgb: [number, number, number]): Promise<string> => {
    const body = await sharp({ create: { width, height: width, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } })
      .png()
      .toBuffer();
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(body)], { type: 'image/png' }), `product-${width}.png`);
    form.append('purpose', 'product_image');
    const response = await request<{ id: string }>('/media/upload/image', { method: 'POST', token, form });
    expect(response.status).toBe(201);
    return response.body.id;
  };

  const createCategory = (body: Record<string, unknown>, token = adminToken): Promise<HttpResult<Category>> =>
    request<Category>('/admin/categories', { method: 'POST', token, body });

  const createProduct = (token: string, body: Record<string, unknown>): Promise<HttpResult<VendorProduct>> =>
    request<VendorProduct>('/vendor/products', { method: 'POST', token, body });

  const findNode = (nodes: TreeNode[], slug: string): TreeNode | undefined => {
    for (const node of nodes) {
      if (node.slug === slug) return node;
      const nested = findNode(node.children, slug);
      if (nested) return nested;
    }
    return undefined;
  };

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    applyGlobalPolicies(app, app.get(ConfigService));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    prisma = app.get(PrismaService);
    storage = app.get<StorageProvider>(STORAGE_PROVIDER);
    inventory = app.get(InventoryService);
    await resetAuthKeys();

    const adminPassword = process.env['SUPER_ADMIN_PASSWORD'];
    const staffPassword = process.env['SEED_STAFF_PASSWORD'];
    if (adminPassword === undefined || staffPassword === undefined) {
      throw new Error('This suite needs SUPER_ADMIN_PASSWORD and SEED_STAFF_PASSWORD from the root .env.');
    }
    adminToken = await loginWithPassword(SEEDED_ADMIN_EMAIL, adminPassword);
    supportToken = await loginWithPassword(SEEDED_SUPPORT_EMAIL, staffPassword);

    // Two approved stores, one store still under review, one plain customer.
    const a = await loginWithOtp(VENDOR_A_MOBILE);
    const b = await loginWithOtp(VENDOR_B_MOBILE);
    pending = await loginWithOtp(PENDING_VENDOR_MOBILE);
    customer = await loginWithOtp(CUSTOMER_MOBILE);

    const storeA = `cat-e2e-a-${RUN}`;
    const storeB = `cat-e2e-b-${RUN}`;
    const vendorAId = await registerStore(a.token, storeA, IBANS[0]!);
    const vendorBId = await registerStore(b.token, storeB, IBANS[1]!);
    await registerStore(pending.token, `cat-e2e-p-${RUN}`, IBANS[2]!);
    await submitVerification(a.token);
    await submitVerification(b.token);
    await approveStore(vendorAId);
    await approveStore(vendorBId);
    vendorA = { ...a, vendorId: vendorAId, storeSlug: storeA };
    vendorB = { ...b, vendorId: vendorBId, storeSlug: storeB };

    media.a1 = await uploadImage(a.token, 64, [200, 30, 30]);
    media.a2 = await uploadImage(a.token, 72, [30, 200, 30]);
    media.a3 = await uploadImage(a.token, 80, [30, 30, 200]);
    media.b1 = await uploadImage(b.token, 88, [120, 120, 20]);
  }, 120_000);

  afterAll(async () => {
    if (prisma !== undefined) {
      const users = await prisma.user.findMany({ where: { mobile: { in: SUITE_MOBILES } }, select: { id: true } });
      const userIds = users.map((user) => user.id);
      const vendors = await prisma.vendor.findMany({ where: { userId: { in: userIds } }, select: { id: true } });
      const vendorIds = vendors.map((vendor) => vendor.id);
      const products = await prisma.product.findMany({
        where: { vendorId: { in: vendorIds } },
        select: { id: true, variants: { select: { id: true } } },
      });
      const productIds = products.map((row) => row.id);
      const variantIds = products.flatMap((row) => row.variants.map((variant) => variant.id));
      const categories = await prisma.category.findMany({
        where: { slug: { startsWith: `e2e-cat-${RUN}` } },
        select: { id: true, parentId: true },
      });
      const categoryIds = categories.map((row) => row.id);

      const orders = await prisma.parentOrder.findMany({
        where: { orderNumber: { startsWith: ORDER_PREFIX } },
        select: { id: true },
      });
      const orderIds = orders.map((row) => row.id);
      await prisma.orderItem.deleteMany({ where: { subOrder: { parentOrderId: { in: orderIds } } } });
      await prisma.subOrder.deleteMany({ where: { parentOrderId: { in: orderIds } } });
      await prisma.parentOrder.deleteMany({ where: { id: { in: orderIds } } });

      await prisma.productMedia.deleteMany({ where: { productId: { in: productIds } } });
      await prisma.productVariant.deleteMany({ where: { productId: { in: productIds } } });
      await prisma.product.deleteMany({ where: { id: { in: productIds } } });

      // Children before parents: the parent FK is RESTRICT.
      const remaining = new Set(categoryIds);
      while (remaining.size > 0) {
        const leaves = categories.filter(
          (row) => remaining.has(row.id) && !categories.some((child) => child.parentId === row.id && remaining.has(child.id)),
        );
        await prisma.category.deleteMany({ where: { id: { in: leaves.map((row) => row.id) } } });
        leaves.forEach((row) => remaining.delete(row.id));
        if (leaves.length === 0) break;
      }

      const assets = await prisma.mediaAsset.findMany({
        where: { ownerUserId: { in: userIds } },
        select: { path: true, thumbnailPath: true },
      });
      for (const asset of assets) {
        await storage.delete(asset.path).catch(() => false);
        if (asset.thumbnailPath !== null) await storage.delete(asset.thumbnailPath).catch(() => false);
      }

      await prisma.auditLog.deleteMany({
        where: {
          OR: [
            { userId: { in: userIds } },
            { userAgent: TEST_UA },
            { entityId: { in: [...vendorIds, ...productIds, ...variantIds, ...categoryIds] } },
          ],
        },
      });
      await prisma.vendorVerification.deleteMany({ where: { vendorId: { in: vendorIds } } });
      await prisma.vendorWallet.deleteMany({ where: { vendorId: { in: vendorIds } } });
      await prisma.mediaAsset.deleteMany({ where: { ownerUserId: { in: userIds } } });
      await prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });

      await app.get(CategoriesService).invalidateTree();
      await resetAuthKeys();
    }
    await app?.close();
  }, 120_000);

  /** Test-only housekeeping: clears the auth rate-limit state this suite produces. */
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

  // ─── 1. Category management ───────────────────────────────────────────────

  describe('admin category management', () => {
    it('builds a three-level tree (root → child → grandchild) and a sibling, audited', async () => {
      const root = await createCategory({
        slug: `e2e-cat-${RUN}`,
        titleFa: 'دوربین و عکاسی آزمون',
        titleEn: 'E2E Photography',
        defaultCommissionRate: 8.5,
        sortOrder: 900,
      });
      expect(root.status).toBe(201);
      expect(root.body.parentId).toBeNull();
      expect(root.body.defaultCommissionRate).toBe('8.50');
      cat.root = root.body;

      const cams = await createCategory({
        parentId: cat.root.id,
        slug: `e2e-cat-${RUN}-cams`,
        titleFa: 'دوربین',
        defaultCommissionRate: 7,
        sortOrder: 10,
      });
      expect(cams.status).toBe(201);
      cat.cams = cams.body;

      const mirrorless = await createCategory({
        parentId: cat.cams.id,
        slug: `e2e-cat-${RUN}-mirrorless`,
        titleFa: 'دوربین بدون آینه',
        titleEn: 'Mirrorless',
        defaultCommissionRate: 6.25,
        sortOrder: 10,
      });
      expect(mirrorless.status).toBe(201);
      cat.mirrorless = mirrorless.body;

      const lenses = await createCategory({
        parentId: cat.root.id,
        slug: `e2e-cat-${RUN}-lenses`,
        titleFa: 'لنز',
        defaultCommissionRate: 9,
        sortOrder: 20,
      });
      expect(lenses.status).toBe(201);
      cat.lenses = lenses.body;

      const audit = await prisma.auditLog.findUniqueOrThrow({ where: { id: mirrorless.body.auditLogId! } });
      expect(audit.action).toBe(AuditAction.CREATE);
      expect(audit.entityName).toBe('Category');
      expect(audit.entityId).toBe(cat.mirrorless.id);
    });

    it('rejects duplicate and reserved slugs, unknown parents and out-of-range commission', async () => {
      const duplicate = await createCategory({ slug: cat.cams.slug, titleFa: 'تکراری', defaultCommissionRate: 5 });
      expect(duplicate.status).toBe(409);

      const reserved = await createCategory({ slug: 'tree', titleFa: 'رزرو', defaultCommissionRate: 5 });
      expect(reserved.status).toBe(400);

      const orphan = await createCategory({
        parentId: '00000000-0000-4000-8000-000000000000',
        slug: `e2e-cat-${RUN}-orphan`,
        titleFa: 'یتیم',
        defaultCommissionRate: 5,
      });
      expect(orphan.status).toBe(400);

      const tooHigh = await createCategory({ slug: `e2e-cat-${RUN}-x`, titleFa: 'زیاد', defaultCommissionRate: 150 });
      expect(tooHigh.status).toBe(400);
    });

    it('only SUPER_ADMIN / ADMIN may manage categories', async () => {
      const body = { slug: `e2e-cat-${RUN}-nope`, titleFa: 'ممنوع', defaultCommissionRate: 5 };
      expect((await request('/admin/categories', { method: 'POST', body })).status).toBe(401);
      expect((await createCategory(body, supportToken)).status).toBe(403);
      expect((await createCategory(body, vendorA.token)).status).toBe(403);
      expect((await createCategory(body, customer.token)).status).toBe(403);
    });

    it('updates the commission rate with an audit trail of old and new values', async () => {
      const response = await request<Category>(`/admin/categories/${cat.cams.id}`, {
        method: 'PATCH',
        token: adminToken,
        body: { defaultCommissionRate: 7.75 },
      });
      expect(response.status).toBe(200);
      expect(response.body.defaultCommissionRate).toBe('7.75');

      const audit = await prisma.auditLog.findUniqueOrThrow({ where: { id: response.body.auditLogId! } });
      expect(audit.action).toBe(AuditAction.UPDATE);
      expect(JSON.stringify(audit.oldValue)).toContain('7');
      expect(JSON.stringify(audit.newValue)).toContain('7.75');
    });

    it('refuses to create cycles: self-parenting and moving a node under its own descendant', async () => {
      const self = await request(`/admin/categories/${cat.cams.id}`, {
        method: 'PATCH',
        token: adminToken,
        body: { parentId: cat.cams.id },
      });
      expect(self.status).toBe(400);

      const underDescendant = await request(`/admin/categories/${cat.root.id}`, {
        method: 'PATCH',
        token: adminToken,
        body: { parentId: cat.mirrorless.id },
      });
      expect(underDescendant.status).toBe(400);

      const unchanged = await prisma.category.findUniqueOrThrow({ where: { id: cat.root.id } });
      expect(unchanged.parentId).toBeNull();
    });

    it('allows a legitimate move and moving it back', async () => {
      const moved = await request<Category>(`/admin/categories/${cat.lenses.id}`, {
        method: 'PATCH',
        token: adminToken,
        body: { parentId: cat.cams.id },
      });
      expect(moved.status).toBe(200);
      expect(moved.body.parentId).toBe(cat.cams.id);

      const back = await request<Category>(`/admin/categories/${cat.lenses.id}`, {
        method: 'PATCH',
        token: adminToken,
        body: { parentId: cat.root.id },
      });
      expect(back.status).toBe(200);
      expect(back.body.parentId).toBe(cat.root.id);
    });

    it('lists every category for staff, inactive ones included', async () => {
      const response = await request<{ items: Category[]; total: number }>('/admin/categories', { token: adminToken });
      expect(response.status).toBe(200);
      const ours = response.body.items.filter((row) => row.slug.startsWith(`e2e-cat-${RUN}`));
      expect(ours).toHaveLength(4);
      expect(response.body.total).toBe(response.body.items.length);
    });
  });

  // ─── 2. Public category tree ──────────────────────────────────────────────

  describe('public category tree and category page', () => {
    it('builds the nested tree recursively: root, deep nested node, correct depths', async () => {
      const response = await request<{ items: TreeNode[]; totalCategories: number }>('/categories/tree');
      expect(response.status).toBe(200);

      const root = response.body.items.find((node) => node.slug === cat.root.slug);
      expect(root).toBeDefined();
      expect(root!.depth).toBe(0);
      expect(root!.children.map((child) => child.slug)).toEqual([cat.cams.slug, cat.lenses.slug]);

      const deep = root!.children[0]!.children[0]!;
      expect(deep.slug).toBe(cat.mirrorless.slug);
      expect(deep.depth).toBe(2);
      expect(deep.children).toEqual([]);
      expect(response.body.totalCategories).toBeGreaterThanOrEqual(4);
    });

    it('returns a category with its ancestor breadcrumb and direct children', async () => {
      const deep = await request<{ breadcrumbs: Array<{ slug: string }>; children: unknown[]; depth: number }>(
        `/categories/${cat.mirrorless.slug}`,
      );
      expect(deep.status).toBe(200);
      expect(deep.body.breadcrumbs.map((crumb) => crumb.slug)).toEqual([cat.root.slug, cat.cams.slug, cat.mirrorless.slug]);
      expect(deep.body.depth).toBe(2);

      const root = await request<{ breadcrumbs: Array<{ slug: string }>; children: Array<{ slug: string; childCount: number }> }>(
        `/categories/${cat.root.slug}`,
      );
      expect(root.body.breadcrumbs.map((crumb) => crumb.slug)).toEqual([cat.root.slug]);
      expect(root.body.children.map((child) => child.slug)).toEqual([cat.cams.slug, cat.lenses.slug]);
      expect(root.body.children[0]!.childCount).toBe(1);

      expect((await request('/categories/does-not-exist')).status).toBe(404);
    });

    it('hides a deactivated category together with its whole subtree, and restores it', async () => {
      const off = await request(`/admin/categories/${cat.cams.id}`, {
        method: 'PATCH',
        token: adminToken,
        body: { isActive: false },
      });
      expect(off.status).toBe(200);

      expect((await request(`/categories/${cat.cams.slug}`)).status).toBe(404);
      expect((await request(`/categories/${cat.mirrorless.slug}`)).status).toBe(404);
      const tree = await request<{ items: TreeNode[] }>('/categories/tree');
      expect(findNode(tree.body.items, cat.mirrorless.slug)).toBeUndefined();
      expect(findNode(tree.body.items, cat.lenses.slug)).toBeDefined();

      const on = await request(`/admin/categories/${cat.cams.id}`, {
        method: 'PATCH',
        token: adminToken,
        body: { isActive: true },
      });
      expect(on.status).toBe(200);
      expect((await request(`/categories/${cat.mirrorless.slug}`)).status).toBe(200);
    });
  });

  // ─── 3. Vendor product creation ───────────────────────────────────────────

  describe('vendor product creation', () => {
    const baseBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
      title: `محصول آزمون ${RUN}`,
      categoryId: cat.mirrorless.id,
      basePrice: 1_000_000,
      variants: [{ sku: `E2E-${TAG}-TMP-1`, price: 1_000_000, stockQuantity: 1 }],
      ...overrides,
    });

    it('blocks anonymous callers, customers, stores under review and staff', async () => {
      expect((await request('/vendor/products', { method: 'POST', body: baseBody() })).status).toBe(401);
      expect((await createProduct(customer.token, baseBody())).status).toBe(403);
      expect((await createProduct(pending.token, baseBody())).status).toBe(403);
      expect((await createProduct(adminToken, baseBody())).status).toBe(403);
      expect((await request('/vendor/products', { token: pending.token })).status).toBe(403);
    });

    it('creates product, variant matrix and ordered gallery in one transaction', async () => {
      const response = await createProduct(vendorA.token, {
        title: `دوربین كهكشان ${RUN}`, // Arabic kaf on purpose: stored normalised
        description: 'دوربین بدون آینه با حسگر فول‌فریم و لرزشگیر پنج محوره',
        categoryId: cat.mirrorless.id,
        brand: 'Kahkeshan',
        basePrice: 12_000_000,
        mediaIds: [media.a2, media.a1],
        isPublished: true,
        variants: [
          { sku: `e2e-${RUN}-p1-blk-s`, colorName: 'مشکی', colorHex: '#000000', size: 's', guarantee: 'گارانتی ۱۸ ماهه', price: 10_000_000, compareAtPrice: 12_000_000, stockQuantity: 5, weightGrams: 650 },
          { sku: `E2E-${TAG}-P1-BLK-M`, colorName: 'مشکی', colorHex: '#000000', size: 'M', guarantee: 'گارانتی ۱۸ ماهه', price: 11_000_000, stockQuantity: 0 },
          { sku: `E2E-${TAG}-P1-RED-M`, colorName: 'قرمز', colorHex: '#ff0000', size: 'M', guarantee: 'گارانتی ۱۸ ماهه', price: 12_500_000, stockQuantity: 3 },
        ],
      });
      expect(response.status).toBe(201);
      product.p1 = response.body;

      expect(response.body.title).toBe(`دوربین کهکشان ${RUN}`);
      expect(response.body.slug).toMatch(new RegExp(`${RUN}$`));
      expect(response.body.isPublished).toBe(true);
      expect(response.body.isSellable).toBe(true);
      expect(response.body.priceRange).toEqual({ min: '10000000.00', max: '12500000.00' });
      expect(response.body.stock).toMatchObject({ variantCount: 3, activeVariantCount: 3, totalStock: 8, totalAvailable: 8 });

      const [first, second] = response.body.media!;
      expect(first!.mediaAssetId).toBe(media.a2);
      expect(first!.isPrimary).toBe(true);
      expect(second!.mediaAssetId).toBe(media.a1);
      expect(second!.isPrimary).toBe(false);
      expect(first!.sortOrder).toBeLessThan(second!.sortOrder);

      const skus = response.body.variants!.map((variant) => variant.sku);
      expect(skus).toContain(`E2E-${TAG}-P1-BLK-S`); // normalised to upper case
      const discounted = response.body.variants!.find((variant) => variant.sku === `E2E-${TAG}-P1-BLK-S`)!;
      expect(discounted.discountPercent).toBe(16);
      // Sizes keep the vendor's spelling; every comparison (matrix, filters, facets) is case-insensitive.
      expect(discounted.size).toBe('s');
      expect(discounted.colorHex).toBe('#000000');

      const rows = await prisma.product.findUniqueOrThrow({
        where: { id: product.p1.id },
        include: { variants: true, media: true },
      });
      expect(rows.vendorId).toBe(vendorA.vendorId);
      expect(rows.variants).toHaveLength(3);
      expect(rows.media).toHaveLength(2);

      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { entityId: product.p1.id, action: AuditAction.CREATE, entityName: 'Product' },
      });
      expect(audit.userId).toBe(vendorA.userId);
    });

    it('creates the rest of the fixture catalogue', async () => {
      const p2 = await createProduct(vendorA.token, {
        title: `لنز تله ${RUN}`,
        description: 'لنز تله با بدنه ضدآب',
        categoryId: cat.lenses.id,
        brand: 'Optika',
        basePrice: 3_000_000,
        mediaIds: [media.a3],
        isPublished: true,
        variants: [{ sku: `E2E-${TAG}-P2-1`, price: 3_000_000, stockQuantity: 0 }],
      });
      expect(p2.status).toBe(201);
      product.p2 = p2.body;

      const p3 = await createProduct(vendorA.token, {
        title: `کیف دوربین ${RUN}`,
        categoryId: cat.cams.id,
        basePrice: 500_000,
        isPublished: true,
        variants: [{ sku: `E2E-${TAG}-P3-1`, colorName: 'قهوه‌ای', size: 'L', price: 500_000, stockQuantity: 10 }],
      });
      expect(p3.status).toBe(201);
      product.p3 = p3.body;

      const pb = await createProduct(vendorB.token, {
        title: `سه پایه ${RUN}`,
        slug: `tripod-${RUN}`,
        categoryId: cat.mirrorless.id,
        basePrice: 1_500_000,
        mediaIds: [media.b1],
        isPublished: true,
        variants: [{ sku: `E2E-${TAG}-PB-1`, colorName: 'مشکی', colorHex: '#000000', price: 1_500_000, stockQuantity: 4 }],
      });
      expect(pb.status).toBe(201);
      expect(pb.body.slug).toBe(`tripod-${RUN}`);
      product.pb = pb.body;
    });

    it('derives a fresh slug for a duplicate title and keeps drafts unpublished', async () => {
      const draft = await createProduct(vendorA.token, {
        title: `دوربین کهکشان ${RUN}`,
        categoryId: cat.mirrorless.id,
        basePrice: 2_000_000,
        variants: [{ sku: `E2E-${TAG}-D-1`, price: 2_000_000, stockQuantity: 5 }],
      });
      expect(draft.status).toBe(201);
      expect(draft.body.slug).not.toBe(product.p1.slug);
      expect(draft.body.isPublished).toBe(false);
      product.draft = draft.body;
    });

    it('enforces globally unique SKUs — across stores, case-insensitively, and within one request', async () => {
      const crossStore = await createProduct(vendorB.token, {
        ...baseBody(),
        variants: [{ sku: `e2e-${RUN}-p1-red-m`, price: 1_000_000, stockQuantity: 1 }],
      });
      expect(crossStore.status).toBe(409);

      const withinRequest = await createProduct(vendorA.token, {
        ...baseBody(),
        variants: [
          { sku: `E2E-${TAG}-DUP`, size: 'S', price: 1_000_000, stockQuantity: 1 },
          { sku: `E2E-${TAG}-DUP`, size: 'M', price: 1_000_000, stockQuantity: 1 },
        ],
      });
      expect(withinRequest.status).toBe(400);
      expect(await prisma.productVariant.count({ where: { sku: `E2E-${TAG}-DUP` } })).toBe(0);
    });

    it('rejects pricing violations: compareAtPrice ≤ price, zero price', async () => {
      const equal = await createProduct(vendorA.token, {
        ...baseBody(),
        variants: [{ sku: `E2E-${TAG}-PR-1`, price: 1_000_000, compareAtPrice: 1_000_000, stockQuantity: 1 }],
      });
      expect(equal.status).toBe(400);

      const lower = await createProduct(vendorA.token, {
        ...baseBody(),
        variants: [{ sku: `E2E-${TAG}-PR-2`, price: 1_000_000, compareAtPrice: 900_000, stockQuantity: 1 }],
      });
      expect(lower.status).toBe(400);

      const zero = await createProduct(vendorA.token, {
        ...baseBody(),
        variants: [{ sku: `E2E-${TAG}-PR-3`, price: 0, stockQuantity: 1 }],
      });
      expect(zero.status).toBe(400);

      const negativeStock = await createProduct(vendorA.token, {
        ...baseBody(),
        variants: [{ sku: `E2E-${TAG}-PR-4`, price: 10, stockQuantity: -1 }],
      });
      expect(negativeStock.status).toBe(400);
    });

    it('rejects a duplicated matrix cell, foreign media, inactive categories and taken slugs', async () => {
      const cell = await createProduct(vendorA.token, {
        ...baseBody(),
        variants: [
          { sku: `E2E-${TAG}-C-1`, colorName: 'سفید', size: 'L', price: 10, stockQuantity: 1 },
          { sku: `E2E-${TAG}-C-2`, colorName: 'سفید', size: 'l', price: 10, stockQuantity: 1 },
        ],
      });
      expect(cell.status).toBe(400);

      const foreignMedia = await createProduct(vendorA.token, baseBody({ mediaIds: [media.b1] }));
      expect(foreignMedia.status).toBe(400);

      await prisma.category.update({ where: { id: cat.lenses.id }, data: { isActive: false } });
      await app.get(CategoriesService).invalidateTree();
      const inactive = await createProduct(vendorA.token, baseBody({ categoryId: cat.lenses.id }));
      expect(inactive.status).toBe(400);
      await prisma.category.update({ where: { id: cat.lenses.id }, data: { isActive: true } });
      await app.get(CategoriesService).invalidateTree();

      const takenSlug = await createProduct(vendorA.token, baseBody({ slug: `tripod-${RUN}` }));
      expect(takenSlug.status).toBe(409);
    });

    it('refuses to publish a product whose variants are all inactive', async () => {
      const response = await createProduct(vendorA.token, {
        ...baseBody(),
        isPublished: true,
        variants: [{ sku: `E2E-${TAG}-OFF-1`, price: 10, stockQuantity: 1, isActive: false }],
      });
      expect(response.status).toBe(400);
    });
  });

  // ─── 4. Vendor listing and detail ─────────────────────────────────────────

  describe('vendor listing and detail', () => {
    it('lists only the caller’s products, with stock summaries, search and status filter', async () => {
      const all = await request<Page<VendorProduct>>('/vendor/products?pageSize=50', { token: vendorA.token });
      expect(all.status).toBe(200);
      expect(all.body.total).toBe(4);
      expect(all.body.items.map((item) => item.id)).not.toContain(product.pb.id);
      const p1 = all.body.items.find((item) => item.id === product.p1.id)!;
      expect(p1.stock.totalStock).toBe(8);

      const drafts = await request<Page<VendorProduct>>('/vendor/products?status=draft', { token: vendorA.token });
      expect(drafts.body.items.map((item) => item.id)).toEqual([product.draft.id]);

      const bySku = await request<Page<VendorProduct>>(`/vendor/products?search=${encodeURIComponent(`E2E-${TAG}-P3`)}`, {
        token: vendorA.token,
      });
      expect(bySku.body.items.map((item) => item.id)).toEqual([product.p3.id]);

      const paged = await request<Page<VendorProduct>>('/vendor/products?pageSize=3&page=2', { token: vendorA.token });
      expect(paged.body).toMatchObject({ page: 2, pageSize: 3, total: 4, totalPages: 2 });
      expect(paged.body.items).toHaveLength(1);
    });

    it('returns full detail to the owner and 404 to any other store', async () => {
      const own = await request<VendorProduct>(`/vendor/products/${product.p1.id}`, { token: vendorA.token });
      expect(own.status).toBe(200);
      expect(own.body.variants).toHaveLength(3);
      expect(own.body.media).toHaveLength(2);

      expect((await request(`/vendor/products/${product.p1.id}`, { token: vendorB.token })).status).toBe(404);
      expect((await request('/vendor/products/not-a-uuid', { token: vendorA.token })).status).toBe(400);
    });
  });

  // ─── 5. Variant and product updates ───────────────────────────────────────

  describe('variant and product updates', () => {
    const variantOf = (p: VendorProduct, sku: string): Variant => p.variants!.find((variant) => variant.sku === sku)!;

    it('lets the owner change price and stock, audited with old and new values', async () => {
      const target = variantOf(product.draft, `E2E-${TAG}-D-1`);
      const response = await request<Variant>(`/vendor/products/variants/${target.id}`, {
        method: 'PATCH',
        token: vendorA.token,
        body: { price: 2_200_000, compareAtPrice: 2_500_000, stockQuantity: 9 },
      });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ price: '2200000.00', compareAtPrice: '2500000.00', stockQuantity: 9, discountPercent: 12 });

      const row = await prisma.productVariant.findUniqueOrThrow({ where: { id: target.id } });
      expect(row.price.toFixed(2)).toBe('2200000.00');
      expect(row.stockQuantity).toBe(9);

      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { entityId: target.id, entityName: 'ProductVariant', action: AuditAction.UPDATE },
        orderBy: { createdAt: 'desc' },
      });
      expect(audit.userId).toBe(vendorA.userId);
      expect(JSON.stringify(audit.oldValue)).toContain('2000000');
    });

    it('applies relative stock changes atomically and refuses to go below zero', async () => {
      const target = variantOf(product.draft, `E2E-${TAG}-D-1`);
      const down = await request<Variant>(`/vendor/products/variants/${target.id}`, {
        method: 'PATCH',
        token: vendorA.token,
        body: { stockDelta: -4 },
      });
      expect(down.status).toBe(200);
      expect(down.body.stockQuantity).toBe(5);

      const tooFar = await request(`/vendor/products/variants/${target.id}`, {
        method: 'PATCH',
        token: vendorA.token,
        body: { stockDelta: -6 },
      });
      expect(tooFar.status).toBe(409);

      const both = await request(`/vendor/products/variants/${target.id}`, {
        method: 'PATCH',
        token: vendorA.token,
        body: { stockDelta: 1, stockQuantity: 1 },
      });
      expect(both.status).toBe(400);

      const empty = await request(`/vendor/products/variants/${target.id}`, { method: 'PATCH', token: vendorA.token, body: {} });
      expect(empty.status).toBe(400);
    });

    it('rejects a new price that is not below the existing compareAtPrice; clearing it works', async () => {
      const target = variantOf(product.draft, `E2E-${TAG}-D-1`);
      const invalid = await request(`/vendor/products/variants/${target.id}`, {
        method: 'PATCH',
        token: vendorA.token,
        body: { price: 2_600_000 },
      });
      expect(invalid.status).toBe(400);

      const cleared = await request<Variant>(`/vendor/products/variants/${target.id}`, {
        method: 'PATCH',
        token: vendorA.token,
        body: { price: 2_600_000, compareAtPrice: null },
      });
      expect(cleared.status).toBe(200);
      expect(cleared.body.compareAtPrice).toBeNull();
      expect(cleared.body.discountPercent).toBeNull();
    });

    it('gives another store 404 for every write on someone else’s product', async () => {
      const target = variantOf(product.p1, `E2E-${TAG}-P1-BLK-S`);
      const variantWrite = await request(`/vendor/products/variants/${target.id}`, {
        method: 'PATCH',
        token: vendorB.token,
        body: { stockQuantity: 999 },
      });
      expect(variantWrite.status).toBe(404);
      expect((await request(`/vendor/products/${product.p1.id}`, { method: 'PATCH', token: vendorB.token, body: { title: 'ربوده' } })).status).toBe(404);
      expect((await request(`/vendor/products/${product.p1.id}/variants`, { method: 'POST', token: vendorB.token, body: { sku: `E2E-${TAG}-X`, price: 1, stockQuantity: 1 } })).status).toBe(404);
      expect((await request(`/vendor/products/${product.p1.id}`, { method: 'DELETE', token: vendorB.token })).status).toBe(404);

      const untouched = await prisma.productVariant.findUniqueOrThrow({ where: { id: target.id } });
      expect(untouched.stockQuantity).toBe(5);
      expect((await prisma.product.findUniqueOrThrow({ where: { id: product.p1.id } })).isPublished).toBe(true);
    });

    it('adds a variant, rejecting duplicate SKUs and duplicate matrix cells', async () => {
      const added = await request<Variant>(`/vendor/products/${product.p1.id}/variants`, {
        method: 'POST',
        token: vendorA.token,
        body: { sku: `E2E-${TAG}-P1-RED-S`, colorName: 'قرمز', colorHex: '#FF0000', size: 'S', guarantee: 'گارانتی ۱۸ ماهه', price: 12_000_000, stockQuantity: 2 },
      });
      expect(added.status).toBe(201);
      expect(added.body.isActive).toBe(true);

      const sameSku = await request(`/vendor/products/${product.p1.id}/variants`, {
        method: 'POST',
        token: vendorA.token,
        body: { sku: `E2E-${TAG}-PB-1`, colorName: 'سبز', price: 1, stockQuantity: 1 },
      });
      expect(sameSku.status).toBe(409);

      const sameCell = await request(`/vendor/products/${product.p1.id}/variants`, {
        method: 'POST',
        token: vendorA.token,
        body: { sku: `E2E-${TAG}-P1-RED-S2`, colorName: 'قرمز', size: 's', guarantee: 'گارانتی ۱۸ ماهه', price: 1, stockQuantity: 1 },
      });
      expect(sameCell.status).toBe(409);

      // Deactivated again so the public fixtures below stay as designed.
      const off = await request<Variant>(`/vendor/products/variants/${added.body.id}`, {
        method: 'PATCH',
        token: vendorA.token,
        body: { isActive: false },
      });
      expect(off.status).toBe(200);
      expect(off.body.isActive).toBe(false);
    });

    it('refuses to deactivate the last active variant of a published product', async () => {
      const only = product.p3.variants![0]!;
      const response = await request(`/vendor/products/variants/${only.id}`, {
        method: 'PATCH',
        token: vendorA.token,
        body: { isActive: false },
      });
      expect(response.status).toBe(409);
    });

    it('re-orders the gallery with PATCH mediaIds and keeps the first image primary', async () => {
      const response = await request<VendorProduct>(`/vendor/products/${product.p1.id}`, {
        method: 'PATCH',
        token: vendorA.token,
        body: { mediaIds: [media.a1, media.a2] },
      });
      expect(response.status).toBe(200);
      expect(response.body.media!.map((entry) => entry.mediaAssetId)).toEqual([media.a1, media.a2]);
      expect(response.body.media![0]!.isPrimary).toBe(true);
      expect(await prisma.productMedia.count({ where: { productId: product.p1.id } })).toBe(2);
    });
  });

  // ─── 6. Inventory integrity ───────────────────────────────────────────────

  describe('inventory integrity (atomic, database-enforced)', () => {
    let variantId: string;

    beforeAll(() => {
      variantId = product.draft.variants![0]!.id;
    });

    it('never oversells under concurrent reservations', async () => {
      await inventory.setStock(variantId, 5);
      const attempts = await Promise.allSettled(Array.from({ length: 12 }, () => inventory.reserve(variantId, 1)));
      expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(5);
      expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(7);

      const level = await inventory.level(variantId);
      expect(level).toMatchObject({ stockQuantity: 5, reservedQuantity: 5, availableQuantity: 0 });
    });

    it('does not let the vendor set stock below reserved units', async () => {
      const response = await request(`/vendor/products/variants/${variantId}`, {
        method: 'PATCH',
        token: vendorA.token,
        body: { stockQuantity: 3 },
      });
      expect(response.status).toBe(409);
      expect((await inventory.level(variantId))!.stockQuantity).toBe(5);
    });

    it('releases and commits reservations exactly', async () => {
      expect(await inventory.release(variantId, 2)).toMatchObject({ reservedQuantity: 3, availableQuantity: 2 });
      expect(await inventory.commitReservation(variantId, 3)).toMatchObject({ stockQuantity: 2, reservedQuantity: 0 });
      await expect(inventory.release(variantId, 1)).rejects.toThrow();
    });

    it('serialises concurrent relative decrements from the API', async () => {
      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          request(`/vendor/products/variants/${variantId}`, { method: 'PATCH', token: vendorA.token, body: { stockDelta: -1 } }),
        ),
      );
      expect(results.filter((result) => result.status === 200)).toHaveLength(2);
      expect(results.filter((result) => result.status === 409)).toHaveLength(2);
      expect((await inventory.level(variantId))!.stockQuantity).toBe(0);
    });

    it('is backed by CHECK constraints even for writes that bypass the API', async () => {
      await expect(prisma.productVariant.update({ where: { id: variantId }, data: { stockQuantity: -1 } })).rejects.toThrow();
      await expect(prisma.productVariant.update({ where: { id: variantId }, data: { reservedQuantity: 1 } })).rejects.toThrow();
      await expect(prisma.productVariant.update({ where: { id: variantId }, data: { price: 0 } })).rejects.toThrow();
      await expect(
        prisma.productVariant.update({ where: { id: variantId }, data: { compareAtPrice: 1 } }),
      ).rejects.toThrow();
    });
  });

  // ─── 7. Public discovery ──────────────────────────────────────────────────

  describe('public discovery', () => {
    const inRoot = { categorySlug: `e2e-cat-${RUN}`, pageSize: 50 };

    it('finds products by keyword in title, brand and description, tolerant of Arabic letters', async () => {
      const title = await search({ search: `کهکشان ${RUN}` });
      expect(slugs(title)).toEqual([product.p1.slug]);

      const arabic = await search({ search: `كهكشان ${RUN}` });
      expect(slugs(arabic)).toEqual([product.p1.slug]);

      const brand = await search({ ...inRoot, search: 'optika' });
      expect(slugs(brand)).toEqual([product.p2.slug]);

      const description = await search({ ...inRoot, search: 'ضدآب' });
      expect(slugs(description)).toEqual([product.p2.slug]);

      const nothing = await search({ search: `ناموجود-${RUN}-zzz` });
      expect(nothing.body.total).toBe(0);
    });

    it('treats LIKE wildcards in the search term literally', async () => {
      const wildcard = await search({ ...inRoot, search: '%' });
      expect(wildcard.status).toBe(200);
      expect(wildcard.body.total).toBe(0);
    });

    it('includes every descendant when filtering by category', async () => {
      const root = await search(inRoot);
      expect(root.body.total).toBe(4);
      expect(new Set(slugs(root))).toEqual(new Set([product.p1.slug, product.p2.slug, product.p3.slug, product.pb.slug]));

      const cams = await search({ categorySlug: cat.cams.slug, pageSize: 50 });
      expect(new Set(slugs(cams))).toEqual(new Set([product.p1.slug, product.p3.slug, product.pb.slug]));

      const deep = await search({ categoryId: cat.mirrorless.id, pageSize: 50 });
      expect(new Set(slugs(deep))).toEqual(new Set([product.p1.slug, product.pb.slug]));

      const lenses = await search({ categorySlug: cat.lenses.slug });
      expect(slugs(lenses)).toEqual([product.p2.slug]);

      const unknown = await search({ categorySlug: 'no-such-category' });
      expect(unknown.body).toMatchObject({ total: 0, items: [] });
    });

    it('never lists drafts, even when the search term matches', async () => {
      const response = await search({ ...inRoot, search: `کهکشان ${RUN}` });
      expect(slugs(response)).toEqual([product.p1.slug]);
      expect(slugs(response)).not.toContain(product.draft.slug);
    });

    it('returns the exact subset for price ranges (variant level)', async () => {
      const mid = await search({ ...inRoot, minPrice: 1_000_000, maxPrice: 4_000_000 });
      expect(new Set(slugs(mid))).toEqual(new Set([product.p2.slug, product.pb.slug]));

      const p1Only = await search({ ...inRoot, minPrice: 10_000_000 });
      expect(slugs(p1Only)).toEqual([product.p1.slug]);

      const cheap = await search({ ...inRoot, maxPrice: 500_000 });
      expect(slugs(cheap)).toEqual([product.p3.slug]);

      expect((await search({ minPrice: 5, maxPrice: 1 })).status).toBe(400);
    });

    it('returns the exact subset for inStockOnly', async () => {
      const inStock = await search({ ...inRoot, inStockOnly: true });
      expect(new Set(slugs(inStock))).toEqual(new Set([product.p1.slug, product.p3.slug, product.pb.slug]));

      const all = await search(inRoot);
      const p2 = all.body.items.find((item) => item.slug === product.p2.slug)!;
      expect(p2.inStock).toBe(false);
    });

    it('matches colour, size, price and stock on the same variant', async () => {
      const blackM = await search({ ...inRoot, colors: ['مشکی'], sizes: ['m'] });
      expect(slugs(blackM)).toEqual([product.p1.slug]);

      // P1's only black-M variant has no stock, so it must drop out.
      const blackMInStock = await search({ ...inRoot, colors: ['مشکی'], sizes: ['M'], inStockOnly: true });
      expect(blackMInStock.body.total).toBe(0);

      const black = await search({ ...inRoot, colors: ['#000000'] });
      expect(new Set(slugs(black))).toEqual(new Set([product.p1.slug, product.pb.slug]));

      const redS = await search({ ...inRoot, colors: ['#ff0000'], sizes: ['S'] });
      expect(redS.body.total).toBe(0); // the red-S variant exists but is inactive

      const commaList = await search({ ...inRoot, sizes: ['S,L'] });
      expect(new Set(slugs(commaList))).toEqual(new Set([product.p1.slug, product.p3.slug]));
    });

    it('filters by store', async () => {
      const b = await search({ ...inRoot, vendorSlug: vendorB.storeSlug });
      expect(slugs(b)).toEqual([product.pb.slug]);
      expect(b.body.items[0]!.vendor.storeSlug).toBe(vendorB.storeSlug);
    });

    it('sorts by newest, price ascending and price descending', async () => {
      const newest = await search({ ...inRoot, sortBy: 'newest' });
      expect(slugs(newest)).toEqual([product.pb.slug, product.p3.slug, product.p2.slug, product.p1.slug]);

      const asc = await search({ ...inRoot, sortBy: 'price_asc' });
      expect(slugs(asc)).toEqual([product.p3.slug, product.pb.slug, product.p2.slug, product.p1.slug]);

      const desc = await search({ ...inRoot, sortBy: 'price_desc' });
      expect(slugs(desc)).toEqual([product.p1.slug, product.p2.slug, product.pb.slug, product.p3.slug]);
    });

    it('sorts by units actually sold, ignoring cancelled orders, with newest as the tie-breaker', async () => {
      const zero = await search({ ...inRoot, sortBy: 'popular' });
      expect(slugs(zero)).toEqual(slugs(await search({ ...inRoot, sortBy: 'newest' })));

      const line = async (suffix: string, sku: string, quantity: number, status: SubOrderStatus): Promise<void> => {
        const variant = await prisma.productVariant.findUniqueOrThrow({
          where: { sku },
          include: { product: { include: { vendor: true } } },
        });
        const amount = variant.price.mul(quantity);
        await prisma.parentOrder.create({
          data: {
            orderNumber: `${ORDER_PREFIX}${suffix}`,
            userId: customer.userId,
            shippingAddressSnapshot: { city: 'تهران', recipientName: 'آزمون' },
            totalItemsAmount: amount,
            finalPayableAmount: amount,
            paymentMethod: PaymentMethod.CASH_IPG,
            paymentStatus: 'PAID',
            subOrders: {
              create: {
                vendorId: variant.product.vendorId,
                subOrderNumber: `${ORDER_PREFIX}${suffix}-1`,
                itemsSubtotal: amount,
                platformCommissionAmount: 0,
                vendorEarningsAmount: amount,
                status,
                items: {
                  create: {
                    productVariantId: variant.id,
                    productTitleSnapshot: variant.product.title,
                    vendorStoreNameSnapshot: variant.product.vendor.storeName,
                    skuSnapshot: variant.sku,
                    variantDetailsSnapshot: {},
                    unitPriceSnapshot: variant.price,
                    discountSnapshot: 0,
                    commissionRateSnapshot: 0,
                    quantity,
                    totalLineAmount: amount,
                  },
                },
              },
            },
          },
        });
      };

      await line('A', `E2E-${TAG}-PB-1`, 3, SubOrderStatus.DELIVERED);
      await line('B', `E2E-${TAG}-P2-1`, 1, SubOrderStatus.PROCESSING);
      await line('C', `E2E-${TAG}-P3-1`, 50, SubOrderStatus.CANCELLED);
      await line('D', `E2E-${TAG}-P3-1`, 7, SubOrderStatus.REFUNDED);

      const popular = await search({ ...inRoot, sortBy: 'popular' });
      expect(slugs(popular)).toEqual([product.pb.slug, product.p2.slug, product.p3.slug, product.p1.slug]);
    });

    it('paginates with a consistent total', async () => {
      const page2 = await search({ ...inRoot, pageSize: 1, page: 2, sortBy: 'newest' });
      expect(page2.body).toMatchObject({ page: 2, pageSize: 1, total: 4, totalPages: 4 });
      expect(slugs(page2)).toEqual([product.p3.slug]);

      const beyond = await search({ ...inRoot, pageSize: 10, page: 9 });
      expect(beyond.body).toMatchObject({ total: 4, items: [] });
    });

    it('returns thumbnail, price range, options, discount and vendor for each item', async () => {
      const response = await search({ search: `کهکشان ${RUN}` });
      const item = response.body.items[0]!;
      expect(item.priceRange).toEqual({ min: '10000000.00', max: '12500000.00' });
      // Variants have no sort column: order is createdAt, then SKU (…BLK-M < …BLK-S < …RED-M).
      expect(item.sizes).toEqual(['M', 's']);
      expect(item.colors).toEqual([
        { name: 'مشکی', hex: '#000000' },
        { name: 'قرمز', hex: '#FF0000' },
      ]);
      expect(item.maxDiscountPercent).toBe(16);
      // The strike-through price that belongs to priceRange.min (the 10,000,000 variant).
      expect(item.startingCompareAtPrice).toBe('12000000.00');
      expect(item.inStock).toBe(true);
      expect(item.vendor.storeSlug).toBe(vendorA.storeSlug);
      expect(item.category.slug).toBe(cat.mirrorless.slug);

      const primary = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: media.a1 } });
      expect(item.primaryImage!.url).toContain(primary.path);
      expect(item.primaryImage!.thumbnailUrl).not.toBeNull();
    });

    it('returns the product page with breadcrumbs, store, full gallery and every active variant', async () => {
      const response = await request<{
        breadcrumbs: Array<{ slug: string }>;
        vendor: { storeSlug: string; bio: string | null };
        media: Array<{ url: string; thumbnailUrl: string | null }>;
        variants: Array<{ sku: string; availableQuantity: number; inStock: boolean }>;
        description: string;
      }>(`/products/${product.p1.slug}`);

      expect(response.status).toBe(200);
      expect(response.body.breadcrumbs.map((crumb) => crumb.slug)).toEqual([cat.root.slug, cat.cams.slug, cat.mirrorless.slug]);
      expect(response.body.vendor.storeSlug).toBe(vendorA.storeSlug);
      expect(response.body.vendor.bio).not.toBeNull();
      expect(response.body.description).toContain('فول‌فریم');
      expect(response.body.media).toHaveLength(2);

      const [first, second] = await Promise.all([
        prisma.mediaAsset.findUniqueOrThrow({ where: { id: media.a1 } }),
        prisma.mediaAsset.findUniqueOrThrow({ where: { id: media.a2 } }),
      ]);
      expect(response.body.media[0]!.url).toContain(first.path);
      expect(response.body.media[1]!.url).toContain(second.path);

      const variants = new Map(response.body.variants.map((variant) => [variant.sku, variant]));
      expect([...variants.keys()].sort()).toEqual(
        [`E2E-${TAG}-P1-BLK-M`, `E2E-${TAG}-P1-BLK-S`, `E2E-${TAG}-P1-RED-M`].sort(),
      ); // the inactive red-S variant is not shown
      expect(variants.get(`E2E-${TAG}-P1-BLK-S`)).toMatchObject({ availableQuantity: 5, inStock: true });
      expect(variants.get(`E2E-${TAG}-P1-BLK-M`)).toMatchObject({ availableQuantity: 0, inStock: false });
    });

    it('shows live stock: a reservation is reflected immediately', async () => {
      const variant = product.p1.variants!.find((entry) => entry.sku === `E2E-${TAG}-P1-RED-M`)!;
      await inventory.reserve(variant.id, 2);
      const response = await request<{ variants: Array<{ sku: string; availableQuantity: number }> }>(`/products/${product.p1.slug}`);
      expect(response.body.variants.find((entry) => entry.sku === variant.sku)!.availableQuantity).toBe(1);
      await inventory.release(variant.id, 2);
    });

    it('404s for drafts and unknown slugs', async () => {
      expect((await request(`/products/${product.draft.slug}`)).status).toBe(404);
      expect((await request('/products/no-such-product')).status).toBe(404);
    });

    it('reflects visible products in the category tree counts', async () => {
      const tree = await request<{ items: TreeNode[] }>('/categories/tree');
      const root = findNode(tree.body.items, cat.root.slug)!;
      expect(root.productCount).toBe(0);
      expect(root.totalProductCount).toBe(4);
      expect(findNode(tree.body.items, cat.mirrorless.slug)!.productCount).toBe(2);
      expect(findNode(tree.body.items, cat.cams.slug)!.totalProductCount).toBe(3);
    });
  });

  // ─── 8. Staff moderation ──────────────────────────────────────────────────

  describe('staff moderation', () => {
    const status = (token: string, body: Record<string, unknown>, id = product.pb.id): Promise<HttpResult<{
      product: { isPublished: boolean; moderation: { isBlockedByAdmin: boolean; blockedReason: string | null }; blockedByUserId: string | null };
      auditLogId: string;
      changed: string[];
    }>> => request(`/admin/products/${id}/status`, { method: 'PATCH', token, body });

    it('lets SUPPORT browse but not moderate; vendors cannot reach it at all', async () => {
      const list = await request<Page<{ id: string }>>(`/admin/products?vendorSlug=${vendorB.storeSlug}`, { token: supportToken });
      expect(list.status).toBe(200);
      expect(list.body.items.map((item) => item.id)).toEqual([product.pb.id]);

      expect((await status(supportToken, { isBlockedByAdmin: true, blockedReason: 'تصویر نامناسب' })).status).toBe(403);
      expect((await status(vendorA.token, { isBlockedByAdmin: true, blockedReason: 'تصویر نامناسب' })).status).toBe(403);
      expect((await request(`/admin/products`, { token: vendorA.token })).status).toBe(403);
    });

    it('requires a reason to block', async () => {
      expect((await status(adminToken, { isBlockedByAdmin: true })).status).toBe(400);
      expect((await status(adminToken, { blockedReason: 'بدون مسدودسازی' })).status).toBe(400);
      expect((await status(adminToken, {})).status).toBe(400);
    });

    it('blocks: unpublishes, removes from the storefront and writes an audit row', async () => {
      const response = await status(adminToken, { isBlockedByAdmin: true, blockedReason: 'اطلاعات گارانتی نادرست است' });
      expect(response.status).toBe(200);
      expect(response.body.product.isPublished).toBe(false);
      expect(response.body.product.moderation).toMatchObject({ isBlockedByAdmin: true, blockedReason: 'اطلاعات گارانتی نادرست است' });

      const audit = await prisma.auditLog.findUniqueOrThrow({ where: { id: response.body.auditLogId } });
      expect(audit.action).toBe(AuditAction.STATUS_CHANGE);
      expect(audit.entityId).toBe(product.pb.id);

      expect((await request(`/products/${product.pb.slug}`)).status).toBe(404);
      expect(slugs(await search({ categorySlug: `e2e-cat-${RUN}`, pageSize: 50 }))).not.toContain(product.pb.slug);

      const blocked = await request<Page<{ id: string }>>('/admin/products?isBlockedByAdmin=true&pageSize=100', { token: adminToken });
      expect(blocked.body.items.map((item) => item.id)).toContain(product.pb.id);

      const vendorView = await request<VendorProduct>(`/vendor/products/${product.pb.id}`, { token: vendorB.token });
      expect(vendorView.body.moderation.blockedReason).toBe('اطلاعات گارانتی نادرست است');
    });

    it('stops the vendor — and staff — from publishing a blocked product', async () => {
      const vendorPublish = await request(`/vendor/products/${product.pb.id}`, {
        method: 'PATCH',
        token: vendorB.token,
        body: { isPublished: true },
      });
      expect(vendorPublish.status).toBe(403);

      expect((await status(adminToken, { isPublished: true })).status).toBe(409);

      // Other edits remain possible while blocked, so the vendor can fix the problem.
      const edit = await request(`/vendor/products/${product.pb.id}`, {
        method: 'PATCH',
        token: vendorB.token,
        body: { description: 'گارانتی ۱۲ ماهه شرکتی' },
      });
      expect(edit.status).toBe(200);
    });

    it('unblocks without republishing; the vendor can then publish again', async () => {
      const lifted = await status(adminToken, { isBlockedByAdmin: false });
      expect(lifted.status).toBe(200);
      expect(lifted.body.product.isPublished).toBe(false);
      expect(lifted.body.product.moderation.isBlockedByAdmin).toBe(false);
      expect(lifted.body.product.blockedByUserId).toBeNull();

      const published = await request<VendorProduct>(`/vendor/products/${product.pb.id}`, {
        method: 'PATCH',
        token: vendorB.token,
        body: { isPublished: true },
      });
      expect(published.status).toBe(200);
      expect((await request(`/products/${product.pb.slug}`)).status).toBe(200);
    });

    it('hides a suspended store’s products and freezes its writes, but keeps its reads', async () => {
      await prisma.vendor.update({ where: { id: vendorB.vendorId }, data: { status: VendorStatus.SUSPENDED } });
      try {
        expect((await request(`/products/${product.pb.slug}`)).status).toBe(404);
        expect((await request(`/vendor/products/${product.pb.id}`, { token: vendorB.token })).status).toBe(200);
        const write = await request(`/vendor/products/${product.pb.id}`, {
          method: 'PATCH',
          token: vendorB.token,
          body: { title: 'تغییر در حالت تعلیق' },
        });
        expect(write.status).toBe(403);
      } finally {
        await prisma.vendor.update({ where: { id: vendorB.vendorId }, data: { status: VendorStatus.APPROVED } });
      }
      expect((await request(`/products/${product.pb.slug}`)).status).toBe(200);
    });
  });

  // ─── 9. Archive (soft delete) ─────────────────────────────────────────────

  describe('archive', () => {
    it('unpublishes, keeps every row, and is idempotent', async () => {
      const first = await request<{ isPublished: boolean; wasPublished: boolean; auditLogId: string | null }>(
        `/vendor/products/${product.p3.id}`,
        { method: 'DELETE', token: vendorA.token },
      );
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({ isPublished: false, wasPublished: true });
      expect(first.body.auditLogId).not.toBeNull();

      const second = await request<{ wasPublished: boolean; auditLogId: string | null }>(`/vendor/products/${product.p3.id}`, {
        method: 'DELETE',
        token: vendorA.token,
      });
      expect(second.status).toBe(200);
      expect(second.body).toMatchObject({ wasPublished: false, auditLogId: null });

      expect((await request(`/products/${product.p3.slug}`)).status).toBe(404);
      const row = await prisma.product.findUniqueOrThrow({ where: { id: product.p3.id }, include: { variants: true } });
      expect(row.isPublished).toBe(false);
      expect(row.variants).toHaveLength(1);
    });
  });

  // ─── 10. OpenAPI contract ─────────────────────────────────────────────────

  describe('OpenAPI documentation', () => {
    it('documents every Phase-5 endpoint, secured where it must be', () => {
      const document = buildOpenApiDocument(app) as unknown as {
        paths: Record<string, Record<string, { tags?: string[]; security?: unknown[]; responses: Record<string, unknown> }>>;
        tags?: Array<{ name: string }>;
      };
      const expected: Array<[string, string]> = [
        ['/api/v1/categories/tree', 'get'],
        ['/api/v1/categories/{slug}', 'get'],
        ['/api/v1/admin/categories', 'get'],
        ['/api/v1/admin/categories', 'post'],
        ['/api/v1/admin/categories/{id}', 'patch'],
        ['/api/v1/vendor/products', 'post'],
        ['/api/v1/vendor/products', 'get'],
        ['/api/v1/vendor/products/{id}', 'get'],
        ['/api/v1/vendor/products/{id}', 'patch'],
        ['/api/v1/vendor/products/{id}', 'delete'],
        ['/api/v1/vendor/products/{id}/variants', 'post'],
        ['/api/v1/vendor/products/variants/{variantId}', 'patch'],
        ['/api/v1/products', 'get'],
        ['/api/v1/products/{slug}', 'get'],
        ['/api/v1/admin/products', 'get'],
        ['/api/v1/admin/products/{id}/status', 'patch'],
      ];
      for (const [path, method] of expected) {
        const operation = document.paths[path]?.[method];
        expect(operation).toBeDefined();
        expect(operation!.tags?.length).toBeGreaterThan(0);
        expect(Object.keys(operation!.responses).length).toBeGreaterThan(0);
        const isPublic = path.startsWith('/api/v1/products') || path.startsWith('/api/v1/categories');
        if (isPublic) expect(operation!.security ?? []).toEqual([]);
        else expect(operation!.security?.length).toBeGreaterThan(0);
      }
      const tags = (document.tags ?? []).map((tag) => tag.name);
      expect(tags).toEqual(expect.arrayContaining(['categories', 'admin-categories', 'products', 'vendor-products', 'admin-products']));
    });
  });
});
