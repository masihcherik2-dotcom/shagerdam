import { Check, X } from 'lucide-react';

import type { SubOrderStatus } from '@/lib/api/types';
import { PACKAGE_STEPS, SUB_ORDER_STATUS } from '@/lib/labels';

/**
 * Horizontal status timeline of one package:
 * awaiting approval → processing → shipped → delivered.
 * Cancelled/refunded packages show a terminal red marker instead.
 */
export function PackageStepper({ status }: { status: SubOrderStatus }) {
  if (status === 'CANCELLED' || status === 'REFUNDED') {
    return (
      <div className="flex items-center gap-2 rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700">
        <X className="size-4" /> {SUB_ORDER_STATUS[status].label}
      </div>
    );
  }
  const current = PACKAGE_STEPS.indexOf(status);
  return (
    <ol className="flex items-center" aria-label="وضعیت مرسوله">
      {PACKAGE_STEPS.map((step, index) => {
        const done = index < current || (index === current && step === 'DELIVERED');
        const active = index === current;
        return (
          <li key={step} className="flex flex-1 items-center last:flex-none" aria-current={active ? 'step' : undefined}>
            <div className="flex flex-col items-center gap-1">
              <span
                className={`flex size-7 items-center justify-center rounded-full border-2 text-xs font-bold ${
                  done ? 'border-emerald-500 bg-emerald-500 text-white' : active ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-slate-200 bg-white text-slate-400'
                }`}
              >
                {done ? <Check className="size-4" /> : index + 1}
              </span>
              <span className={`whitespace-nowrap text-[11px] ${active ? 'font-bold text-slate-900' : 'text-slate-500'}`}>{SUB_ORDER_STATUS[step].label}</span>
            </div>
            {index < PACKAGE_STEPS.length - 1 ? <span className={`mx-1 mb-5 h-0.5 flex-1 ${index < current ? 'bg-emerald-400' : 'bg-slate-200'}`} /> : null}
          </li>
        );
      })}
    </ol>
  );
}
