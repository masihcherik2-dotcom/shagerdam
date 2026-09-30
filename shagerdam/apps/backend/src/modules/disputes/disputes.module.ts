import { Module } from '@nestjs/common';
import { OrdersModule } from '../orders/orders.module';
import { SmsModule } from '../sms/sms.module';
import { WalletModule } from '../wallet/wallet.module';
import { AdminDisputesController } from './admin-disputes.controller';
import { CustomerDisputesController } from './customer-disputes.controller';
import { DisputeNotifier } from './dispute-notifier';
import { DisputeQueriesService } from './dispute-queries.service';
import { DisputesService } from './disputes.service';
import { VendorDisputesController } from './vendor-disputes.controller';

/**
 * Disputes (Phase 9): customer complaints about a package, the store's answer,
 * staff arbitration, and the escrow freeze / release / refund that follows.
 * Money moves through WalletLedgerService; the package status through
 * OrderLifecycleService, so the wallet ledger and the order state machine stay
 * the only writers of their tables.
 */
@Module({
  imports: [OrdersModule, WalletModule, SmsModule],
  controllers: [CustomerDisputesController, VendorDisputesController, AdminDisputesController],
  providers: [DisputesService, DisputeQueriesService, DisputeNotifier],
})
export class DisputesModule {}
