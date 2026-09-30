'use client';

import { ChevronLeft, Package, ShoppingBag } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

import { PackageStepper } from '@/components/orders/package-stepper';
import { LinkButton } from '@/components/ui/button';
import { Money, PageHeader, Pagination, StatusBadge } from '@/components/ui/misc';
import { AsyncView, EmptyState, SkeletonRows } from '@/components/ui/states';
import type { CustomerOrderSummary, Page, ParentOrderPaymentStatus } from '@/lib/api/types';
import { useApi } from '@/lib/hooks/use-api';
import { formatDateTime, toPersianDigits } from '@/lib/format';
import { PAYMENT_METHOD_LABELS, PAYMENT_STATUS } from '@/lib/labels';

const FILTERS: Array<{ value: ParentOrderPaymentStatus | ''; label: string }> = [
  { value: '', label: 'همه' },
  { value: 'PAID', label: 'پرداخت‌شده' },
  { value: 'PENDING', label: 'در انتظار پرداخت' },
  { value: 'CANCELLED', label: 'لغوشده' },
  { value: 'FAILED', label: 'ناموفق' },
];

export default function CustomerOrdersPage() {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<ParentOrderPaymentStatus | ''>('');
  const state = useApi<Page<CustomerOrderSummary>>('/customer/orders', { page, pageSize: 10, paymentStatus: status || undefined });

  return (
    <>
      <PageHeader title="سفارش‌های من" description="وضعیت پرداخت و مرسوله‌های هر سفارش" />
      <div className="mb-4 flex flex-wrap gap-2" role="tablist">
        {FILTERS.map((filter) => (
          <button
            key={filter.value}
            type="button"
            role="tab"
            aria-selected={status === filter.value}
            onClick={() => {
              setStatus(filter.value);
              setPage(1);
            }}
            className={`rounded-full border px-4 py-1.5 text-sm ${status === filter.value ? 'border-brand-600 bg-brand-600 text-white' : 'border-slate-200 bg-white text-slate-700 hover:border-brand-300'}`}
          >
            {filter.label}
          </button>
        ))}
      </div>
      <AsyncView
        state={state}
        skeleton={<SkeletonRows rows={4} className="h-44" />}
        isEmpty={(data) => data.items.length === 0}
        empty={<EmptyState icon={<ShoppingBag className="size-8" />} title="سفارشی پیدا نشد" description={status ? 'سفارشی با این وضعیت ندارید.' : 'هنوز خریدی انجام نداده‌اید.'} action={<LinkButton href="/">شروع خرید</LinkButton>} />}
      >
        {(data) => (
          <div className="flex flex-col gap-4">
            {data.items.map((order) => (
              <article key={order.id} className="rounded-2xl border border-slate-200 bg-white">
                <header className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-slate-100 px-5 py-3 text-sm">
                  <span className="font-bold" dir="ltr">
                    {order.orderNumber}
                  </span>
                  <StatusBadge value={order.paymentStatus} map={PAYMENT_STATUS} />
                  <span className="text-slate-500">{formatDateTime(order.createdAt)}</span>
                  <span className="text-slate-500">{PAYMENT_METHOD_LABELS[order.paymentMethod]}</span>
                  <span className="ms-auto font-bold">
                    <Money rials={order.finalPayableAmount} />
                  </span>
                </header>
                <ul className="divide-y divide-slate-100">
                  {order.subOrders.map((sub) => (
                    <li key={sub.id} className="grid gap-3 px-5 py-4 md:grid-cols-[220px_1fr] md:items-center">
                      <div className="flex items-center gap-2 text-sm">
                        <Package className="size-4 text-slate-400" />
                        <div>
                          <div className="font-medium">{sub.storeName}</div>
                          <div className="text-xs text-slate-500">
                            {toPersianDigits(sub.itemCount)} قلم
                            {sub.trackingCode ? (
                              <>
                                {' '}
                                · کد رهگیری <span dir="ltr">{sub.trackingCode}</span>
                              </>
                            ) : null}
                          </div>
                        </div>
                      </div>
                      <PackageStepper status={sub.status} />
                    </li>
                  ))}
                </ul>
                <footer className="flex justify-end border-t border-slate-100 px-5 py-3">
                  <Link href={`/customer/orders/${order.id}`} className="flex items-center gap-1 text-sm font-medium text-brand-700 hover:underline">
                    جزئیات سفارش <ChevronLeft className="size-4" />
                  </Link>
                </footer>
              </article>
            ))}
            <Pagination page={data.page} totalPages={data.totalPages} total={data.total} onChange={setPage} />
          </div>
        )}
      </AsyncView>
    </>
  );
}
