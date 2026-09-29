import { Injectable } from '@nestjs/common';
import { HealthIndicator, type HealthIndicatorResult } from '@nestjs/terminus';
import { errorMessage } from '../../../common/utils';
import { RedisService } from '../../redis/redis.service';

/** Verifies that Redis answers an authenticated `PING`. */
@Injectable()
export class RedisHealthIndicator extends HealthIndicator {
  constructor(private readonly redis: RedisService) {
    super();
  }

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    try {
      const latencyMs = await this.redis.ping();
      return this.getStatus(key, true, { latency_ms: latencyMs });
    } catch (error) {
      return this.getStatus(key, false, { message: errorMessage(error) });
    }
  }
}
