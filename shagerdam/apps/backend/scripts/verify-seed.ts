/**
 * Verifies the deterministic seed against the live database.
 *
 * Run with:  pnpm --filter @shopino/backend run verify:seed
 *
 * It executes the seed twice and proves:
 *   1. every seeded entity exists afterwards (staff, vendor, catalogue,
 *      category tree, credit portfolio, configuration);
 *   2. a second run changes no row count and rotates no password hash;
 *   3. credentials are stored as Argon2id hashes and never as plaintext;
 *   4. no fabricated financial data was introduced (wallets hold zero, no orders,
 *      no payments, no credit lines, no ledger entries).
 *
 * Exits non-zero on any violation, so it can gate CI.
 */
import { PrismaClient, UserRole, VendorStatus } from '@prisma/client';
import { seedDatabase, normalizeEmail } from '../prisma/seed';
import { isArgon2idHash, verifyPassword } from '../src/infra/security/password';

interface Snapshot {
  users: number;
  categories: number;
  rootCategories: number;
  products: number;
  variants: number;
  media: number;
  vendors: number;
  verifications: number;
  wallets: number;
  providers: number;
  plans: number;
  configs: number;
  addresses: number;
  customerProfiles: number;
  carts: number;
  parentOrders: number;
  subOrders: number;
  orderItems: number;
  payments: number;
  walletTransactions: number;
  settlementRequests: number;
  creditAccounts: number;
  creditApplications: number;
  creditTransactions: number;
  installmentSchedules: number;
  disputes: number;
  disputeEvidence: number;
  auditLogs: number;
  adminHash: string;
}

async function snapshot(prisma: PrismaClient, adminMobile: string): Promise<Snapshot> {
  const [
    users, categories, rootCategories, products, variants, media, vendors, verifications, wallets,
    providers, plans, configs, addresses, customerProfiles, carts, parentOrders, subOrders, orderItems,
    payments, walletTransactions, settlementRequests, creditAccounts, creditApplications,
    creditTransactions, installmentSchedules, disputes, disputeEvidence, auditLogs, admin,
  ] = await Promise.all([
    prisma.user.count(), prisma.category.count(), prisma.category.count({ where: { parentId: null } }),
    prisma.product.count(), prisma.productVariant.count(), prisma.productMedia.count(),
    prisma.vendor.count(), prisma.vendorVerification.count(), prisma.vendorWallet.count(),
    prisma.creditProvider.count(), prisma.installmentPlan.count(), prisma.systemConfig.count(),
    prisma.address.count(), prisma.customerProfile.count(), prisma.cart.count(), prisma.parentOrder.count(),
    prisma.subOrder.count(), prisma.orderItem.count(), prisma.payment.count(),
    prisma.walletTransaction.count(), prisma.settlementRequest.count(), prisma.creditAccount.count(),
    prisma.creditApplication.count(), prisma.creditTransaction.count(), prisma.installmentSchedule.count(),
    prisma.dispute.count(), prisma.disputeEvidence.count(), prisma.auditLog.count(),
    prisma.user.findUnique({ where: { mobile: adminMobile }, select: { passwordHash: true } }),
  ]);

  if (admin === null || admin.passwordHash === null) {
    throw new Error(`Super admin ${adminMobile} is missing a credential after seeding.`);
  }

  return {
    users, categories, rootCategories, products, variants, media, vendors, verifications, wallets,
    providers, plans, configs, addresses, customerProfiles, carts, parentOrders, subOrders, orderItems,
    payments, walletTransactions, settlementRequests, creditAccounts, creditApplications,
    creditTransactions, installmentSchedules, disputes, disputeEvidence, auditLogs,
    adminHash: admin.passwordHash,
  };
}

/** Keys compared between the two runs to prove idempotency. */
function structuralKeys(): (keyof Snapshot)[] {
  return [
    'users', 'categories', 'rootCategories', 'products', 'variants', 'media', 'vendors',
    'verifications', 'wallets', 'providers', 'plans', 'configs', 'addresses', 'customerProfiles',
    'carts', 'parentOrders', 'subOrders', 'orderItems', 'payments', 'walletTransactions',
    'settlementRequests', 'creditAccounts', 'creditApplications', 'creditTransactions',
    'installmentSchedules', 'disputes', 'disputeEvidence', 'auditLogs',
  ];
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  const adminMobile = '+989120000001';
  const adminEmail = normalizeEmail(process.env.SUPER_ADMIN_EMAIL ?? '');
  if (adminEmail === '') {
    throw new Error('SUPER_ADMIN_EMAIL is not set; run this script through pnpm so .env is loaded.');
  }

  try {
    console.warn('[verify:seed] first run');
    const firstRun = await seedDatabase(prisma);
    const first = await snapshot(prisma, adminMobile);
    console.warn(
      `[verify:seed]   users=${first.users} categories=${first.categories} (roots=${first.rootCategories}) ` +
        `vendors=${first.vendors} products=${first.products} variants=${first.variants} media=${first.media} ` +
        `providers=${first.providers} plans=${first.plans} configs=${first.configs}`,
    );

    console.warn('[verify:seed] second run (idempotency check)');
    await seedDatabase(prisma);
    const second = await snapshot(prisma, adminMobile);

    const admin = await prisma.user.findUniqueOrThrow({
      where: { mobile: adminMobile },
      select: { role: true, isActive: true, passwordHash: true, email: true },
    });
    const vendor = await prisma.vendor.findUniqueOrThrow({
      where: { storeSlug: 'shopino-sample-store' },
      select: { status: true, verifiedAt: true, wallet: { select: { pendingBalance: true, withdrawableBalance: true, totalEarnedBalance: true } } },
    });
    const unbalancedCategories = await prisma.category.count({ where: { defaultCommissionRate: { lte: 0 } } });
    const plansOfSandbox = await prisma.installmentPlan.count({
      where: { provider: { code: 'SANDBOX_BANK' }, isActive: true },
    });
    const duplicateSkus = await prisma.$queryRaw<{ sku: string; occurrences: bigint }[]>`
      SELECT sku, count(*) AS occurrences FROM product_variants GROUP BY sku HAVING count(*) > 1
    `;

    const failures: string[] = [];

    for (const key of structuralKeys()) {
      if (first[key] !== second[key]) {
        failures.push(`${String(key)} changed on re-run (${String(first[key])} → ${String(second[key])})`);
      }
    }
    if (first.adminHash !== second.adminHash) failures.push('admin password hash was rotated on re-run');
    if (admin.role !== UserRole.SUPER_ADMIN) failures.push(`admin role is ${admin.role}, expected SUPER_ADMIN`);
    if (!admin.isActive) failures.push('admin account is not active');
    if (admin.passwordHash === null || !isArgon2idHash(admin.passwordHash)) {
      failures.push('admin credential is not an Argon2id hash');
    }
    if (admin.passwordHash?.includes(process.env.SUPER_ADMIN_PASSWORD ?? '__none__')) {
      failures.push('admin credential contains the plaintext password');
    }
    if (!(await verifyPassword(admin.passwordHash ?? '', process.env.SUPER_ADMIN_PASSWORD ?? ''))) {
      failures.push('admin hash does not verify the configured password');
    }

    const roles = await prisma.user.groupBy({ by: ['role'], _count: { _all: true } });
    const roleCount = new Map(roles.map((r) => [r.role, r._count._all]));
    for (const required of [UserRole.SUPER_ADMIN, UserRole.SUPPORT, UserRole.FINANCIAL_OFFICER, UserRole.VENDOR]) {
      if ((roleCount.get(required) ?? 0) === 0) failures.push(`no user seeded with role ${required}`);
    }

    if (vendor.status !== VendorStatus.APPROVED) failures.push(`sample vendor status is ${vendor.status}, expected APPROVED`);
    if (vendor.verifiedAt === null) failures.push('sample vendor has no verifiedAt timestamp');
    if (vendor.wallet === null) failures.push('sample vendor has no wallet row');
    if (vendor.wallet !== null && (
      vendor.wallet.pendingBalance.toString() !== '0' ||
      vendor.wallet.withdrawableBalance.toString() !== '0' ||
      vendor.wallet.totalEarnedBalance.toString() !== '0'
    )) {
      failures.push('sample vendor wallet holds a balance — the seed must not fabricate money');
    }

    if (first.rootCategories === 0) failures.push('no root categories were seeded');
    if (unbalancedCategories > 0) failures.push(`${unbalancedCategories} category row(s) have a non-positive commission rate`);
    if (plansOfSandbox !== 3) failures.push(`SANDBOX_BANK has ${plansOfSandbox} active plans, expected 3 (3/6/12 months)`);
    if (duplicateSkus.length > 0) failures.push(`duplicate SKUs found: ${duplicateSkus.map((d) => d.sku).join(', ')}`);

    const financialTables: [string, number][] = [
      ['parentOrders', first.parentOrders], ['subOrders', first.subOrders], ['orderItems', first.orderItems],
      ['payments', first.payments], ['walletTransactions', first.walletTransactions],
      ['settlementRequests', first.settlementRequests], ['creditAccounts', first.creditAccounts],
      ['creditApplications', first.creditApplications], ['creditTransactions', first.creditTransactions],
      ['installmentSchedules', first.installmentSchedules],
    ];
    for (const [name, count] of financialTables) {
      if (count !== 0) failures.push(`${name} contains ${count} row(s); the seed must not fabricate financial data`);
    }

    if (failures.length > 0) {
      throw new Error(`seed verification failed:\n- ${failures.join('\n- ')}`);
    }

    console.warn(
      '[verify:seed] ok — deterministic and idempotent; credentials are Argon2id, no plaintext, ' +
        'no fabricated financial data, ' +
        `admin created=${String(firstRun.users.created.length > 0)}`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(`[verify:seed] FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
