import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';

import { formatToman } from '@/lib/currency';
import { formatCount, toPersianDigits } from '@/lib/format';
import type { Tone } from '@/lib/labels';

const TONES: Record<Tone, string> = {
  neutral: 'bg-slate-100 text-slate-700 ring-slate-200',
  info: 'bg-sky-50 text-sky-800 ring-sky-200',
  success: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
  warning: 'bg-amber-50 text-amber-900 ring-amber-200',
  danger: 'bg-rose-50 text-rose-800 ring-rose-200',
  brand: 'bg-brand-50 text-brand-700 ring-brand-100',
};

export function Badge({ tone = 'neutral', children, className = '' }: { tone?: Tone; children: ReactNode; className?: string }) {
  return <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${TONES[tone]} ${className}`}>{children}</span>;
}

/** Badge for an enum value using a label/tone map from lib/labels. */
export function StatusBadge<K extends string>({ value, map }: { value: K; map: Record<K, { label: string; tone: Tone }> }) {
  const entry = map[value];
  return <Badge tone={entry?.tone ?? 'neutral'}>{entry?.label ?? value}</Badge>;
}

/** A Rial amount from the API displayed in Toman (via lib/currency only). */
export function Money({ rials, className = '', strike = false }: { rials: string | number | bigint; className?: string; strike?: boolean }) {
  return <span className={`whitespace-nowrap tabular-nums ${strike ? 'text-slate-400 line-through' : ''} ${className}`}>{formatToman(rials)}</span>;
}

export function Card({ children, className = '', title, action }: { children: ReactNode; className?: string; title?: ReactNode; action?: ReactNode }) {
  return (
    <section className={`rounded-2xl border border-slate-200 bg-white p-5 shadow-sm ${className}`}>
      {title || action ? (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          {title ? <h2 className="text-base font-bold text-slate-900">{title}</h2> : <span />}
          {action}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function StatCard({ label, value, hint, icon, tone = 'neutral' }: { label: string; value: ReactNode; hint?: ReactNode; icon?: ReactNode; tone?: Tone }) {
  return (
    <div className="flex flex-col gap-2 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm text-slate-500">{label}</span>
        {icon ? <span className={`flex size-9 items-center justify-center rounded-xl ring-1 ring-inset ${TONES[tone]}`}>{icon}</span> : null}
      </div>
      <div className="text-lg font-bold text-slate-900">{value}</div>
      {hint ? <div className="text-xs leading-5 text-slate-500">{hint}</div> : null}
    </div>
  );
}

export function PageHeader({ title, description, action }: { title: string; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-bold text-slate-900 md:text-2xl">{title}</h1>
        {description ? <p className="text-sm leading-6 text-slate-500">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function Pagination({ page, totalPages, total, onChange }: { page: number; totalPages: number; total?: number; onChange: (page: number) => void }) {
  if (totalPages <= 1) {
    return total !== undefined && total > 0 ? <p className="mt-4 text-center text-xs text-slate-500">{formatCount(total)} مورد</p> : null;
  }
  return (
    <nav className="mt-6 flex items-center justify-center gap-3" aria-label="صفحه‌بندی">
      <button
        type="button"
        onClick={() => onChange(page - 1)}
        disabled={page <= 1}
        className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm disabled:opacity-40"
      >
        <ChevronRight className="size-4" /> قبلی
      </button>
      <span className="text-sm text-slate-600">
        صفحهٔ {toPersianDigits(page)} از {toPersianDigits(totalPages)}
        {total !== undefined ? <span className="text-slate-400"> ({formatCount(total)} مورد)</span> : null}
      </span>
      <button
        type="button"
        onClick={() => onChange(page + 1)}
        disabled={page >= totalPages}
        className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm disabled:opacity-40"
      >
        بعدی <ChevronLeft className="size-4" />
      </button>
    </nav>
  );
}

/** Horizontal progress bar (0…1). */
export function ProgressBar({ value, tone = 'brand', label }: { value: number; tone?: 'brand' | 'success' | 'warning' | 'danger'; label?: string }) {
  const colors = { brand: 'bg-brand-600', success: 'bg-emerald-500', warning: 'bg-amber-500', danger: 'bg-rose-500' };
  const percent = Math.max(0, Math.min(1, value)) * 100;
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)} aria-label={label}>
      <div className={`h-full rounded-full ${colors[tone]} transition-[width]`} style={{ width: `${percent}%` }} />
    </div>
  );
}

export function DefinitionList({ items }: { items: Array<{ label: string; value: ReactNode }> }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
      {items.map((item) => (
        <div key={item.label} className="flex flex-col gap-0.5">
          <dt className="text-slate-500">{item.label}</dt>
          <dd className="font-medium text-slate-900">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Table shell with horizontal scroll on small screens. */
export function Table({ head, children }: { head: ReactNode[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white">
      <table className="w-full min-w-[640px] text-sm">
        <thead className="bg-slate-50 text-slate-600">
          <tr>
            {head.map((cell, index) => (
              <th key={index} className="px-4 py-3 text-start font-medium">
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">{children}</tbody>
      </table>
    </div>
  );
}

export function Td({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <td className={`px-4 py-3 align-middle ${className}`}>{children}</td>;
}
