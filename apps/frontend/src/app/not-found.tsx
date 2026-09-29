import { SearchX } from 'lucide-react';

import { LinkButton } from '@/components/ui/button';

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-[70vh] max-w-md flex-col items-center justify-center gap-4 px-4 text-center">
      <span className="flex size-16 items-center justify-center rounded-full bg-slate-100 text-slate-500">
        <SearchX className="size-8" />
      </span>
      <h1 className="text-xl font-black">صفحه یا محصول مورد نظر پیدا نشد</h1>
      <p className="text-sm leading-7 text-slate-600">ممکن است نشانی اشتباه باشد یا این محصول دیگر منتشر نشود.</p>
      <div className="flex gap-2">
        <LinkButton href="/">صفحهٔ اصلی</LinkButton>
        <LinkButton href="/search" variant="secondary">
          جست‌وجوی محصولات
        </LinkButton>
      </div>
    </main>
  );
}
