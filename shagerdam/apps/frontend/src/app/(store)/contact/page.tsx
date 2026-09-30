import { Clock, Headphones, Mail, MapPin, MessageSquareText, Phone, Scale } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { ContactForm } from '@/components/support/contact-form';
import { loadSiteInfo } from '@/lib/api/site-info.server';
import { PLATFORM_NAME } from '@/lib/brand';
import { toPersianDigits } from '@/lib/format';
import { telHref } from '@/lib/site-info';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'تماس با ما',
  description: `راه‌های تماس با پشتیبانی ${PLATFORM_NAME}: تلفن، ایمیل، نشانی دفتر مرکزی، ساعات کاری و فرم ارسال پیام.`,
  alternates: { canonical: '/contact' },
  openGraph: { title: `تماس با ما | ${PLATFORM_NAME}`, url: '/contact' },
};

function InfoCard({ icon: Icon, title, children }: { icon: typeof Phone; title: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3 rounded-2xl border border-slate-200 bg-white p-4">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-700">
        <Icon className="size-5" aria-hidden="true" />
      </span>
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="text-xs text-slate-500">{title}</p>
        <div className="text-sm font-medium leading-7 text-slate-800">{children}</div>
      </div>
    </div>
  );
}

export default async function ContactPage() {
  const info = await loadSiteInfo();
  const hasDirectChannel = Boolean(info.supportPhone || info.supportEmail || info.officeAddress || info.workingHours);

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-8">
      <header className="flex flex-col gap-4 rounded-3xl border border-slate-200 bg-gradient-to-l from-brand-50 to-white p-6 sm:flex-row sm:items-start sm:p-8">
        <span className="flex size-14 shrink-0 items-center justify-center rounded-2xl bg-brand-600 text-white shadow-sm">
          <Headphones className="size-7" aria-hidden="true" />
        </span>
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium text-brand-700">پشتیبانی {PLATFORM_NAME}</p>
          <h1 className="text-2xl font-black text-slate-900 sm:text-3xl">تماس با ما</h1>
          <p className="text-sm leading-7 text-slate-600">سؤال، پیشنهاد یا مشکلی دارید؟ از راه‌های زیر یا با فرم پیام با ما در ارتباط باشید. برای مرجوعی و اختلاف سفارش، سامانهٔ حل اختلاف سریع‌ترین مسیر است.</p>
        </div>
      </header>

      <div className="grid gap-8 lg:grid-cols-[1fr_22rem]">
        <section aria-labelledby="contact-form-title" className="rounded-2xl border border-slate-200 bg-white p-6">
          <h2 id="contact-form-title" className="mb-1 flex items-center gap-2 text-lg font-bold text-slate-900">
            <MessageSquareText className="size-5 text-brand-600" aria-hidden="true" /> ارسال پیام به پشتیبانی
          </h2>
          <p className="mb-5 text-sm text-slate-500">پیام شما ثبت و با کد پیگیری به کارشناسان پشتیبانی ارجاع می‌شود.</p>
          <ContactForm />
        </section>

        <aside className="flex flex-col gap-3" aria-label="اطلاعات تماس">
          {info.supportPhone ? (
            <InfoCard icon={Phone} title="تلفن پشتیبانی">
              <a href={telHref(info.supportPhone)} dir="ltr" className="hover:text-brand-700">
                {toPersianDigits(info.supportPhone)}
              </a>
            </InfoCard>
          ) : null}
          {info.supportEmail ? (
            <InfoCard icon={Mail} title="ایمیل">
              <a href={`mailto:${info.supportEmail}`} dir="ltr" className="break-all hover:text-brand-700">
                {info.supportEmail}
              </a>
            </InfoCard>
          ) : null}
          {info.workingHours ? (
            <InfoCard icon={Clock} title="ساعات کاری">
              {info.workingHours}
            </InfoCard>
          ) : null}
          {info.officeAddress ? (
            <InfoCard icon={MapPin} title="نشانی دفتر مرکزی">
              <address className="not-italic">
                {info.officeAddress}
                {info.postalCode ? <span className="block text-xs text-slate-500">کد پستی: {toPersianDigits(info.postalCode)}</span> : null}
              </address>
            </InfoCard>
          ) : null}
          {!hasDirectChannel ? <p className="rounded-2xl border border-slate-200 bg-white p-4 text-sm leading-7 text-slate-600">راه‌های تماس مستقیم به‌زودی در این بخش اعلام می‌شود؛ تا آن زمان از فرم پیام استفاده کنید.</p> : null}

          <Link href="/customer/disputes" className="flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 hover:bg-amber-100">
            <Scale className="mt-0.5 size-5 shrink-0 text-amber-700" aria-hidden="true" />
            <span className="text-sm leading-6 text-amber-900">
              <strong className="block">مرجوعی یا مشکل در سفارش؟</strong>
              درخواست خود را در سامانهٔ حل اختلاف ثبت کنید تا وجه تا پایان رسیدگی مسدود بماند.
            </span>
          </Link>
        </aside>
      </div>
    </div>
  );
}
