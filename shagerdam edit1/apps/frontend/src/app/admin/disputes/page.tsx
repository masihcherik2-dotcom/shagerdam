'use client';

import { DisputeList } from '@/components/disputes/dispute-list';
import { PageHeader } from '@/components/ui/misc';
import type { AdminDisputeSummary } from '@/lib/api/types';

export default function AdminDisputesPage() {
  return (
    <>
      <PageHeader title="داوری اختلاف‌ها" description="پرونده‌های در انتظار داوری را بررسی و رأی نهایی صادر کنید." />
      <DisputeList<AdminDisputeSummary>
        endpoint="/admin/disputes"
        hrefBase="/admin/disputes"
        emptyText="پرونده‌ای با این وضعیت وجود ندارد."
        partyColumn={{ head: 'خریدار', cell: (dispute) => <span>{dispute.customer.name}</span> }}
      />
    </>
  );
}
