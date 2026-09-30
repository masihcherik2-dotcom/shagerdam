import type { Metadata } from 'next';
import Link from 'next/link';

import { SystemHealthPanel } from '@/components/system-health-panel';
import { getPublicStatusServerSide } from '@/lib/api/health.server';
import type { PublicStatusReport } from '@/lib/api/types';
import { PLATFORM_NAME } from '@/lib/brand';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'وضعیت سامانه',
  description: `وضعیت لحظه‌ای سرویس‌های ${PLATFORM_NAME}: فروشگاه، سفارش، پرداخت، خرید اقساطی و ورود.`,
  alternates: { canonical: '/status' },
};

export default async function StatusPage() {
  let initialReport: PublicStatusReport | null = null;
  let initialError: string | null = null;
  try {
    initialReport = await getPublicStatusServerSide();
  } catch {
    initialError = 'ارتباط با سامانه برقرار نشد؛ ممکن است سرویس موقتاً در دسترس نباشد.';
  }

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-6 py-14">
      <header className="flex flex-col gap-2">
        <Link href="/" className="text-sm font-medium text-brand-600 hover:text-brand-700">
          {PLATFORM_NAME}
        </Link>
        <h1 className="text-3xl font-bold text-slate-900">وضعیت سامانه</h1>
        <p className="text-sm leading-6 text-slate-600">وضعیت لحظه‌ای بخش‌های اصلی {PLATFORM_NAME}. اگر در خرید یا پرداخت با مشکل روبه‌رو شدید و این صفحه اختلالی نشان نمی‌دهد، از صفحهٔ تماس با ما اطلاع دهید.</p>
      </header>

      <SystemHealthPanel initialReport={initialReport} initialError={initialError} />

      <footer className="flex flex-wrap gap-4 border-t border-slate-200 pt-4 text-xs text-slate-500">
        <Link href="/" className="hover:text-brand-700">
          بازگشت به فروشگاه
        </Link>
        <Link href="/contact" className="hover:text-brand-700">
          تماس با پشتیبانی
        </Link>
      </footer>
    </main>
  );
}
