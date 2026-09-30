import { Module } from '@nestjs/common';
import { CartModule } from '../cart/cart.module';
import { CategoriesModule } from '../categories/categories.module';
import { CreditModule } from '../credit/credit.module';
import { ProductsModule } from '../products/products.module';
import { ShippingModule } from '../shipping/shipping.module';
import { WalletModule } from '../wallet/wallet.module';
import { AdminOrdersController } from './admin-orders.controller';
import { CheckoutController } from './checkout.controller';
import { CheckoutService } from './checkout.service';
import { CustomerOrdersController } from './customer-orders.controller';
import { OrderExpiryScheduler } from './order-expiry.scheduler';
import { OrderLifecycleService } from './order-lifecycle.service';
import { OrderQueriesService } from './order-queries.service';
import { VendorOrdersController } from './vendor-orders.controller';

/**
 * Checkout, multi-vendor order splitting and the order lifecycle.
 * `OrderLifecycleService` is exported for the payment module
 * (applyPaymentLocked / markPaid); it moves wallet money through
 * `WalletLedgerService` inside its own transactions.
 */
@Module({
  imports: [CartModule, CategoriesModule, CreditModule, ProductsModule, ShippingModule, WalletModule],
  controllers: [CheckoutController, CustomerOrdersController, VendorOrdersController, AdminOrdersController],
  providers: [CheckoutService, OrderLifecycleService, OrderQueriesService, OrderExpiryScheduler],
  exports: [OrderLifecycleService],
})
export class OrdersModule {}
