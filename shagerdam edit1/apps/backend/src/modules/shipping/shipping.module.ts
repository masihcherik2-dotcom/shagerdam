import { Module } from '@nestjs/common';
import { ShippingCalculatorService } from './shipping-calculator.service';

/** Shipping-fee policy and calculation, shared by the cart (estimates) and checkout (charges). */
@Module({
  providers: [ShippingCalculatorService],
  exports: [ShippingCalculatorService],
})
export class ShippingModule {}
