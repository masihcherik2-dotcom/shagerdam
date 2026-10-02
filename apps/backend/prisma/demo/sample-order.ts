/**
 * Sample multi-store order for exercising order tracking and escrow —
 * DEVELOPMENT / TEST ONLY.
 *
 *   pnpm --filter @shopino/backend demo:sample-order
 *
 * The order is produced by the real business flows inside a Nest application
 * context, exactly as a shopper and three sellers would produce it:
 *   customer address → cart (3 items from 3 stores) → checkout (one
 *   parent order, one sub-order per store, stock reserved) → payment through
 *   the SANDBOX bank (initiate → settle PAY → verified callback; stock
 *   committed, escrow ledger entries written) → sellers move their sub-orders:
 *     #1 PROCESSING
 *     #2 PROCESSING → SHIPPED (tracking code)
 *     #3 PROCESSING → SHIPPED → DELIVERED (confirmed by the customer, which
 *        starts the escrow hold period of that store's share).
 *
 * Refuses to run when NODE_ENV=production or when the active payment gateway is
 * not the sandbox: a real order would pollute production finance and would need
 * real money. Idempotent: if the sample customer already has an order, nothing
 * is created again.
 *
 * Needs the demo catalogue in `live` visibility (SEED_PROFILE=demo in development).
 */
import { NestFactory } from '@nestjs/core';
import { SubOrderStatus, UserRole } from '@prisma/client';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/infra/prisma/prisma.service';
import { AddressesService } from '../../src/modules/addresses/addresses.service';
import { CartService } from '../../src/modules/cart/cart.service';
import { CheckoutService } from '../../src/modules/orders/checkout.service';
import { OrderLifecycleService } from '../../src/modules/orders/order-lifecycle.service';
import { PAYMENT_GATEWAY, type PaymentGatewayProvider } from '../../src/modules/payments/gateway/payment-gateway.interface';
import { SandboxPaymentGatewayProvider } from '../../src/modules/payments/gateway/sandbox-payment-gateway.provider';
import { PaymentsService } from '../../src/modules/payments/payments.service';

export const SAMPLE_CUSTOMER_MOBILE = '+989120000030';
/**
 * One item per store: the two demo stores plus the sample vendor of the
 * development base seed (`SEED_PROFILE=demo` outside production loads both).
 */
const SAMPLE_PRODUCTS = ['demo-powerbank-20000', 'demo-sunscreen-spf50', 'shopino-sample-velvet-cushion'] as const;
const CONTEXT = { ipAddress: null, userAgent: 'demo-sample-order' };

export interface SampleOrderResult {
  created: boolean;
  orderNumber: string;
  subOrders: { subOrderNumber: string; status: SubOrderStatus; trackingCode: string | null }[];
}

export async function createSampleOrder(env: NodeJS.ProcessEnv = process.env): Promise<SampleOrderResult> {
  if (env.NODE_ENV === 'production') {
    throw new Error('The sample order is development/test data and is never created in production.');
  }
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const prisma = app.get(PrismaService);
    const gateway = app.get<PaymentGatewayProvider>(PAYMENT_GATEWAY);
    if (!(gateway instanceof SandboxPaymentGatewayProvider)) {
      throw new Error(`The active payment gateway is "${gateway.name}"; the sample order is paid only through the sandbox bank.`);
    }

    const customer = await prisma.user.upsert({
      where: { mobile: SAMPLE_CUSTOMER_MOBILE },
      update: {},
      create: { mobile: SAMPLE_CUSTOMER_MOBILE, fullName: 'مشتری نمونه', role: UserRole.CUSTOMER },
      select: { id: true },
    });
    const actor = { actorId: customer.id, context: CONTEXT };

    const existing = await prisma.parentOrder.findFirst({ where: { userId: customer.id }, orderBy: { createdAt: 'asc' }, select: { id: true } });
    if (existing) {
      return { created: false, ...(await describe(prisma, existing.id)) };
    }

    const address =
      (await prisma.address.findFirst({ where: { userId: customer.id }, select: { id: true } })) ??
      (await app.get(AddressesService).create(
        customer.id,
        {
          province: 'تهران',
          city: 'تهران',
          postalAddress: 'خیابان ولیعصر، بالاتر از میدان ونک، کوچهٔ نمونه',
          postalCode: '1969833111',
          buildingNumber: '12',
          unitNumber: '3',
          recipientName: 'مشتری نمونه',
          recipientMobile: '09120000030',
          isDefault: true,
        },
        actor,
      ));

    const cart = app.get(CartService);
    await cart.clear({ userId: customer.id });
    for (const slug of SAMPLE_PRODUCTS) {
      const variant = await prisma.productVariant.findFirst({
        where: { product: { slug, isPublished: true }, isActive: true },
        orderBy: { sku: 'asc' },
        select: { id: true },
      });
      if (!variant) {
        throw new Error(`Published demo product "${slug}" not found — load the demo catalogue with SEED_PROFILE=demo (live) first.`);
      }
      await cart.addItem({ userId: customer.id }, { productVariantId: variant.id, quantity: 1 });
    }

    const order = await app.get(CheckoutService).checkout(customer.id, { addressId: address.id, customerNote: 'سفارش نمونه برای آزمایش پیگیری مرسوله و امانت وجه' }, actor);

    const payments = app.get(PaymentsService);
    const initiated = await payments.initiate(customer.id, order.parentOrderId, actor);
    const { redirectTo } = await gateway.settle(initiated.paymentId, 'PAY');
    const callback = new URL(redirectTo);
    await payments.handleCallback({ Authority: callback.searchParams.get('Authority'), Status: callback.searchParams.get('Status') }, actor);

    const lifecycle = app.get(OrderLifecycleService);
    const subs = await prisma.subOrder.findMany({
      where: { parentOrderId: order.parentOrderId },
      orderBy: { subOrderNumber: 'asc' },
      select: { id: true, vendor: { select: { userId: true } } },
    });
    for (const [index, sub] of subs.entries()) {
      const seller = { actorId: sub.vendor.userId, context: CONTEXT };
      await lifecycle.vendorTransition(sub.vendor.userId, sub.id, { status: SubOrderStatus.PROCESSING }, seller);
      if (index >= 1) {
        await lifecycle.vendorTransition(
          sub.vendor.userId,
          sub.id,
          { status: SubOrderStatus.SHIPPED, trackingCode: `DEMO${String(700000000 + index)}`, shippingCarrier: 'پست پیشتاز' },
          seller,
        );
      }
      if (index >= 2) {
        await lifecycle.confirmDeliveryByCustomer(customer.id, order.parentOrderId, sub.id, actor);
      }
    }

    return { created: true, ...(await describe(prisma, order.parentOrderId)) };
  } finally {
    await app.close();
  }
}

async function describe(prisma: PrismaService, parentOrderId: string): Promise<Omit<SampleOrderResult, 'created'>> {
  const order = await prisma.parentOrder.findUniqueOrThrow({
    where: { id: parentOrderId },
    select: { orderNumber: true, subOrders: { orderBy: { subOrderNumber: 'asc' }, select: { subOrderNumber: true, status: true, trackingCode: true } } },
  });
  return { orderNumber: order.orderNumber, subOrders: order.subOrders };
}

if (require.main === module) {
  createSampleOrder()
    .then((result) => {
      console.warn(
        `[demo] sample order ${result.orderNumber} ${result.created ? 'created' : 'already exists'}: ` +
          result.subOrders.map((sub) => `${sub.subOrderNumber}=${sub.status}${sub.trackingCode ? ` (${sub.trackingCode})` : ''}`).join(', '),
      );
    })
    .catch((error: unknown) => {
      console.error(`[demo] sample order FAILED: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
