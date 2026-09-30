import { ShieldX } from 'lucide-react';
import type { Metadata } from 'next';

import { LinkButton } from '@/components/ui/button';
import { safeNextPath } from '@/lib/auth/access';

export const metadata: Metadata = { title: 'دسترسی مجاز نیست', robots: { index: false } };

export default async function ForbiddenPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const params = await searchParams;
  const home = safeNextPath(params.home) ?? '/';
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-4 rounded-3xl border border-slate-200 bg-white p-8 text-center">
      <span className="flex size-16 items-center justify-center rounded-full bg-rose-50 text-rose-600">
        <ShieldX className="size-8" />
      </span>
      <h1 className="text-xl font-black">دسترسی به این بخش مجاز نیست</h1>
      <p className="text-sm leading-7 text-slate-600">نقش حساب کاربری شما اجازهٔ ورود به این صفحه را نمی‌دهد. اگر فکر می‌کنید اشتباهی رخ داده، با پشتیبانی تماس بگیرید.</p>
      <LinkButton href={home}>رفتن به پنل من</LinkButton>
    </div>
  );
}
