import { Home, Search, SearchX } from 'lucide-react';
import type { Metadata } from 'next';

import { LinkButton } from '@/components/ui/button';
import { PLATFORM_NAME } from '@/lib/brand';

export const metadata: Metadata = {
  title: 'صفحه پیدا نشد',
  description: `صفحهٔ درخواستی در ${PLATFORM_NAME} پیدا نشد. از جست‌وجو یا صفحهٔ اصلی استفاده کنید.`,
  robots: { index: false, follow: true },
};

/** 404 for unknown URLs and for missing/unpublished products and categories. */
export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-[70vh] max-w-lg flex-col items-center justify-center gap-5 px-4 text-center">
      <span className="flex size-16 items-center justify-center rounded-full bg-slate-100 text-slate-500">
        <SearchX className="size-8" aria-hidden="true" />
      </span>
      <p className="text-5xl font-black text-brand-600" aria-hidden="true">
        ۴۰۴
      </p>
      <h1 className="text-xl font-black">صفحه یا محصول مورد نظر پیدا نشد</h1>
      <p className="text-sm leading-7 text-slate-600">ممکن است نشانی اشتباه باشد یا این محصول دیگر منتشر نشود. نام کالا را جست‌وجو کنید:</p>
      {/* Plain GET form: works without JavaScript and lands on the real search page. */}
      <form action="/search" method="get" role="search" className="flex w-full gap-2">
        <label htmlFor="not-found-search" className="sr-only">
          جست‌وجوی محصولات
        </label>
        <input
          id="not-found-search"
          name="q"
          type="search"
          required
          maxLength={100}
          placeholder="مثلاً گوشی، تیشرت، لپ‌تاپ…"
          className="h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm placeholder:text-slate-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100"
        />
        <button type="submit" className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-xl bg-brand-600 px-4 text-sm font-bold text-white hover:bg-brand-700">
          <Search className="size-4" aria-hidden="true" /> جست‌وجو
        </button>
      </form>
      <LinkButton href="/" variant="secondary" icon={<Home className="size-4" />}>
        بازگشت به صفحهٔ اصلی
      </LinkButton>
    </main>
  );
}
