import { Module } from '@nestjs/common';
import { TorobCacheModule } from '../integrations/torob/torob-cache.module';
import { AdminVendorsController } from './admin-vendors.controller';
import { VendorsController } from './vendors.controller';
import { VendorsService } from './vendors.service';

/**
 * Vendor onboarding, verification and profile management.
 *
 * KYC references are validated against `media_assets` through `PrismaService`
 * (the file must have been uploaded by the same account), so this module needs no
 * dependency on the media pipeline itself — it only stores what the pipeline
 * produced.
 */
@Module({
  imports: [TorobCacheModule],
  controllers: [VendorsController, AdminVendorsController],
  providers: [VendorsService],
  exports: [VendorsService],
})
export class VendorsModule {}
