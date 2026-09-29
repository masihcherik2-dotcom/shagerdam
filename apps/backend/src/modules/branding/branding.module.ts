import { Module } from '@nestjs/common';
import { MediaModule } from '../media/media.module';
import { AdminBrandingController } from './admin-branding.controller';
import { BrandingController } from './branding.controller';
import { BrandingService } from './branding.service';

@Module({
  imports: [MediaModule],
  controllers: [BrandingController, AdminBrandingController],
  providers: [BrandingService],
  exports: [BrandingService],
})
export class BrandingModule {}
