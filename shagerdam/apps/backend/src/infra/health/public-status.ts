/**
 * Public, business-level status of the platform (the `/status` page).
 *
 * The operator probe `GET /health` reports infrastructure (database, Redis,
 * heap, uptime). None of that belongs on a public page: dependency names,
 * error strings (host names, addresses, ports), memory figures and process
 * start times help an attacker and mean nothing to a customer. This module
 * maps the same checks onto the business capabilities a visitor cares about
 * and exposes only an enum per capability — no latency, no message, no name
 * of an internal component.
 *
 * Pure module (no Nest/Prisma) — unit-tested in `public-status.spec.ts`.
 */

/** Business capabilities shown on the status page, in display order. */
export const PUBLIC_STATUS_MODULES = ['storefront', 'orders', 'payments', 'bnpl', 'auth'] as const;
export type PublicStatusModule = (typeof PUBLIC_STATUS_MODULES)[number];

export type ComponentState = 'operational' | 'degraded' | 'outage';

/** Internal dependencies measured by the probe. */
export interface DependencySnapshot {
  database: boolean;
  redis: boolean;
}

export interface PublicModuleStatus {
  key: PublicStatusModule;
  status: ComponentState;
}

export interface PublicStatusReport {
  status: ComponentState;
  checkedAt: string;
  modules: PublicModuleStatus[];
}

/**
 * Which dependency each capability cannot work without (`required`) and which
 * one only speeds it up or runs its background jobs (`supporting`):
 *
 * - storefront: catalogue in PostgreSQL; Redis caches the category tree.
 * - orders: orders in PostgreSQL; Redis holds the expiry scheduler lock.
 * - payments: payments in PostgreSQL; Redis holds gateway/idempotency state.
 * - bnpl: credit accounts in PostgreSQL; Redis locks and overdue scheduler.
 * - auth: users in PostgreSQL; OTP codes and refresh tokens live in Redis,
 *   so without Redis nobody can sign in.
 */
const DEPENDENCIES: Readonly<Record<PublicStatusModule, { required: ReadonlyArray<keyof DependencySnapshot>; supporting: ReadonlyArray<keyof DependencySnapshot> }>> = {
  storefront: { required: ['database'], supporting: ['redis'] },
  orders: { required: ['database'], supporting: ['redis'] },
  payments: { required: ['database'], supporting: ['redis'] },
  bnpl: { required: ['database'], supporting: ['redis'] },
  auth: { required: ['database', 'redis'], supporting: [] },
};

export function moduleState(module: PublicStatusModule, deps: DependencySnapshot): ComponentState {
  const rule = DEPENDENCIES[module];
  if (rule.required.some((dep) => !deps[dep])) return 'outage';
  if (rule.supporting.some((dep) => !deps[dep])) return 'degraded';
  return 'operational';
}

/** Overall state: the worst capability wins. */
export function overallState(states: readonly ComponentState[]): ComponentState {
  if (states.includes('outage')) return 'outage';
  if (states.includes('degraded')) return 'degraded';
  return 'operational';
}

export function buildPublicStatus(deps: DependencySnapshot, now: Date): PublicStatusReport {
  const modules = PUBLIC_STATUS_MODULES.map((key) => ({ key, status: moduleState(key, deps) }));
  return { status: overallState(modules.map((entry) => entry.status)), checkedAt: now.toISOString(), modules };
}

/**
 * The public report is computed at most once per window, whatever the request
 * rate: an anonymous endpoint must not let anyone drive database/Redis pings.
 */
export const PUBLIC_STATUS_CACHE_MS = 10_000;
