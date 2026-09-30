import { Module } from '@nestjs/common';
import { VendorWalletController } from './vendor-wallet.controller';
import { WalletLedgerService } from './wallet-ledger.service';
import { WalletService } from './wallet.service';

/**
 * Vendor escrow wallets. `WalletLedgerService` is exported for the modules that
 * move money (orders lifecycle, settlements); it depends on nothing but the
 * caller's transaction, so no module cycle is possible.
 */
@Module({
  controllers: [VendorWalletController],
  providers: [WalletLedgerService, WalletService],
  exports: [WalletLedgerService, WalletService],
})
export class WalletModule {}
