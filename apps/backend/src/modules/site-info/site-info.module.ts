import { Module } from '@nestjs/common';
import { AdminSiteInfoController } from './admin-site-info.controller';
import { SiteInfoController } from './site-info.controller';
import { SiteInfoService } from './site-info.service';

@Module({
  controllers: [SiteInfoController, AdminSiteInfoController],
  providers: [SiteInfoService],
  exports: [SiteInfoService],
})
export class SiteInfoModule {}
