import { Module } from '@nestjs/common';
import { WalletModule } from '../wallet/wallet.module';
import { AdminSettlementsController } from './admin-settlements.controller';
import { SettlementsService } from './settlements.service';
import { VendorSettlementsController } from './vendor-settlements.controller';

@Module({
  imports: [WalletModule],
  controllers: [VendorSettlementsController, AdminSettlementsController],
  providers: [SettlementsService],
  exports: [SettlementsService],
})
export class SettlementsModule {}
