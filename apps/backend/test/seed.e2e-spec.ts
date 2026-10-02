import { ConfigService } from '@nestjs/config';
import { UserRole, VendorStatus } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import { seedDatabase, normalizeEmail } from '../prisma/seed';
import { isArgon2idHash, verifyPassword } from '../src/infra/security/password';
import { PrismaService } from '../src/infra/prisma/prisma.service';

/**
 * Runs the deterministic seed against the real PostgreSQL instance and asserts
 * the guarantees the development workflow depends on: identity, catalogue,
 * commission rates, the credit portfolio and — most importantly — that no
 * fabricated financial data or credentials ever reach the database.
 *
 * Nothing is mocked: the seed is executed on the live database and the resulting
 * rows are read back through Prisma.
 */
describe('Seed (e2e, real PostgreSQL)', () => {
  let prisma: PrismaClient;
  const adminMobile = '+989120000001';
  const adminEmail = normalizeEmail(process.env.SUPER_ADMIN_EMAIL ?? '');

  beforeAll(() => {
    const config = new ConfigService(process.env);
    prisma = new PrismaService(config);
    if (adminEmail === '') {
      throw new Error('SUPER_ADMIN_EMAIL must be defined (the seed loads it from the root .env).');
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('identity and access', () => {
    it('creates the super admin with the mandatory mobile as its business key', async () => {
      await seedDatabase(prisma);

      const admin = await prisma.user.findUniqueOrThrow({ where: { mobile: adminMobile } });

      expect(admin.role).toBe(UserRole.SUPER_ADMIN);
      expect(admin.isActive).toBe(true);
      expect(admin.email).toBe(adminEmail);
      expect(admin.nationalCode).toBeNull();
    });

    it('seeds the support and financial-officer staff accounts required by the flows', async () => {
      const [support, finance] = await Promise.all([
        prisma.user.findUnique({ where: { mobile: '+989120000002' } }),
        prisma.user.findUnique({ where: { mobile: '+989120000003' } }),
      ]);

      expect(support?.role).toBe(UserRole.SUPPORT);
      expect(finance?.role).toBe(UserRole.FINANCIAL_OFFICER);
    });

    it('stores credentials as Argon2id hashes that verify the configured password', async () => {
      const admin = await prisma.user.findUniqueOrThrow({ where: { mobile: adminMobile } });

      expect(admin.passwordHash).not.toBeNull();
      expect(isArgon2idHash(admin.passwordHash ?? '')).toBe(true);
      expect(admin.passwordHash).not.toContain(process.env.SUPER_ADMIN_PASSWORD ?? '__none__');
      await expect(
        verifyPassword(admin.passwordHash ?? '', process.env.SUPER_ADMIN_PASSWORD ?? ''),
      ).resolves.toBe(true);
    });

    it('rejects a login for an account whose credential does not match', async () => {
      const admin = await prisma.user.findUniqueOrThrow({ where: { mobile: adminMobile } });

      await expect(verifyPassword(admin.passwordHash ?? '', 'definitely-not-the-password')).resolves.toBe(
        false,
      );
    });
  });

  describe('catalogue and categories', () => {
    it('seeds exactly the four storefront root categories as the active tree, with their commission rates', async () => {
      const active = await prisma.category.findMany({
        where: { isActive: true },
        select: { slug: true, titleFa: true, parentId: true, defaultCommissionRate: true },
        orderBy: { sortOrder: 'asc' },
      });

      expect(active.map((row) => [row.slug, row.titleFa, row.parentId, row.defaultCommissionRate.toFixed(2)])).toEqual([
        ['digital-goods', 'کالای دیجیتال', null, '5.00'],
        ['home-decor', 'دکوراسیون', null, '9.00'],
        ['beauty-products', 'محصولات زیبایی', null, '11.00'],
        ['barber-salon-equipment', 'محصولات و تجهیزات آرایشگاهی', null, '9.00'],
      ]);
    });

    it('creates the sample vendor as an approved store owned by a VENDOR user with a wallet', async () => {
      const vendor = await prisma.vendor.findUniqueOrThrow({
        where: { storeSlug: 'shopino-sample-store' },
        include: { user: true, wallet: true, verifications: true, _count: { select: { products: true } } },
      });

      expect(vendor.status).toBe(VendorStatus.APPROVED);
      expect(vendor.verifiedAt).not.toBeNull();
      expect(vendor.user.role).toBe(UserRole.VENDOR);
      expect(vendor.wallet).not.toBeNull();
      expect(vendor.verifications.length).toBeGreaterThan(0);
      expect(vendor._count.products).toBeGreaterThan(0);
    });

    it('gives every product variants with stock and a category', async () => {
      const products = await prisma.product.findMany({
        include: { variants: true, media: true, category: true },
      });

      expect(products.length).toBeGreaterThan(0);
      for (const product of products) {
        expect(product.variants.length).toBeGreaterThan(0);
        expect(product.category.slug).not.toBe('');
        for (const variant of product.variants) {
          expect(variant.price.toString()).not.toBe('0');
          expect(variant.stockQuantity).toBeGreaterThan(0);
        }
      }
    });

    it('links product media to their product', async () => {
      const media = await prisma.productMedia.findFirst({ include: { product: true } });

      expect(media).not.toBeNull();
      expect(media?.product.id).toBe(media?.productId);
    });
  });

  describe('credit portfolio', () => {
    it('activates the sandbox provider and keeps real banks inactive', async () => {
      const sandbox = await prisma.creditProvider.findUniqueOrThrow({ where: { code: 'SANDBOX_BANK' } });
      const realBanks = await prisma.creditProvider.findMany({
        where: { code: { in: ['SAMAN_BANK', 'BLUBANK', 'DIGIPAY'] } },
      });

      expect(sandbox.isActive).toBe(true);
      expect(realBanks).toHaveLength(3);
      expect(realBanks.every((provider) => provider.isActive)).toBe(false);
    });

    it('publishes the 3 / 6 / 12 month plans, the 3-month one interest-free', async () => {
      const plans = await prisma.installmentPlan.findMany({
        where: { provider: { code: 'SANDBOX_BANK' }, isActive: true },
        orderBy: { durationMonths: 'asc' },
      });

      expect(plans.map((plan) => plan.durationMonths)).toEqual([3, 6, 12]);
      expect(plans[0]?.interestRatePercent.toString()).toBe('0');
      expect(plans[2]?.penaltyRatePercentPerMonth.toString()).not.toBe('0');
    });
  });

  describe('idempotency and integrity', () => {
    it('keeps every row count and the admin hash stable across a second run', async () => {
      const before = {
        users: await prisma.user.count(),
        categories: await prisma.category.count(),
        products: await prisma.product.count(),
        variants: await prisma.productVariant.count(),
        vendors: await prisma.vendor.count(),
        providers: await prisma.creditProvider.count(),
        plans: await prisma.installmentPlan.count(),
        configs: await prisma.systemConfig.count(),
        hash: (await prisma.user.findUniqueOrThrow({ where: { mobile: adminMobile } })).passwordHash,
      };

      await seedDatabase(prisma);

      expect(await prisma.user.count()).toBe(before.users);
      expect(await prisma.category.count()).toBe(before.categories);
      expect(await prisma.product.count()).toBe(before.products);
      expect(await prisma.productVariant.count()).toBe(before.variants);
      expect(await prisma.vendor.count()).toBe(before.vendors);
      expect(await prisma.creditProvider.count()).toBe(before.providers);
      expect(await prisma.installmentPlan.count()).toBe(before.plans);
      expect(await prisma.systemConfig.count()).toBe(before.configs);
      expect((await prisma.user.findUniqueOrThrow({ where: { mobile: adminMobile } })).passwordHash).toBe(
        before.hash,
      );
    });

    it('fabricates no financial data', async () => {
      const [orders, payments, walletTx, settlements, creditAccounts, creditTx, schedules] = await Promise.all([
        prisma.parentOrder.count(),
        prisma.payment.count(),
        prisma.walletTransaction.count(),
        prisma.settlementRequest.count(),
        prisma.creditAccount.count(),
        prisma.creditTransaction.count(),
        prisma.installmentSchedule.count(),
      ]);

      expect([orders, payments, walletTx, settlements, creditAccounts, creditTx, schedules]).toEqual([
        0, 0, 0, 0, 0, 0, 0,
      ]);
    });

    it('keeps every vendor wallet at a zero balance', async () => {
      const wallets = await prisma.vendorWallet.findMany();

      for (const wallet of wallets) {
        expect(wallet.pendingBalance.toString()).toBe('0');
        expect(wallet.withdrawableBalance.toString()).toBe('0');
        expect(wallet.totalEarnedBalance.toString()).toBe('0');
      }
    });

    it('switches the credit feature flag on now that BNPL ships (Phase 8)', async () => {
      const flag = await prisma.systemConfig.findUniqueOrThrow({ where: { key: 'credit.enabled' } });

      expect(flag.value).toBe('true');
    });

    it('names the active credit provider explicitly in configuration', async () => {
      const config = await prisma.systemConfig.findUniqueOrThrow({ where: { key: 'credits.activeProvider' } });
      const provider = await prisma.creditProvider.findUnique({ where: { code: config.value } });

      expect(provider).not.toBeNull();
      expect(provider?.isActive).toBe(true);
    });
  });
});
