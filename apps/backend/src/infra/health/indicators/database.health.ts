import { Injectable } from '@nestjs/common';
import { HealthIndicator, type HealthIndicatorResult } from '@nestjs/terminus';
import { errorMessage, toMilliseconds } from '../../../common/utils';
import { PrismaService } from '../../prisma/prisma.service';

/** Verifies that PostgreSQL answers a real query through Prisma. */
@Injectable()
export class DatabaseHealthIndicator extends HealthIndicator {
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
      return this.getStatus(key, false, { message: errorMessage(error) });
    }
  }
}
