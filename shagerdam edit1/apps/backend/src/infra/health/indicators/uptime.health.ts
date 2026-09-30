import { Injectable } from '@nestjs/common';
import { HealthIndicator, type HealthIndicatorResult } from '@nestjs/terminus';

/**
 * Reports process uptime. Load balancers and operators use it to tell a fresh,
 * still-warming instance apart from a long-running one.
 */
@Injectable()
export class UptimeHealthIndicator extends HealthIndicator {
  isHealthy(key: string): HealthIndicatorResult {
    const uptimeSeconds = Math.floor(process.uptime());
    return this.getStatus(key, true, {
      uptime_seconds: uptimeSeconds,
      started_at: new Date(Date.now() - uptimeSeconds * 1_000).toISOString(),
    });
  }
}
