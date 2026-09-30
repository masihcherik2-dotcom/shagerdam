'use client';

import { DisputeList } from '@/components/disputes/dispute-list';
import { PageHeader } from '@/components/ui/misc';
import type { VendorDispute } from '@/lib/api/types';

export default function VendorDisputesPage() {
  return (
    <>
      <PageHeader title="اختلاف‌ها" description="به اختلاف‌های باز پاسخ دهید: پذیرش مرجوعی یا ارسال دفاعیه برای داوری." />
      <DisputeList<VendorDispute>
        endpoint="/vendor/disputes"
        hrefBase="/vendor/disputes"
        emptyText="اختلافی برای فروشگاه شما ثبت نشده است."
        partyColumn={{ head: 'خریدار', cell: (dispute) => <span>{dispute.customerName}</span> }}
      />
    </>
  );
}
