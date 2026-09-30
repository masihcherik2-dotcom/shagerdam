'use client';

import { CalendarClock } from 'lucide-react';
import { useState } from 'react';

import type { CreditPlans } from '@/lib/api/types';
import { formatToman } from '@/lib/currency';
import { formatPercent, toPersianDigits } from '@/lib/format';
import { previewInstallments } from '@/lib/installments';

/**
 * Installment calculator over the provider's live plans (e.g. 3 months 0%,
 * 6 and 12 months with interest). Numbers come from lib/installments, which
 * mirrors the backend's schedule arithmetic exactly.
 */
export function InstallmentCalculator({ amount, plans }: { amount: string; plans: CreditPlans }) {
  const sorted = [...plans.items].sort((a, b) => a.durationMonths - b.durationMonths);
  const [planId, setPlanId] = useState(sorted[0]?.id ?? '');
  const plan = sorted.find((item) => item.id === planId) ?? sorted[0];
  if (!plan) return null;
  const preview = previewInstallments(amount, plan.interestRatePercent, plan.durationMonths);
  const zero = Number(plan.interestRatePercent) === 0;

  return (
    <section className="rounded-2xl border border-emerald-200 bg-emerald-50/60 p-4" aria-labelledby="installment-calc-title">
      <h2 id="installment-calc-title" className="mb-3 flex items-center gap-2 text-sm font-bold text-emerald-900">
        <CalendarClock className="size-4" /> محاسبهٔ اقساط {plans.provider ? `— ${plans.provider.name}` : ''}
      </h2>
      <div className="mb-4 grid grid-cols-3 gap-2" role="radiogroup" aria-label="طرح اقساط">
        {sorted.map((item) => {
          const active = item.id === plan.id;
          return (
            <button
              key={item.id}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => setPlanId(item.id)}
              className={`flex flex-col items-center gap-0.5 rounded-xl border px-2 py-2 text-center ${active ? 'border-emerald-600 bg-white ring-2 ring-emerald-100' : 'border-emerald-200 bg-white/60'}`}
            >
              <span className="text-sm font-bold text-slate-900">{toPersianDigits(item.durationMonths)} ماهه</span>
              <span className={`text-xs ${Number(item.interestRatePercent) === 0 ? 'font-bold text-emerald-700' : 'text-slate-500'}`}>
                {Number(item.interestRatePercent) === 0 ? 'بدون سود' : `سود ${formatPercent(item.interestRatePercent)}`}
              </span>
            </button>
          );
        })}
      </div>
      <dl className="grid grid-cols-2 gap-3 text-sm">
        <div className="rounded-xl bg-white p-3">
          <dt className="text-xs text-slate-500">مبلغ هر قسط</dt>
          <dd className="mt-1 font-black text-emerald-800">{formatToman(preview.regularInstallment)}</dd>
        </div>
        <div className="rounded-xl bg-white p-3">
          <dt className="text-xs text-slate-500">تعداد اقساط</dt>
          <dd className="mt-1 font-bold text-slate-900">
            {toPersianDigits(plan.durationMonths)} قسط، هر {toPersianDigits(plan.installmentIntervalDays)} روز
          </dd>
        </div>
        <div className="rounded-xl bg-white p-3">
          <dt className="text-xs text-slate-500">سود کل</dt>
          <dd className="mt-1 font-bold text-slate-900">{zero ? 'بدون سود' : formatToman(preview.totalInterest)}</dd>
        </div>
        <div className="rounded-xl bg-white p-3">
          <dt className="text-xs text-slate-500">مجموع بازپرداخت</dt>
          <dd className="mt-1 font-bold text-slate-900">{formatToman(preview.totalPayable)}</dd>
        </div>
      </dl>
      <p className="mt-3 text-xs leading-5 text-emerald-900/70">
        محاسبه برای قیمت کالای انتخاب‌شده (بدون هزینهٔ ارسال) است. جدول قطعی اقساط هنگام پرداخت ساخته می‌شود؛ جریمهٔ دیرکرد ماهانه {formatPercent(plan.penaltyRatePercentPerMonth)}.
      </p>
    </section>
  );
}
