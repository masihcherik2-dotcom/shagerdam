'use client';

import { DisputeList } from '@/components/disputes/dispute-list';
import { PageHeader } from '@/components/ui/misc';

export default function CustomerDisputesPage() {
  return (
    <>
      <PageHeader title="اختلاف‌ها و مرجوعی‌ها" description="برای ثبت اختلاف جدید، از صفحهٔ جزئیات سفارش روی «ثبت اختلاف / مرجوعی» بزنید." />
      <DisputeList endpoint="/customer/disputes" hrefBase="/customer/disputes" emptyText="اختلافی ثبت نکرده‌اید." />
    </>
  );
}
