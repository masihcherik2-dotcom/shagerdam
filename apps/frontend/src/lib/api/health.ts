import { apiGet } from './client';
import type { ComponentState, PublicStatusModule, PublicStatusReport } from './types';

const STATES: readonly ComponentState[] = ['operational', 'degraded', 'outage'];
const MODULES: readonly PublicStatusModule[] = ['storefront', 'orders', 'payments', 'bnpl', 'auth'];

/** Runtime check of `GET /health/status` (the page must never render an unexpected shape). */
export function isPublicStatusReport(value: unknown): value is PublicStatusReport {
  if (typeof value !== 'object' || value === null) return false;
  const report = value as Partial<PublicStatusReport>;
  return (
    STATES.includes(report.status as ComponentState) &&
    typeof report.checkedAt === 'string' &&
    Array.isArray(report.modules) &&
    report.modules.every((module) => MODULES.includes(module.key) && STATES.includes(module.status))
  );
}

/**
 * Public, sanitized status (business capabilities only) through the BFF.
 * The detailed operator probe `GET /health` is not reachable from the browser.
 */
export async function getPublicStatus(): Promise<PublicStatusReport> {
  return apiGet<PublicStatusReport>('/health/status');
}
