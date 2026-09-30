import { Module } from '@nestjs/common';
import { AdminCreditController } from './admin-credit.controller';
import { AdminCreditService } from './admin-credit.service';
import { CreditLedgerService } from './credit-ledger.service';
import { CreditOrderService } from './credit-order.service';
import { CreditController } from './credit.controller';
import { CreditService } from './credit.service';
import { CreditProviderRegistry } from './providers/credit-provider.registry';

/**
 * Credit engine core: provider registry (adapters resolved from the database),
 * the credit ledger, applications/accounts/plans and the order-side credit
 * operations. It depends on no other feature module, so Orders, Payments and
 * BNPL can import it without cycles.
 */
@Module({
  controllers: [CreditController, AdminCreditController],
  providers: [CreditProviderRegistry, CreditLedgerService, CreditOrderService, CreditService, AdminCreditService],
  exports: [CreditProviderRegistry, CreditLedgerService, CreditOrderService],
})
export class CreditModule {}
