import { Module } from '@nestjs/common';
import { CreditModule } from '../credit/credit.module';
import { OrdersModule } from '../orders/orders.module';
import { PaymentsModule } from '../payments/payments.module';
import { CreditCheckoutService } from './credit-checkout.service';
import { CreditPaymentsController } from './credit-payments.controller';
import { InstallmentOverdueScheduler } from './installment-overdue.scheduler';
import { InstallmentsController } from './installments.controller';
import { InstallmentsService } from './installments.service';

/** Buy-now-pay-later flows: credit / hybrid checkout and instalment repayment. */
@Module({
  imports: [CreditModule, OrdersModule, PaymentsModule],
  controllers: [CreditPaymentsController, InstallmentsController],
  providers: [CreditCheckoutService, InstallmentsService, InstallmentOverdueScheduler],
})
export class BnplModule {}
