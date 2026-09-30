import { buildPublicStatus, moduleState, overallState, PUBLIC_STATUS_MODULES } from './public-status';

describe('public status rules', () => {
  const now = new Date('2026-10-01T08:00:00.000Z');

  it('reports every capability operational when all dependencies are up', () => {
    const report = buildPublicStatus({ database: true, redis: true }, now);
    expect(report).toEqual({
      status: 'operational',
      checkedAt: '2026-10-01T08:00:00.000Z',
      modules: PUBLIC_STATUS_MODULES.map((key) => ({ key, status: 'operational' })),
    });
  });

  it('a database outage takes every capability down', () => {
    const report = buildPublicStatus({ database: false, redis: true }, now);
    expect(report.status).toBe('outage');
    expect(report.modules.every((entry) => entry.status === 'outage')).toBe(true);
  });

  it('a Redis outage degrades the shop and stops sign-in', () => {
    const deps = { database: true, redis: false };
    expect(moduleState('storefront', deps)).toBe('degraded');
    expect(moduleState('orders', deps)).toBe('degraded');
    expect(moduleState('payments', deps)).toBe('degraded');
    expect(moduleState('bnpl', deps)).toBe('degraded');
    expect(moduleState('auth', deps)).toBe('outage');
    expect(buildPublicStatus(deps, now).status).toBe('outage');
  });

  it('overall state is the worst capability', () => {
    expect(overallState(['operational', 'degraded'])).toBe('degraded');
    expect(overallState(['degraded', 'outage', 'operational'])).toBe('outage');
    expect(overallState([])).toBe('operational');
  });

  it('exposes only keys and states — no dependency names, messages or metrics', () => {
    const serialized = JSON.stringify(buildPublicStatus({ database: false, redis: false }, now));
    expect(serialized).not.toMatch(/database|redis|postgres|memory|heap|uptime|latency|message|\d+\.\d+\.\d+\.\d+/i);
  });
});
