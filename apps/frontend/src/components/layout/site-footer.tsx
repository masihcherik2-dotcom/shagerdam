import Link from 'next/link';

import { loadBranding } from '@/lib/api/branding.server';
import { PLATFORM_NAME, PLATFORM_TAGLINE } from '@/lib/brand';

import { BrandLogo } from './brand-logo';

export async function SiteFooter() {
  const branding = await loadBranding();
  return (
    <footer className="mt-16 border-t border-slate-200 bg-white">
      <div className="mx-auto grid max-w-7xl gap-8 px-4 py-10 text-sm text-slate-600 md:grid-cols-3">
        <div className="flex flex-col gap-2">
          <BrandLogo variant="footer" logoUrl={branding.logoUrl} />
          <p className="text-xs font-medium text-slate-500">{PLATFORM_TAGLINE}</p>
          <p className="leading-7">بازار آنلاین چندفروشندگی با پرداخت امن درگاه بانکی و خرید اقساطی. پول شما تا تحویل کالا نزد {PLATFORM_NAME} امانت می‌ماند.</p>
        </div>
        <nav className="flex flex-col gap-2" aria-label="خرید">
          <p className="font-bold text-slate-800">خرید</p>
          <Link href="/search" className="hover:text-brand-700">همهٔ محصولات</Link>
          <Link href="/search?sort=popular" className="hover:text-brand-700">پرفروش‌ترین‌ها</Link>
          <Link href="/customer/credit" className="hover:text-brand-700">خرید اقساطی</Link>
        </nav>
        <nav className="flex flex-col gap-2" aria-label="همکاری">
          <p className="font-bold text-slate-800">همکاری</p>
          <Link href="/vendor/register" className="hover:text-brand-700">فروشنده شوید</Link>
          <Link href="/customer/disputes" className="hover:text-brand-700">پیگیری اختلاف و مرجوعی</Link>
          <Link href="/status" className="hover:text-brand-700">وضعیت سامانه</Link>
        </nav>
      </div>
    </footer>
  );
}
