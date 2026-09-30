'use client';

import { ChevronLeft, Clock, PackageCheck, Scale, Truck, Wallet } from 'lucide-react';
import Link from 'next/link';

import { LinkButton } from '@/components/ui/button';
import { Card, Money, PageHeader, StatCard, StatusBadge, Table, Td } from '@/components/ui/misc';
import { EmptyState, ErrorState, Skeleton, SkeletonRows } from '@/components/ui/states';
import { useSession } from '@/components/providers/session-provider';
import { TorobFeedCard } from '@/components/vendor/torob-feed-card';
import type { Page, SubOrderStatus, VendorDispute, VendorSubOrderSummary, WalletSummary } from '@/lib/api/types';
import { useApi } from '@/lib/hooks/use-api';
import { formatCount, formatDateTime, toPersianDigits } from '@/lib/format';
import { SUB_ORDER_STATUS } from '@/lib/labels';

/** Package counts come from the list endpoint's `total` (pageSize=1): no separate stats endpoint exists. */
function usePackageCount(status: SubOrderStatus) {
  return useApi<Page<VendorSubOrderSummary>>('/vendor/orders', { status, pageSize: 1 });
}

function CountValue({ state }: { state: { data?: { total: number } | undefined; error?: unknown } }) {
  if (state.data) return <>{formatCount(state.data.total)}</>;
  if (state.error) return <span className="text-sm text-rose-600">خطا</span>;
  return <Skeleton className="h-7 w-12" />;
}

export default function VendorDashboardPage() {
  const { me } = useSession();
  const awaiting = useApi<Page<VendorSubOrderSummary>>('/vendor/orders', { status: 'PENDING_APPROVAL', pageSize: 5 });
  const processing = usePackageCount('PROCESSING');
  const shipped = usePackageCount('SHIPPED');
  const disputes = useApi<Page<VendorDispute>>('/vendor/disputes', { status: 'OPEN', pageSize: 1 });
  const wallet = useApi<WalletSummary>('/vendor/wallet');

  return (
    <>
      <PageHeader title={`پیشخوان ${me?.vendor?.storeName ?? 'فروشگاه'}`} description="نمای کلی سفارش‌ها و کیف پول" />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="در انتظار تأیید" value={<CountValue state={awaiting} />} icon={<Clock className="size-5" />} tone="warning" />
        <StatCard label="در حال پردازش" value={<CountValue state={processing} />} icon={<PackageCheck className="size-5" />} tone="info" />
        <StatCard label="ارسال‌شده" value={<CountValue state={shipped} />} icon={<Truck className="size-5" />} />
        <StatCard label="اختلاف‌های باز" value={<CountValue state={disputes} />} icon={<Scale className="size-5" />} tone={disputes.data && disputes.data.total > 0 ? 'danger' : 'neutral'} />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_340px]">
        <Card title="مرسوله‌های در انتظار تأیید" action={<Link href="/vendor/orders" className="flex items-center gap-1 text-sm text-brand-700">همه <ChevronLeft className="size-4" /></Link>}>
          {awaiting.loading && !awaiting.data ? (
            <SkeletonRows rows={3} />
          ) : awaiting.error && !awaiting.data ? (
            <ErrorState error={awaiting.error} onRetry={() => void awaiting.reload()} />
          ) : awaiting.data && awaiting.data.items.length === 0 ? (
            <EmptyState icon={<PackageCheck className="size-8" />} title="مرسوله‌ای در انتظار تأیید نیست" />
          ) : awaiting.data ? (
            <Table head={['مرسوله', 'اقلام', 'سهم شما', 'ثبت', 'وضعیت']}>
              {awaiting.data.items.map((sub) => (
                <tr key={sub.id}>
                  <Td>
                    <Link href={`/vendor/orders?focus=${sub.id}`} dir="ltr" className="font-mono text-xs text-brand-700 hover:underline">
                      {sub.subOrderNumber}
                    </Link>
                  </Td>
                  <Td>{toPersianDigits(sub.itemCount)}</Td>
                  <Td>
                    <Money rials={sub.vendorEarningsAmount} />
                  </Td>
                  <Td className="text-xs text-slate-500">{formatDateTime(sub.paidAt ?? sub.placedAt)}</Td>
                  <Td>
                    <StatusBadge value={sub.status} map={SUB_ORDER_STATUS} />
                  </Td>
                </tr>
              ))}
            </Table>
          ) : null}
        </Card>

        <Card
          title={
            <span className="flex items-center gap-2">
              <Wallet className="size-5 text-brand-600" /> کیف پول
            </span>
          }
        >
          {wallet.loading && !wallet.data ? (
            <Skeleton className="h-40" />
          ) : wallet.error && !wallet.data ? (
            <ErrorState error={wallet.error} onRetry={() => void wallet.reload()} />
          ) : wallet.data ? (
            <div className="flex flex-col gap-3 text-sm">
              <div>
                <div className="text-xs text-slate-500">قابل برداشت</div>
                <Money rials={wallet.data.withdrawableBalance} className="text-2xl font-black text-emerald-700" />
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">در انتظار تحویل (امانی)</span>
                <Money rials={wallet.data.pendingBalance} />
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">در حال تسویه</span>
                <Money rials={wallet.data.settlementHoldBalance} />
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">مسدود (اختلاف)</span>
                <Money rials={wallet.data.disputeHoldBalance} />
              </div>
              <div className="flex justify-between border-t border-slate-100 pt-2">
                <span className="text-slate-500">کل درآمد</span>
                <Money rials={wallet.data.totalEarnedBalance} className="font-bold" />
              </div>
              <LinkButton href="/vendor/wallet" variant="secondary" size="sm">
                درخواست تسویه
              </LinkButton>
            </div>
          ) : null}
        </Card>
      </div>

      {me?.vendor?.storeSlug ? (
        <div className="mt-6">
          <TorobFeedCard storeSlug={me.vendor.storeSlug} />
        </div>
      ) : null}
    </>
  );
}
