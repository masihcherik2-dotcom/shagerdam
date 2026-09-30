import { Global, Module } from '@nestjs/common';
import { RedisService } from './redis.service';

/**
 * Global infrastructure module owning the single Redis connection of the
 * process. Feature modules (cache, rate limiting, queues) inject `RedisService`
 * from here.
 */
@Global()
@Module({
  providers: [RedisService],
  exports: [RedisService],
})
export class RedisModule {}
