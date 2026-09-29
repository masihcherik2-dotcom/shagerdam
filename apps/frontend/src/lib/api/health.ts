import { apiGet } from './client';

export type HealthCheckStatus = 'up' | 'down';
export type HealthReportStatus = 'ok' | 'error' | 'shutting_down';

/** Payload of a single terminus indicator. */
export interface HealthIndicatorDetail {
  status: HealthCheckStatus;
  latency_ms?: number;
  uptime_seconds?: number;
  started_at?: string;
  message?: string;
}

/** Response shape of `GET /api/v1/health` (see @nestjs/terminus). */
export interface SystemHealth {
  status: HealthReportStatus;
  info?: Record<string, HealthIndicatorDetail>;
  error?: Record<string, HealthIndicatorDetail>;
  details: Record<string, HealthIndicatorDetail>;
}

/** Fetches the backend health report from the browser. */
export async function getSystemHealth(): Promise<SystemHealth> {
  return apiGet<SystemHealth>('/health');
}
