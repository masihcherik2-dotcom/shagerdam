import { ArrowLeft, Ban, Banknote, CalendarDays, ClipboardCheck, PackageOpen, RotateCcw, Scale, Undo2 } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';

import { Bullets, LegalPage, type LegalSection } from '@/components/legal/legal-page';
import { PLATFORM_NAME } from '@/lib/brand';

export const metadata: Metadata = {
  title: 'رویهٔ بازگرداندن کالا',
  description: `شرایط بازگشت کالا در ${PLATFORM_NAME}: ۷ روز مهلت بازگشت، استاندارد کالای مرجوعی، نحوهٔ ثبت درخواست در سامانهٔ حل اختلاف و بازگشت وجه.`,
  alternates: { canonical: '/returns' },
  openGraph: { title: `رویهٔ بازگرداندن کالا | ${PLATFORM_NAME}`, url: '/returns', type: 'article' },
};

const STEPS: ReadonlyArray<{ title: string; text: string }> = [
  { title: 'ثبت درخواست', text: 'در «اختلاف‌ها و مرجوعی» مرسوله را انتخاب و دلیل و تصاویر کالا را ثبت کنید.' },
  { title: 'مسدود شدن وجه', text: 'سهم فروشنده از همان لحظه مسدود می‌شود و به او پرداخت نمی‌شود.' },
  { title: 'پاسخ فروشنده', text: 'فروشنده بازگشت را می‌پذیرد یا با دفاعیه به داوری ارجاع می‌دهد.' },
  { title: 'داوری و رأی', text: `کارشناسان ${PLATFORM_NAME} بر اساس مدارک طرفین رأی نهایی را صادر می‌کنند.` },
];

const sections: LegalSection[] = [
  {
    id: 'window',
    title: 'مهلت ۷ روزه بازگشت',
    icon: CalendarDays,
    body: (
      <Bullets
        items={[
          'تا ۷ روز پس از تحویل مرسوله می‌توانید درخواست بازگشت کالا ثبت کنید.',
          'اگر کالا معیوب، آسیب‌دیده، تقلبی یا مغایر با مشخصات صفحهٔ محصول باشد، بازگشت بدون نیاز به دلیل دیگر پذیرفته می‌شود و هزینهٔ ارسال مرجوعی با فروشنده است.',
          'در انصراف از خرید (بدون ایراد کالا) کالا باید شرایط بخش «استاندارد کالای مرجوعی» را داشته باشد.',
          'برای مرسولهٔ در حال پردازش یا ارسال‌شده که به دستتان نرسیده نیز می‌توانید از همین مسیر درخواست ثبت کنید.',
        ]}
      />
    ),
  },
  {
    id: 'standard',
    title: 'استاندارد کالای مرجوعی',
    icon: ClipboardCheck,
    body: (
      <Bullets
        items={[
          'کالا استفاده نشده و در بسته‌بندی اصلی با همهٔ متعلقات، هدایا، دفترچه و برچسب‌ها باشد.',
          'پلمب کالاهایی که پلمب کارخانه دارند (مانند گوشی و لوازم الکترونیکی) باز نشده باشد، مگر برای اثبات ایراد.',
          'فاکتور و کارت گارانتی همراه کالا ارسال شود.',
          'پیش از ارسال، از کالا و بسته‌بندی عکس بگیرید و در درخواست خود پیوست کنید.',
        ]}
      />
    ),
  },
  {
    id: 'excluded',
    title: 'کالاهایی که در انصراف بازگشت ندارند',
    icon: Ban,
    body: (
      <>
        <p>به دلیل بهداشت یا ماهیت کالا، موارد زیر فقط در صورت ایراد یا مغایرت بازگشت‌پذیرند:</p>
        <Bullets items={['لباس زیر، مایو و جوراب', 'لوازم آرایشی، بهداشتی و عطر با پلمب باز', 'کالای سفارشی یا شخصی‌سازی‌شده', 'کارت هدیه، شارژ و محصولات دیجیتال پس از ارائهٔ کد']} />
      </>
    ),
  },
  {
    id: 'process',
    title: 'مراحل ثبت و رسیدگی',
    icon: RotateCcw,
    body: (
      <>
        <ol className="grid gap-3 sm:grid-cols-2">
          {STEPS.map((step, index) => (
            <li key={step.title} className="flex gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-brand-600 text-xs font-bold text-white">{(index + 1).toLocaleString('fa-IR')}</span>
              <span>
                <strong className="block text-slate-800">{step.title}</strong>
                <span className="text-xs leading-6 text-slate-600">{step.text}</span>
              </span>
            </li>
          ))}
        </ol>
        <p>پس از پذیرش بازگشت، کالا را طبق راهنمایی ثبت‌شده در درخواست برای فروشنده ارسال کنید و کد رهگیری مرسوله را در توضیحات درخواست درج کنید.</p>
      </>
    ),
  },
  {
    id: 'refund',
    title: 'بازگشت وجه',
    icon: Banknote,
    body: (
      <Bullets
        items={[
          'در رأی به نفع خریدار، مبلغ کالا به‌همراه هزینهٔ ارسال همان مرسوله قابل بازگشت است.',
          'چون سهم فروشنده از لحظهٔ ثبت درخواست مسدود شده، بازگشت وجه به پرداخت فروشنده وابسته نیست.',
          'وجه خریدهای نقدی توسط واحد مالی به حساب بانکی شما بازگردانده می‌شود؛ وضعیت درخواست و رأی در صفحهٔ همان اختلاف نمایش داده می‌شود.',
          'بازگشت وجه خریدهای اقساطی با هماهنگی تأمین‌کنندهٔ اعتبار و توسط کارشناسان پشتیبانی انجام می‌شود.',
        ]}
      />
    ),
  },
  {
    id: 'disputes',
    title: 'سامانهٔ حل اختلاف',
    icon: Scale,
    body: (
      <>
        <p>همهٔ درخواست‌های مرجوعی، عدم دریافت کالا و مغایرت از طریق سامانهٔ حل اختلاف ثبت و پیگیری می‌شوند؛ تمام پیام‌ها، مدارک و رأی نهایی در آن ثبت می‌شود.</p>
        <Link href="/customer/disputes" className="inline-flex w-fit items-center gap-2 rounded-xl bg-brand-600 px-5 py-2.5 text-sm font-bold text-white hover:bg-brand-700">
          <Undo2 className="size-4" aria-hidden="true" /> ورود به سامانهٔ حل اختلاف
          <ArrowLeft className="size-4" aria-hidden="true" />
        </Link>
      </>
    ),
  },
];

export default function ReturnsPage() {
  return (
    <LegalPage
      icon={PackageOpen}
      eyebrow="ضمانت بازگشت کالا"
      title="رویهٔ بازگرداندن کالا"
      current="/returns"
      summary={<p>اگر کالا مطابق انتظار نبود، تا ۷ روز پس از تحویل فرصت بازگشت دارید. تا پایان رسیدگی، پول فروشنده نزد {PLATFORM_NAME} مسدود می‌ماند.</p>}
      sections={sections}
      aside={
        <Link href="/customer/disputes" className="flex items-center justify-between gap-2 rounded-2xl border border-brand-200 bg-brand-50 p-4 text-sm font-bold text-brand-800 hover:bg-brand-100">
          ثبت درخواست مرجوعی
          <ArrowLeft className="size-4" aria-hidden="true" />
        </Link>
      }
    />
  );
}
