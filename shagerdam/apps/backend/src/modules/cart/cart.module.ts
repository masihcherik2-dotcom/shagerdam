import { Module } from '@nestjs/common';
import { CategoriesModule } from '../categories/categories.module';
import { ShippingModule } from '../shipping/shipping.module';
import { CartController } from './cart.controller';
import { CartService } from './cart.service';

/** Guest and account carts. `CartService` is exported for checkout. */
@Module({
  imports: [CategoriesModule, ShippingModule],
  controllers: [CartController],
  providers: [CartService],
  exports: [CartService],
})
export class CartModule {}
