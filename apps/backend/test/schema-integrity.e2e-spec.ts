import { ConfigService } from '@nestjs/config';
import {
  CreditTransactionType,
  DisputeReason,
  PaymentMethod,
  PaymentStatus,
  Prisma,
  SubOrderStatus,
  UserRole,
  WalletBalanceBucket,
  WalletTransactionType,
} from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/infra/prisma/prisma.service';

/**
 * Thrown at the end of a transaction to roll it back. PostgreSQL aborts an
 * entire transaction after any failed statement ("current transaction is
 * aborted"), so every negative assertion below runs in its own transaction whose
 * only job is to fail: the check proves the constraint and the rollback keeps the
 * database pristine.
 */
class Rollback extends Error {
  constructor() {
    super('intentional rollback');
    this.name = 'Rollback';
  }
}

const UNIQUE_VIOLATION = /Unique constraint failed|duplicate key value/i;
// Prisma reports referential violations as either "Foreign key constraint
// violated on the constraint: <name>" or "Foreign key constraint failed".
const FK_VIOLATION = /foreign key constraint (failed|violated)/i;

function userInput(
  mobile: string,
  role: UserRole = UserRole.CUSTOMER,
): { mobile: string; fullName: string; role: UserRole } {
  return { mobile, fullName: `کاربر ${mobile}`, role };
}

/**
 * Exercises the Phase-2 schema against the live PostgreSQL instance: relations,
 * cascade rules, SET NULL behaviour, unique constraints, immutable snapshots and
 * the ledger shapes of both the vendor wallet and the credit line.
 *
 * Nothing is left behind: every scenario runs in a transaction that is rolled
 * back, and the final test asserts the database is exactly as the seed left it.
 */
describe('Phase-2 schema integrity (e2e, real PostgreSQL, rolled back)', () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = new PrismaService(new ConfigService(process.env));
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('builds the full order → sub-order → line graph with snapshots and both ledgers', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        // ── identity ────────────────────────────────────────────────────────
        const customer = await tx.user.create({ data: userInput('09990000001') });
        const address = await tx.address.create({
          data: {
            userId: customer.id,
            province: 'تهران',
            city: 'تهران',
            postalAddress: 'خیابان نمونه، پلاک ۱۲',
            postalCode: '1234567890',
            buildingNumber: '12',
            unitNumber: '3',
            recipientName: 'گیرندهٔ نمونه',
            recipientMobile: '09990000001',
            isDefault: true,
          },
        });
        await tx.customerProfile.create({
          data: { userId: customer.id, bankIban: 'IR120570000000000000000001', defaultAddressId: address.id },
        });

        // ── cart ────────────────────────────────────────────────────────────
        const cart = await tx.cart.create({ data: { userId: customer.id } });
        const variant = await tx.productVariant.findFirstOrThrow({
          where: { stockQuantity: { gt: 0 } },
          include: { product: { include: { vendor: true } } },
        });
        const quantity = 2;
        await tx.cartItem.create({
          data: { cartId: cart.id, productVariantId: variant.id, quantity, unitPriceSnapshot: variant.price },
        });

        // ── money split (Decimal arithmetic end to end, no floating point) ───
        const unitPrice = variant.price;
        const itemsSubtotal = unitPrice.mul(quantity);
        const shippingFee = new Prisma.Decimal('150000');
        const commissionRate = new Prisma.Decimal('8.00');
        const commission = itemsSubtotal.mul(commissionRate).div(100);
        const vendorEarnings = itemsSubtotal.sub(commission);
        const finalPayable = itemsSubtotal.add(shippingFee);

        const order = await tx.parentOrder.create({
          data: {
            orderNumber: 'SHP-990000001',
            userId: customer.id,
            shippingAddressSnapshot: {
              province: address.province,
              city: address.city,
              postalCode: address.postalCode,
              recipientName: address.recipientName,
              recipientMobile: address.recipientMobile,
            },
            totalItemsAmount: itemsSubtotal,
            totalShippingFee: shippingFee,
            totalDiscountAmount: '0',
            finalPayableAmount: finalPayable,
            paymentMethod: PaymentMethod.HYBRID,
            paymentStatus: 'PAID',
          },
        });

        const subOrder = await tx.subOrder.create({
          data: {
            parentOrderId: order.id,
            vendorId: variant.product.vendorId,
            subOrderNumber: 'SHP-990000001-1',
            itemsSubtotal,
            shippingFee,
            platformCommissionAmount: commission,
            vendorEarningsAmount: vendorEarnings,
            status: SubOrderStatus.DELIVERED,
            deliveredAt: new Date(),
          },
        });

        const line = await tx.orderItem.create({
          data: {
            subOrderId: subOrder.id,
            productVariantId: variant.id,
            productTitleSnapshot: variant.product.title,
            vendorStoreNameSnapshot: variant.product.vendor.storeName,
            skuSnapshot: variant.sku,
            variantDetailsSnapshot: {
              colorName: variant.colorName,
              colorHex: variant.colorHex,
              size: variant.size,
              guarantee: variant.guarantee,
            },
            unitPriceSnapshot: unitPrice,
            discountSnapshot: '0',
            commissionRateSnapshot: commissionRate,
            quantity,
            totalLineAmount: itemsSubtotal,
          },
        });

        // ── payment split: must add up to the payable amount (whole rials) ───
        const cashAmount = finalPayable.mul('0.4').floor();
        const creditAmount = finalPayable.sub(cashAmount);
        expect(cashAmount.add(creditAmount).toString()).toBe(finalPayable.toString());

        // ── vendor escrow ledger ────────────────────────────────────────────
        const wallet = await tx.vendorWallet.findFirstOrThrow({ where: { vendorId: variant.product.vendorId } });
        // Bucket ledger (Phase 7): the hold credits PENDING; the release is a
        // pair of rows (PENDING −, WITHDRAWABLE +) that sums to zero.
        await tx.walletTransaction.create({
          data: {
            walletId: wallet.id,
            subOrderId: subOrder.id,
            type: WalletTransactionType.CREDIT_SALE_ESCROW_HOLD,
            bucket: WalletBalanceBucket.PENDING,
            amount: vendorEarnings,
            balanceAfter: wallet.pendingBalance.add(vendorEarnings),
            description: 'نگه‌داری وجه فروش در حساب امانی',
          },
        });
        await tx.walletTransaction.create({
          data: {
            walletId: wallet.id,
            subOrderId: subOrder.id,
            type: WalletTransactionType.ESCROW_RELEASE_TO_WITHDRAWABLE,
            bucket: WalletBalanceBucket.PENDING,
            amount: vendorEarnings.negated(),
            balanceAfter: wallet.pendingBalance,
            description: 'آزادسازی وجه پس از تأیید تحویل',
          },
        });
        const released = await tx.walletTransaction.create({
          data: {
            walletId: wallet.id,
            subOrderId: subOrder.id,
            type: WalletTransactionType.ESCROW_RELEASE_TO_WITHDRAWABLE,
            bucket: WalletBalanceBucket.WITHDRAWABLE,
            amount: vendorEarnings,
            balanceAfter: wallet.withdrawableBalance.add(vendorEarnings),
            description: 'آزادسازی وجه پس از تأیید تحویل',
          },
        });
        await tx.vendorWallet.update({
          where: { id: wallet.id },
          data: {
            withdrawableBalance: wallet.withdrawableBalance.add(vendorEarnings),
            totalEarnedBalance: wallet.totalEarnedBalance.add(vendorEarnings),
          },
        });
        await tx.subOrder.update({ where: { id: subOrder.id }, data: { escrowReleasedAt: new Date() } });
        expect(released.balanceAfter.toString()).toBe(vendorEarnings.toString());

        // ── credit line, ledger and instalments ─────────────────────────────
        const provider = await tx.creditProvider.findFirstOrThrow({ where: { isActive: true } });
        const totalLimit = new Prisma.Decimal('100000000');
        const account = await tx.creditAccount.create({
          data: {
            userId: customer.id,
            providerId: provider.id,
            totalLimit,
            usedAmount: '0',
            reservedAmount: creditAmount,
            // Consumed by the credit service at checkout; reduced as the purchase commits.
            availableAmount: totalLimit.sub(creditAmount),
            status: 'ACTIVE',
          },
        });

        await tx.creditTransaction.create({
          data: {
            creditAccountId: account.id,
            parentOrderId: order.id,
            type: CreditTransactionType.PURCHASE_RESERVE_HOLD,
            amount: creditAmount,
            balanceAfter: totalLimit.sub(creditAmount),
            referenceCode: 'SHP-990000001',
          },
        });

        const plan = await tx.installmentPlan.findFirstOrThrow({
          where: { providerId: provider.id, durationMonths: 3 },
        });
        // Phase 8 shape: a HYBRID attempt carries its credit part (account, plan, reservation ref).
        await tx.payment.create({
          data: {
            parentOrderId: order.id,
            paymentMethod: 'HYBRID',
            creditAccountId: account.id,
            installmentPlanId: plan.id,
            creditReservationRef: 'SHP-990000001',
            gatewayName: 'SANDBOX',
            gatewayTrackingToken: 'SBX-TRACK-0001',
            bankRrn: '123456789012',
            cashAmount,
            creditAmount,
            status: PaymentStatus.SUCCESSFUL,
            paidAt: new Date(),
          },
        });
        const perInstalment = creditAmount.div(plan.durationMonths).toDecimalPlaces(2);
        await tx.installmentSchedule.createMany({
          data: [1, 2, 3].map((number) => ({
            parentOrderId: order.id,
            creditAccountId: account.id,
            installmentNumber: number,
            totalInstallments: plan.durationMonths,
            dueDate: new Date(Date.UTC(2027, number, 1)),
            principalAmount: perInstalment,
            interestAmount: '0',
            totalAmount: perInstalment,
          })),
        });
        expect(await tx.installmentSchedule.count({ where: { parentOrderId: order.id } })).toBe(3);

        // ── dispute + evidence ──────────────────────────────────────────────
        const dispute = await tx.dispute.create({
          data: {
            subOrderId: subOrder.id,
            vendorId: subOrder.vendorId,
            subOrderStatusAtOpen: SubOrderStatus.DELIVERED,
            raisedByUserId: customer.id,
            reason: DisputeReason.DAMAGED,
            description: 'بسته با آسیب فیزیکی تحویل داده شد.',
          },
        });
        await tx.disputeEvidence.create({
          data: {
            disputeId: dispute.id,
            uploadedByUserId: customer.id,
            fileUrl: 'https://cdn.shopino.local/disputes/990000001/photo.jpg',
            fileType: 'image/jpeg',
            caption: 'تصویر بستهٔ آسیب‌دیده',
          },
        });

        // ── audit trail ─────────────────────────────────────────────────────
        await tx.auditLog.create({
          data: {
            userId: customer.id,
            action: 'CREATE',
            entityName: 'ParentOrder',
            entityId: order.id,
            ipAddress: '127.0.0.1',
            userAgent: 'jest-e2e',
            newValue: { orderNumber: order.orderNumber, finalPayableAmount: finalPayable.toString() },
          },
        });

        // ── invariants the service layer must preserve ──────────────────────
        const storedSubOrder = await tx.subOrder.findUniqueOrThrow({ where: { id: subOrder.id } });
        expect(storedSubOrder.platformCommissionAmount.add(storedSubOrder.vendorEarningsAmount).toString()).toBe(
          storedSubOrder.itemsSubtotal.toString(),
        );
        expect(line.productTitleSnapshot).toBe(variant.product.title);
        expect((await tx.creditAccount.findUniqueOrThrow({ where: { id: account.id } })).availableAmount.add(creditAmount).toString()).toBe(
          totalLimit.toString(),
        );

        // ── SET NULL: removing a variant keeps order history readable ───────
        await tx.productVariant.delete({ where: { id: variant.id } });
        const survivingLine = await tx.orderItem.findUniqueOrThrow({ where: { id: line.id } });
        expect(survivingLine.productVariantId).toBeNull();
        expect(survivingLine.productTitleSnapshot).toBe(variant.product.title);
        expect(survivingLine.unitPriceSnapshot.toString()).toBe(unitPrice.toString());

        // ── CASCADE: deleting the cart removes its lines ────────────────────
        await tx.cart.delete({ where: { id: cart.id } });
        expect(await tx.cartItem.count({ where: { cartId: cart.id } })).toBe(0);

        throw new Rollback();
      }),
    ).rejects.toThrow(Rollback);
  });

  it('enforces unique identity and catalogue keys in the database', async () => {
    // `mobile` is the identity key (canonical E.164): a duplicate insert must be
    // rejected by SQL.
    await expect(prisma.user.create({ data: userInput('+989120000001') })).rejects.toThrow(UNIQUE_VIOLATION);

    // The same human number written the national way is a *different* string, so
    // it must be normalized before it reaches the database — this assertion is
    // what makes that rule explicit.
    await expect(prisma.user.findUnique({ where: { mobile: '09120000001' } })).resolves.toBeNull();

    // SKUs are globally unique across the catalogue.
    const variant = await prisma.productVariant.findFirstOrThrow();
    await expect(
      prisma.productVariant.create({
        data: { productId: variant.productId, sku: variant.sku, price: '1000' },
      }),
    ).rejects.toThrow(UNIQUE_VIOLATION);

    // Vendor store slugs are unique.
    const vendor = await prisma.vendor.findFirstOrThrow();
    await expect(
      prisma.vendor.create({
        data: {
          userId: vendor.userId,
          storeName: 'فروشگاه تکراری',
          storeSlug: vendor.storeSlug,
          bankIban: 'IR120570000000000000000002',
        },
      }),
    ).rejects.toThrow(UNIQUE_VIOLATION);

    // Category slugs are unique.
    const category = await prisma.category.findFirstOrThrow();
    await expect(
      prisma.category.create({
        data: { slug: category.slug, titleFa: category.titleFa, defaultCommissionRate: '10.00' },
      }),
    ).rejects.toThrow(UNIQUE_VIOLATION);
  });

  it('protects financial records with RESTRICT and removes owned children with CASCADE', async () => {
    const vendor = await prisma.vendor.findFirstOrThrow({ where: { products: { some: {} } } });

    // A vendor that sells through the platform must not be deletable: the
    // catalogue, sub-orders and wallet all point at it.
    await expect(prisma.vendor.delete({ where: { id: vendor.id } })).rejects.toThrow(FK_VIOLATION);

    // A parent order with payments cannot be deleted either.
    await expect(
      prisma.$transaction(async (tx) => {
        const owner = await tx.user.create({ data: userInput('09990000002') });
        const order = await tx.parentOrder.create({
          data: {
            orderNumber: 'SHP-990000002',
            userId: owner.id,
            shippingAddressSnapshot: { city: 'تهران' },
            totalItemsAmount: '1000',
            finalPayableAmount: '1000',
            paymentMethod: PaymentMethod.CASH_IPG,
          },
        });
        await tx.payment.create({
          data: { parentOrderId: order.id, gatewayName: 'SANDBOX', cashAmount: '1000' },
        });
        await expect(tx.parentOrder.delete({ where: { id: order.id } })).rejects.toThrow(FK_VIOLATION);
        throw new Rollback();
      }),
    ).rejects.toThrow(Rollback);

    // Deleting a user cascades to their addresses (owned data).
    await expect(
      prisma.$transaction(async (tx) => {
        const owner = await tx.user.create({ data: userInput('09990000003') });
        await tx.address.create({
          data: {
            userId: owner.id,
            province: 'تهران',
            city: 'تهران',
            postalAddress: 'نشانی موقت',
            postalCode: '1111111111',
            recipientName: 'گیرنده',
            recipientMobile: '09990000003',
          },
        });
        expect(await tx.address.count({ where: { userId: owner.id } })).toBe(1);
        await tx.user.delete({ where: { id: owner.id } });
        expect(await tx.address.count({ where: { userId: owner.id } })).toBe(0);
        throw new Rollback();
      }),
    ).rejects.toThrow(Rollback);
  });

  it('rejects a duplicate instalment number inside one schedule', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        const owner = await tx.user.create({ data: userInput('09990000004') });
        const provider = await tx.creditProvider.findFirstOrThrow({ where: { isActive: true } });
        const account = await tx.creditAccount.create({
          data: {
            userId: owner.id,
            providerId: provider.id,
            totalLimit: '50000000',
            availableAmount: '50000000',
          },
        });
        const order = await tx.parentOrder.create({
          data: {
            orderNumber: 'SHP-990000003',
            userId: owner.id,
            shippingAddressSnapshot: { city: 'تهران' },
            totalItemsAmount: '1000',
            finalPayableAmount: '1000',
            paymentMethod: PaymentMethod.BANK_CREDIT,
          },
        });
        const base = {
          parentOrderId: order.id,
          creditAccountId: account.id,
          installmentNumber: 1,
          totalInstallments: 3,
          dueDate: new Date(Date.UTC(2027, 1, 1)),
          principalAmount: new Prisma.Decimal('1000'),
          totalAmount: new Prisma.Decimal('1000'),
        };
        await tx.installmentSchedule.create({ data: base });
        // (parentOrderId, installmentNumber) is unique — the second insert must fail.
        await expect(tx.installmentSchedule.create({ data: base })).rejects.toThrow(UNIQUE_VIOLATION);
        throw new Rollback();
      }),
    ).rejects.toThrow(Rollback);
  });

  it('leaves no fabricated financial data behind and keeps the seeded rows intact', async () => {
    const [
      orders,
      payments,
      lines,
      disputes,
      creditTransactions,
      creditAccounts,
      schedules,
      walletTransactions,
      settlementRequests,
      users,
      variants,
    ] = await Promise.all([
      prisma.parentOrder.count(),
      prisma.payment.count(),
      prisma.orderItem.count(),
      prisma.dispute.count(),
      prisma.creditTransaction.count(),
      prisma.creditAccount.count(),
      prisma.installmentSchedule.count(),
      prisma.walletTransaction.count(),
      prisma.settlementRequest.count(),
      prisma.user.count(),
      prisma.productVariant.count(),
    ]);

    // The rollback left nothing behind: no order, payment, ledger entry, credit
    // line or instalment exists in the database.
    expect([
      orders,
      payments,
      lines,
      disputes,
      creditTransactions,
      creditAccounts,
      schedules,
      walletTransactions,
      settlementRequests,
    ]).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0]);

    // `audit_logs` is deliberately **not** asserted to be empty any more: the
    // audit engine (Phase 3) writes a row for every mutating request, including
    // the ones the other e2e suites make. The invariant that still holds is that
    // auditing is append-only — nothing here updates or deletes a trail row.

    // Seeded identity and catalogue rows are untouched: 4 users (super admin,
    // support, finance, vendor owner) and 7 catalogue variants. The auth suite
    // creates its own customers and removes them again in its cleanup.
    expect(users).toBe(4);
    expect(variants).toBe(7);
  });
});
