import { Module } from '@nestjs/common';
import { CategoriesModule } from '../../categories/categories.module';
import { ShippingModule } from '../../shipping/shipping.module';
import { TorobCacheModule } from './torob-cache.module';
import { TorobController } from './torob.controller';
import { TorobFeedService } from './torob-feed.service';

/** Torob price-comparison feed: `GET /api/v1/integrations/torob/*`. */
@Module({
  imports: [CategoriesModule, ShippingModule, TorobCacheModule],
  controllers: [TorobController],
  providers: [TorobFeedService],
})
export class TorobIntegrationModule {}
