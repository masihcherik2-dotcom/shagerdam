'use client';

import { CheckCircle2, CircleAlert, CircleX, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/misc';
import { getPublicStatus, isPublicStatusReport } from '@/lib/api/health';
import type { ComponentState, PublicStatusReport } from '@/lib/api/types';
import { formatDateTime } from '@/lib/format';
import { COMPONENT_STATE, STATUS_MODULE_LABELS } from '@/lib/labels';

/** Auto-refresh cadence (the backend caches the report for 10 s). */
const REFRESH_INTERVAL_MS = 30_000;

const OVERALL: Record<ComponentState, { title: string; className: string; icon: typeof CheckCircle2 }> = {
  operational: { title: 'همهٔ سرویس‌ها فعال هستند', className: 'border-emerald-200 bg-emerald-50 text-emerald-900', icon: CheckCircle2 },
  degraded: { title: 'بخشی از سرویس‌ها با کندی یا اختلال همراه است', className: 'border-amber-200 bg-amber-50 text-amber-900', icon: CircleAlert },
  outage: { title: 'بخشی از سرویس‌ها در دسترس نیست', className: 'border-red-200 bg-red-50 text-red-900', icon: CircleX },
};

interface SystemHealthPanelProps {
  initialReport: PublicStatusReport | null;
  initialError: string | null;
}

/**
 * Public status of the platform's business capabilities. Shows no internal
 * component names, error messages, memory, uptime or addresses — only
 * operational / degraded / outage per capability.
 */
export function SystemHealthPanel({ initialReport, initialError }: SystemHealthPanelProps) {
  const [report, setReport] = useState<PublicStatusReport | null>(initialReport);
  const [error, setError] = useState<string | null>(initialError);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    setIsRefreshing(true);
    try {
      const next = await getPublicStatus();
      if (!isPublicStatusReport(next)) throw new Error('invalid report');
      setReport(next);
      setError(null);
    } catch {
      setError('ارتباط با سامانه برقرار نشد؛ ممکن است سرویس موقتاً در دسترس نباشد.');
    } finally {
      setIsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const timer = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const overall = report && !error ? OVERALL[report.status] : OVERALL.outage;
  const OverallIcon = overall.icon;

  return (
    <section className="flex flex-col gap-4" aria-live="polite">
      <div className={`flex items-center gap-3 rounded-2xl border p-5 ${overall.className}`} data-testid="status-overall">
        <OverallIcon className="size-7 shrink-0" aria-hidden="true" />
        <div className="flex flex-col">
          <p className="font-bold">{error ? 'ارتباط با سامانه برقرار نیست' : overall.title}</p>
          {report ? <p className="text-xs opacity-80">آخرین بررسی: {formatDateTime(report.checkedAt)}</p> : null}
        </div>
      </div>

      {error ? <p className="text-sm text-slate-600">{error}</p> : null}

      {report ? (
        <ul className="divide-y divide-slate-100 rounded-2xl border border-slate-200 bg-white" data-testid="status-modules">
          {report.modules.map((module) => (
            <li key={module.key} className="flex items-center justify-between gap-4 p-4">
              <span className="flex flex-col">
                <span className="font-medium text-slate-900">{STATUS_MODULE_LABELS[module.key].title}</span>
                <span className="text-xs text-slate-500">{STATUS_MODULE_LABELS[module.key].description}</span>
              </span>
              <StatusBadge value={module.status} map={COMPONENT_STATE} />
            </li>
          ))}
        </ul>
      ) : null}

      <Button variant="secondary" className="self-start" loading={isRefreshing} icon={<RefreshCw className="size-4" />} onClick={() => void refresh()}>
        بررسی دوباره
      </Button>
    </section>
  );
}
