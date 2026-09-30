import { Injectable, Logger } from '@nestjs/common';
import { HealthIndicator, type HealthIndicatorResult } from '@nestjs/terminus';
import { HEALTH_FAILURE_MESSAGE } from '../health-messages';
import { errorMessage, toMilliseconds } from '../../../common/utils';
import { PrismaService } from '../../prisma/prisma.service';

/** Verifies that PostgreSQL answers a real query through Prisma. */
@Injectable()
export class DatabaseHealthIndicator extends HealthIndicator {
  private readonly logger = new Logger(DatabaseHealthIndicator.name);

  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    const startedAt = process.hrtime.bigint();
    try {
      await this.prisma.ping();
      return this.getStatus(key, true, {
        latency_ms: toMilliseconds(process.hrtime.bigint() - startedAt),
      });
    } catch (error) {
      // The raw error names hosts/ports; it goes to the log, never into the response.
      this.logger.error(`PostgreSQL health check failed: ${errorMessage(error)}`);
      return this.getStatus(key, false, { message: HEALTH_FAILURE_MESSAGE });
    }
  }
}
