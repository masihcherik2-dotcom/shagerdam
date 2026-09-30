import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditAction, ParentOrderPaymentStatus, PaymentMethod, Prisma, SubOrderStatus } from '@prisma/client';
import { conflictWith } from '../../common/http-errors';
import type { EnvironmentVariables } from '../../config/env.validation';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { evaluateLine, cartLineSelect, type EvaluatedLine } from '../cart/cart-view';
import { CategoriesService } from '../categories/categories.service';
import { InventoryService } from '../products/inventory.service';
import { ShippingCalculatorService } from '../shipping/shipping-calculator.service';
import { quoteShipping, type ShippingPolicy } from '../shipping/shipping-fee';
import type { CheckoutDto } from './dto/order-input.dto';
import type { CheckoutResponseDto } from './dto/order-response.dto';
import { lockParentOrder, stockMovements, writeOrderAudit, type OrderActor } from './order-audit';
import { effectiveCommissionRate, groupInOrder, lineTotal, parentTotals, subOrderTotals } from './order-math';
import { addressSnapshot, customerSubOrderSelect, toCustomerSubOrder, variantDetailsSnapshot } from './order-views';

type Tx = Prisma.TransactionClient;

interface PriceChange {
  cartItemId: string;
  productVariantId: string;
  productTitle: string;
  previousUnitPrice: string;
  currentUnitPrice: string;
}

interface BlockingLine {
  cartItemId: string;
  productVariantId: string;
  productTitle: string;
  requestedQuantity: number;
  availableQuantity: number;
  issues: string[];
}

/**
 * Turns the caller's cart into one parent order with one package (sub-order)
 * per store.
 *
 * Price and availability are evaluated twice: once before the transaction (so
 * a changed price can be written back to the cart and reported, which a rolled
 * back transaction could not do) and once inside it, under row locks, which is
 * the authoritative check. Inside the transaction:
 *
 * 1. the cart row is locked (no concurrent edits or double checkout);
 * 2. the variant rows are locked in id order (no deadlocks) and re-read;
 * 3. amounts are computed from live prices, category/store commission rates and
 *    the shipping policy;
 * 4. parent order, packages, item snapshots and initial status history are
 *    inserted, stock is reserved and the cart is emptied.
 *
 * Any failure rolls everything back: no order without reservation and no
 * reservation without order.
 */
@Injectable()
export class CheckoutService {
  private readonly paymentTimeoutMinutes: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly categories: CategoriesService,
    private readonly shipping: ShippingCalculatorService,
    private readonly inventory: InventoryService,
    config: ConfigService<EnvironmentVariables, true>,
  ) {
    this.paymentTimeoutMinutes = config.getOrThrow<number>('ORDER_PAYMENT_TIMEOUT_MINUTES');
  }

  async checkout(userId: string, dto: CheckoutDto, actor: OrderActor): Promise<CheckoutResponseDto> {
    const address = await this.prisma.address.findFirst({ where: { id: dto.addressId, userId } });
    if (!address) {
      throw new NotFoundException('Address not found');
    }
    const cart = await this.prisma.cart.findUnique({ where: { userId }, select: { id: true } });
    if (!cart) {
      throw conflictWith('CART_EMPTY', 'The cart is empty');
    }
    const [visibleIds, policy] = await Promise.all([this.categories.visibleCategoryIds(), this.shipping.loadPolicy()]);
    const visible = new Set(visibleIds);

    await this.precheck(cart.id, visible);

    const orderId = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM carts WHERE id = ${cart.id}::uuid FOR UPDATE`);
      const variantIds = (await tx.cartItem.findMany({ where: { cartId: cart.id }, select: { productVariantId: true } }))
        .map((row) => row.productVariantId)
        .sort();
      if (variantIds.length === 0) {
        throw conflictWith('CART_EMPTY', 'The cart is empty');
      }
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM product_variants WHERE id IN (${Prisma.join(variantIds.map((id) => Prisma.sql`${id}::uuid`))}) ORDER BY id FOR UPDATE`,
      );
      const rows = await tx.cartItem.findMany({
        where: { cartId: cart.id },
        select: cartLineSelect,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      const lines = rows.map((row) => evaluateLine(row, visible));
      assertCheckoutable(lines);

      return this.createOrder(tx, { userId, cartId: cart.id, lines, policy, dto, address: addressSnapshot(address), actor });
    });

    const created = await this.prisma.parentOrder.findUniqueOrThrow({
      where: { id: orderId },
      select: {
        id: true,
        orderNumber: true,
        paymentStatus: true,
        paymentMethod: true,
        totalItemsAmount: true,
        totalShippingFee: true,
        totalDiscountAmount: true,
        finalPayableAmount: true,
        paymentExpiresAt: true,
        subOrders: { select: customerSubOrderSelect, orderBy: { subOrderNumber: 'asc' } },
      },
    });
    return {
      parentOrderId: created.id,
      orderNumber: created.orderNumber,
      paymentStatus: created.paymentStatus,
      paymentMethod: created.paymentMethod,
      totalItemsAmount: created.totalItemsAmount.toFixed(2),
      totalShippingFee: created.totalShippingFee.toFixed(2),
      totalDiscountAmount: created.totalDiscountAmount.toFixed(2),
      finalPayableAmount: created.finalPayableAmount.toFixed(2),
      paymentExpiresAt: created.paymentExpiresAt,
      subOrders: created.subOrders.map(toCustomerSubOrder),
    };
  }

  /**
   * Non-locking pass. Unavailable lines stop checkout; changed prices are
   * written back to the cart (so the next attempt proceeds at the new price the
   * customer has now been shown) and reported with 409 CART_PRICES_CHANGED.
   */
  private async precheck(cartId: string, visible: ReadonlySet<string>): Promise<void> {
    const rows = await this.prisma.cartItem.findMany({ where: { cartId }, select: cartLineSelect });
    if (rows.length === 0) {
      throw conflictWith('CART_EMPTY', 'The cart is empty');
    }
    const lines = rows.map((row) => evaluateLine(row, visible));
    assertAvailable(lines);

    const changed = lines.filter((line) => line.priceChanged);
    if (changed.length === 0) {
      return;
    }
    await this.prisma.$transaction(
      changed.map((line) =>
        this.prisma.cartItem.update({ where: { id: line.row.id }, data: { unitPriceSnapshot: line.variant.price } }),
      ),
    );
    throw priceChangedError(changed);
  }

  private async createOrder(
    tx: Tx,
    input: {
      userId: string;
      cartId: string;
      lines: EvaluatedLine[];
      policy: ShippingPolicy;
      dto: CheckoutDto;
      address: ReturnType<typeof addressSnapshot>;
      actor: OrderActor;
    },
  ): Promise<string> {
    const [{ seq }] = await tx.$queryRaw<[{ seq: bigint }]>(Prisma.sql`SELECT nextval('parent_order_number_seq') AS seq`);
    const orderNumber = `SHP-${seq.toString()}`;

    const packages = groupInOrder(input.lines, (line) => line.variant.product.vendor.id).map((group, index) => {
      const vendor = group.items[0]!.variant.product.vendor;
      const priced = group.items.map((line) => ({
        line,
        unitPrice: line.variant.price,
        quantity: line.row.quantity,
        commissionRate: effectiveCommissionRate(vendor.commissionRateOverride, line.variant.product.category.defaultCommissionRate),
      }));
      const subtotal = priced.reduce((sum, item) => sum.add(lineTotal(item.unitPrice, item.quantity)), new Prisma.Decimal(0));
      const shipping = quoteShipping(subtotal, vendor, input.policy);
      return {
        vendor,
        subOrderNumber: `${orderNumber}-${index + 1}`,
        priced,
        totals: subOrderTotals(priced, shipping.fee),
      };
    });
    const totals = parentTotals(packages.map((pkg) => pkg.totals));
    const paymentExpiresAt = new Date(Date.now() + this.paymentTimeoutMinutes * 60_000);

    const order = await tx.parentOrder.create({
      data: {
        orderNumber,
        userId: input.userId,
        shippingAddressSnapshot: input.address as unknown as Prisma.InputJsonValue,
        ...totals,
        paymentMethod: PaymentMethod.CASH_IPG,
        paymentStatus: ParentOrderPaymentStatus.PENDING,
        customerNote: input.dto.customerNote ?? null,
        paymentExpiresAt,
        subOrders: {
          create: packages.map((pkg) => ({
            vendorId: pkg.vendor.id,
            subOrderNumber: pkg.subOrderNumber,
            ...pkg.totals,
            status: SubOrderStatus.PENDING_APPROVAL,
            items: {
              create: pkg.priced.map(({ line, unitPrice, quantity, commissionRate }) => ({
                productVariantId: line.variant.id,
                productTitleSnapshot: line.variant.product.title,
                vendorStoreNameSnapshot: pkg.vendor.storeName,
                skuSnapshot: line.variant.sku,
                variantDetailsSnapshot: variantDetailsSnapshot(line.variant) as unknown as Prisma.InputJsonValue,
                unitPriceSnapshot: unitPrice,
                commissionRateSnapshot: commissionRate,
                quantity,
                totalLineAmount: lineTotal(unitPrice, quantity),
              })),
            },
            statusHistory: {
              create: { fromStatus: null, toStatus: SubOrderStatus.PENDING_APPROVAL, actorUserId: input.userId, actorRole: 'CUSTOMER' },
            },
          })),
        },
      },
      select: { id: true },
    });

    // Rows are already locked; the guarded UPDATEs cannot fail on stock here,
    // but they stay the source of truth if they ever did (the transaction aborts).
    await lockParentOrder(tx, order.id);
    for (const move of stockMovements(input.lines.map((line) => ({ productVariantId: line.variant.id, quantity: line.row.quantity })))) {
      await this.inventory.reserve(move.variantId, move.quantity, tx);
    }

    await tx.cartItem.deleteMany({ where: { cartId: input.cartId } });
    await tx.cart.update({ where: { id: input.cartId }, data: { updatedAt: new Date() } });

    await writeOrderAudit(tx, input.actor, {
      action: AuditAction.CREATE,
      entityName: 'ParentOrder',
      entityId: order.id,
      newValue: {
        orderNumber,
        paymentStatus: ParentOrderPaymentStatus.PENDING,
        totalItemsAmount: totals.totalItemsAmount.toFixed(2),
        totalShippingFee: totals.totalShippingFee.toFixed(2),
        finalPayableAmount: totals.finalPayableAmount.toFixed(2),
        paymentExpiresAt: paymentExpiresAt.toISOString(),
        subOrders: packages.map((pkg) => ({
          subOrderNumber: pkg.subOrderNumber,
          vendorId: pkg.vendor.id,
          itemsSubtotal: pkg.totals.itemsSubtotal.toFixed(2),
          shippingFee: pkg.totals.shippingFee.toFixed(2),
          platformCommissionAmount: pkg.totals.platformCommissionAmount.toFixed(2),
          lines: pkg.priced.map((item) => ({ productVariantId: item.line.variant.id, quantity: item.quantity })),
        })),
      },
    });
    return order.id;
  }
}

function describeBlocking(line: EvaluatedLine): BlockingLine {
  return {
    cartItemId: line.row.id,
    productVariantId: line.variant.id,
    productTitle: line.variant.product.title,
    requestedQuantity: line.row.quantity,
    availableQuantity: line.available,
    issues: line.issues.filter((issue) => issue.code !== 'PRICE_CHANGED').map((issue) => issue.code),
  };
}

const isBlocking = (line: EvaluatedLine): boolean => !line.isPurchasable || line.available < line.row.quantity;

function assertAvailable(lines: EvaluatedLine[]): void {
  const blocking = lines.filter(isBlocking);
  if (blocking.length > 0) {
    throw conflictWith(
      'CART_NOT_CHECKOUTABLE',
      'Some items in the cart are unavailable or exceed the available stock; update the cart and try again',
      { lines: blocking.map(describeBlocking) },
    );
  }
}

function priceChangedError(changed: EvaluatedLine[]): ReturnType<typeof conflictWith> {
  const changes: PriceChange[] = changed.map((line) => ({
    cartItemId: line.row.id,
    productVariantId: line.variant.id,
    productTitle: line.variant.product.title,
    previousUnitPrice: line.row.unitPriceSnapshot.toFixed(2),
    currentUnitPrice: line.variant.price.toFixed(2),
  }));
  return conflictWith(
    'CART_PRICES_CHANGED',
    'Prices of some items have changed; the cart now shows the current prices. Review it and check out again',
    { changes },
  );
}

/** Authoritative check under locks: availability and unchanged prices. */
function assertCheckoutable(lines: EvaluatedLine[]): void {
  assertAvailable(lines);
  const changed = lines.filter((line) => line.priceChanged);
  if (changed.length > 0) {
    // Changed between the pre-check and the lock; the transaction rolls back and
    // the next attempt's pre-check refreshes the cart.
    throw priceChangedError(changed);
  }
}
