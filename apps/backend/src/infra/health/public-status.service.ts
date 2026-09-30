import { Injectable } from '@nestjs/common';
import { DatabaseHealthIndicator } from './indicators/database.health';
import { RedisHealthIndicator } from './indicators/redis.health';
import { buildPublicStatus, PUBLIC_STATUS_CACHE_MS, type PublicStatusReport } from './public-status';

/**
 * Computes the public status report from the same live checks as `GET /health`
 * and memoises it for {@link PUBLIC_STATUS_CACHE_MS}. Concurrent requests during
 * a refresh share the in-flight computation.
 */
@Injectable()
export class PublicStatusService {
  private cached: { report: PublicStatusReport; expiresAt: number } | null = null;
  private inFlight: Promise<PublicStatusReport> | null = null;

  constructor(
    private readonly database: DatabaseHealthIndicator,
    private readonly redis: RedisHealthIndicator,
  ) {}

  async report(): Promise<PublicStatusReport> {
    const now = Date.now();
    if (this.cached && this.cached.expiresAt > now) {
      return this.cached.report;
    }
    if (!this.inFlight) {
      this.inFlight = this.compute().finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  private async compute(): Promise<PublicStatusReport> {
    const [database, redis] = await Promise.all([this.database.isHealthy('database'), this.redis.isHealthy('redis')]);
    const report = buildPublicStatus(
      { database: database['database']?.status === 'up', redis: redis['redis']?.status === 'up' },
      new Date(),
    );
    this.cached = { report, expiresAt: Date.now() + PUBLIC_STATUS_CACHE_MS };
    return report;
  }
}
