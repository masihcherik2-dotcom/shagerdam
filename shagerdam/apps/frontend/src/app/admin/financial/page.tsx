'use client';

import { AlertTriangle, Banknote, CheckCircle2, CreditCard, Landmark, Lock, Scale, ShoppingBag, Wallet } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/field';
import { Card, Money, PageHeader, StatCard } from '@/components/ui/misc';
import { AsyncView, Skeleton } from '@/components/ui/states';
import type { FinancialOverview } from '@/lib/api/types';
import { useApi } from '@/lib/hooks/use-api';
import { formatCount, formatDateTime } from '@/lib/format';

/** A calendar day picked in the browser, as the start of that day in Tehran time. */
function tehranDayStart(day: string): string {
  return `${day}T00:00:00+03:30`;
}

function nextDay(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function Row({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`flex justify-between py-1.5 text-sm ${strong ? 'border-t border-slate-100 pt-2 font-bold' : ''}`}>
      <span className="text-slate-600">{label}</span>
      <Money rials={value} />
    </div>
  );
}

export default function AdminFinancialPage() {
  const [fromDay, setFromDay] = useState('');
  const [toDay, setToDay] = useState('');
  const [applied, setApplied] = useState<{ from?: string; to?: string }>({});
  const state = useApi<FinancialOverview>('/admin/financial/overview', applied);

  return (
    <>
      <PageHeader title="گزارش مالی" description="فروش، کارمزد، وجوه امانی و تعهدات پرداخت — از دفتر کل واقعی" />
      <Card className="mb-6">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            setApplied({ ...(fromDay ? { from: tehranDayStart(fromDay) } : {}), ...(toDay ? { to: tehranDayStart(nextDay(toDay)) } : {}) });
          }}
        >
          <label className="flex flex-col gap-1 text-xs text-slate-600">
            از تاریخ (میلادی)
            <Input type="date" dir="ltr" value={fromDay} onChange={(event) => setFromDay(event.target.value)} className="w-44" />
          </label>
          <label className="flex flex-col gap-1 text-xs text-slate-600">
            تا تاریخ (شامل)
            <Input type="date" dir="ltr" value={toDay} min={fromDay || undefined} onChange={(event) => setToDay(event.target.value)} className="w-44" />
          </label>
          <Button type="submit">اعمال بازه</Button>
          {applied.from || applied.to ? (
            <Button
              variant="ghost"
              onClick={() => {
                setFromDay('');
                setToDay('');
                setApplied({});
              }}
            >
              کل دوره
            </Button>
          ) : null}
          <span className="ms-auto text-xs text-slate-500">بازه فقط روی ارقام فروش اثر دارد؛ مانده‌ها همیشه لحظه‌ای‌اند.</span>
        </form>
      </Card>

      <AsyncView state={state} skeleton={<Skeleton className="h-[480px]" />}>
        {(data) => (
          <div className="flex flex-col gap-6">
            {!data.wallets.ledgerConsistent ? (
              <div className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
                <AlertTriangle className="mt-0.5 size-5 shrink-0" /> ناهمخوانی دفتر کل: مانده‌ی {formatCount(data.wallets.inconsistentWallets)} کیف پول با جمع تراکنش‌هایش برابر نیست. پیش از پرداخت تسویه‌ها بررسی شود.
              </div>
            ) : null}
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <StatCard label="ارزش ناخالص فروش (GMV)" value={<Money rials={data.sales.gmv} />} icon={<ShoppingBag className="size-5" />} tone="info" />
              <StatCard label="کارمزد قطعی" value={<Money rials={data.commission.earned} />} icon={<Banknote className="size-5" />} tone="success" hint={<>در انتظار: <Money rials={data.commission.pending} /></>} />
              <StatCard label="وجوه امانی (Escrow)" value={<Money rials={data.wallets.escrowHeld} />} icon={<Lock className="size-5" />} tone="warning" />
              <StatCard label="قابل برداشت فروشندگان" value={<Money rials={data.wallets.withdrawable} />} icon={<Wallet className="size-5" />} />
            </div>
            <div className="grid gap-6 lg:grid-cols-3">
              <Card title={<span className="flex items-center gap-2"><ShoppingBag className="size-4 text-brand-600" /> فروش</span>}>
                <div className="mb-2 flex justify-between text-sm">
                  <span className="text-slate-600">سفارش‌های پرداخت‌شده</span>
                  <b>{formatCount(data.sales.paidOrders)}</b>
                </div>
                <div className="mb-2 flex justify-between text-sm">
                  <span className="text-slate-600">مرسوله‌های فعال</span>
                  <b>{formatCount(data.sales.activePackages)}</b>
                </div>
                <Row label="هزینهٔ ارسال" value={data.sales.shippingFees} />
                <Row label="دریافت از درگاه" value={data.sales.collectedByGateway} />
                <Row label="تأمین از اعتبار بانکی" value={data.sales.fundedByCredit} />
                <Row label="اقساط وصول‌شده" value={data.sales.installmentsCollected} />
                <Row label="GMV" value={data.sales.gmv} strong />
              </Card>
              <Card title={<span className="flex items-center gap-2"><Wallet className="size-4 text-brand-600" /> کیف پول‌ها</span>}>
                <Row label="امانی (در انتظار تحویل)" value={data.wallets.escrowHeld} />
                <Row label="قابل برداشت" value={data.wallets.withdrawable} />
                <Row label="در حال تسویه" value={data.wallets.settlementHold} />
                <Row label="مسدود (اختلاف)" value={data.wallets.disputeHold} />
                <Row label="کل پرداخت‌شده به فروشندگان" value={data.wallets.totalWithdrawn} strong />
                <p className="mt-2 flex items-center gap-1 text-xs text-slate-500">
                  {data.wallets.ledgerConsistent ? <CheckCircle2 className="size-3 text-emerald-600" /> : <AlertTriangle className="size-3 text-rose-600" />}
                  {data.wallets.ledgerConsistent ? 'دفتر کل همخوان است' : 'دفتر کل ناهمخوان است'}
                </p>
              </Card>
              <Card title={<span className="flex items-center gap-2"><Landmark className="size-4 text-brand-600" /> تسویه و تعهدات</span>}>
                <div className="mb-2 flex justify-between text-sm">
                  <span className="text-slate-600">تسویه‌های در انتظار</span>
                  <b>{formatCount(data.settlements.pendingCount)}</b>
                </div>
                <Row label="مبلغ در انتظار" value={data.settlements.pendingAmount} />
                <div className="my-2 flex justify-between text-sm">
                  <span className="text-slate-600">تسویه‌های پرداخت‌شده</span>
                  <b>{formatCount(data.settlements.paidCount)}</b>
                </div>
                <Row label="مبلغ پرداخت‌شده" value={data.settlements.paidAmount} />
                <div className="mt-2 flex justify-between border-t border-slate-100 pt-2 text-sm">
                  <span className="flex items-center gap-1 text-slate-600">
                    <CreditCard className="size-4" /> پرداخت‌های نیازمند استرداد دستی
                  </span>
                  <b className={data.paymentsRequiringManualRefund > 0 ? 'text-rose-600' : ''}>{formatCount(data.paymentsRequiringManualRefund)}</b>
                </div>
              </Card>
            </div>
            <Card title={<span className="flex items-center gap-2"><Scale className="size-4 text-brand-600" /> اختلاف‌ها</span>}>
              <div className="grid gap-4 text-sm sm:grid-cols-5">
                <div>
                  <div className="text-slate-500">باز</div>
                  <b>{formatCount(data.disputes.open)}</b>
                </div>
                <div>
                  <div className="text-slate-500">در داوری</div>
                  <b>{formatCount(data.disputes.underArbitration)}</b>
                </div>
                <div>
                  <div className="text-slate-500">به نفع خریدار</div>
                  <b>{formatCount(data.disputes.resolvedForBuyer)}</b>
                </div>
                <div>
                  <div className="text-slate-500">بدهی استرداد به خریداران</div>
                  <Money rials={data.disputes.refundsOwedToCustomers} className="font-bold" />
                </div>
                <div>
                  <div className="text-slate-500">درآمد وصول‌نشده از فروشندگان</div>
                  <Money rials={data.disputes.unrecoveredVendorEarnings} className="font-bold" />
                </div>
              </div>
            </Card>
            <p className="text-xs text-slate-500">
              تولید گزارش: {formatDateTime(data.generatedAt)}
              {data.from || data.to ? ` — بازهٔ فروش: ${data.from ? formatDateTime(data.from) : 'ابتدا'} تا ${data.to ? formatDateTime(data.to) : 'اکنون'}` : ''}
            </p>
          </div>
        )}
      </AsyncView>
    </>
  );
}
