import { Module } from '@nestjs/common';
import { TorobFeedCacheService } from './torob-feed-cache.service';

/**
 * The feed cache on its own, so the modules that change prices and stock
 * (products, inventory, vendors) can invalidate it without depending on the
 * Torob feed module — and without an import cycle.
 */
@Module({
  providers: [TorobFeedCacheService],
  exports: [TorobFeedCacheService],
})
export class TorobCacheModule {}
