'use client';

import { useCallback, useEffect, useState } from 'react';

import { ApiError } from '@/lib/api/errors';
import { getSystemHealth, type HealthIndicatorDetail, type SystemHealth } from '@/lib/api/health';

/** Auto-refresh cadence of the panel. */
const REFRESH_INTERVAL_MS = 15_000;

const CHECK_LABELS: Record<string, string> = {
  database: 'پایگاه داده (PostgreSQL)',
  redis: 'ردیس (Redis)',
  memory: 'حافظهٔ پردازش',
  uptime: 'زمان فعالیت سرویس',
};

interface SystemHealthPanelProps {
  initialHealth: SystemHealth | null;
  initialError: string | null;
}

function isSystemHealth(value: unknown): value is SystemHealth {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<SystemHealth>;
  return typeof candidate.status === 'string' && typeof candidate.details === 'object';
}

function formatDetailValue(key: string, detail: HealthIndicatorDetail): string {
  if (detail.latency_ms !== undefined) {
    return `زمان پاسخ: ${detail.latency_ms.toLocaleString('fa-IR')} میلی‌ثانیه`;
  }
  if (key === 'uptime' && detail.uptime_seconds !== undefined) {
    const minutes = Math.floor(detail.uptime_seconds / 60);
    const seconds = detail.uptime_seconds % 60;
    return `فعال از ${minutes.toLocaleString('fa-IR')} دقیقه و ${seconds.toLocaleString('fa-IR')} ثانیه پیش`;
  }
  if (detail.message !== undefined) {
    return detail.message;
  }
  return '';
}

/**
 * Live status of the API and its dependencies. The first render uses the report
 * fetched on the server; afterwards the browser polls the backend through the
 * same-origin `/api/v1` proxy and can be refreshed manually.
 */
export function SystemHealthPanel({ initialHealth, initialError }: SystemHealthPanelProps) {
  const [health, setHealth] = useState<SystemHealth | null>(initialHealth);
  const [error, setError] = useState<string | null>(initialError);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setIsRefreshing(true);
    try {
      const report = await getSystemHealth();
      setHealth(report);
      setError(null);
    } catch (caught) {
      const apiError =
        caught instanceof ApiError ? caught : new ApiError(String(caught), { kind: 'unknown' });

      // A 503 from the health endpoint is still a full report: the API is up
      // but a dependency is down. Render that report instead of a bare error.
      if (apiError.status === 503 && isSystemHealth(apiError.details)) {
        setHealth(apiError.details);
        setError(null);
      } else {
        setError(apiError.message);
        setHealth(null);
      }
    } finally {
      setLastUpdatedAt(new Date().toLocaleTimeString('fa-IR'));
      setIsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      void refresh();
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const isHealthy = health?.status === 'ok';
  const checks = Object.entries(health?.details ?? {});

  return (
    <section className="flex flex-col gap-4 rounded-2xl border border-slate-200 bg-surface p-6 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span
            className={`inline-flex h-3 w-3 rounded-full ${
              isHealthy ? 'bg-emerald-500' : error !== null ? 'bg-rose-500' : 'bg-amber-500'
            }`}
            aria-hidden="true"
          />
          <div className="flex flex-col">
            <span className="font-semibold text-slate-900">
              {error !== null ? 'عدم دسترسی به API' : isHealthy ? 'سامانه سالم است' : 'سامانه در وضعیت ناسالم'}
            </span>
            <span className="text-xs text-slate-500">
              {lastUpdatedAt === null ? 'در حال دریافت وضعیت…' : `آخرین بروزرسانی: ${lastUpdatedAt}`}
            </span>
          </div>
        </div>

        <button
          type="button"
          onClick={() => {
            void refresh();
          }}
          disabled={isRefreshing}
          className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isRefreshing ? 'در حال بررسی…' : 'بررسی مجدد'}
        </button>
      </div>

      {error !== null ? (
        <p className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {error}
        </p>
      ) : null}

      {checks.length > 0 ? (
        <ul className="grid gap-3 sm:grid-cols-2">
          {checks.map(([key, detail]) => (
            <li
              key={key}
              className="flex flex-col gap-1 rounded-xl border border-slate-200 bg-surface-muted px-4 py-3"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-slate-800">
                  {CHECK_LABELS[key] ?? key}
                </span>
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                    detail.status === 'up'
                      ? 'bg-emerald-100 text-emerald-700'
                      : 'bg-rose-100 text-rose-700'
                  }`}
                >
                  {detail.status === 'up' ? 'سالم' : 'ناسالم'}
                </span>
              </div>
              <span className="text-xs leading-5 text-slate-500">
                {formatDetailValue(key, detail)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
