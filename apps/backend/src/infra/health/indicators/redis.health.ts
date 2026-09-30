import { Injectable, Logger } from '@nestjs/common';
import { HealthIndicator, type HealthIndicatorResult } from '@nestjs/terminus';
import { HEALTH_FAILURE_MESSAGE } from '../health-messages';
import { errorMessage } from '../../../common/utils';
import { RedisService } from '../../redis/redis.service';

/** Verifies that Redis answers an authenticated `PING`. */
@Injectable()
export class RedisHealthIndicator extends HealthIndicator {
  private readonly logger = new Logger(RedisHealthIndicator.name);

  constructor(private readonly redis: RedisService) {
    super();
  }

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    try {
      const latencyMs = await this.redis.ping();
      return this.getStatus(key, true, { latency_ms: latencyMs });
    } catch (error) {
      // The raw error names hosts/ports; it goes to the log, never into the response.
      this.logger.error(`Redis health check failed: ${errorMessage(error)}`);
      return this.getStatus(key, false, { message: HEALTH_FAILURE_MESSAGE });
    }
  }
}
