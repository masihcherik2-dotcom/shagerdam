import { ArrowLeft, BadgeCheck, CalendarClock, ClipboardList, FileCheck2, Import, PackageCheck, Percent, ShieldCheck, Store, Truck, Wallet } from 'lucide-react';
import type { Metadata } from 'next';

import { CategoryIcon } from '@/components/home/category-icon';
import { LinkButton } from '@/components/ui/button';
import { ErrorState } from '@/components/ui/states';
import { isBnplEnabled, loadCategoryTree, loadCreditPlans } from '@/lib/api/catalog.server';
import type { CategoryTreeNode } from '@/lib/api/types';
import { PLATFORM_NAME } from '@/lib/brand';
import { formatCount, formatPercent } from '@/lib/format';

/** Category data (commission rates) is cached for 10 minutes; admin changes appear after that. */
export const revalidate = 600;

export const metadata: Metadata = {
  title: 'فروشنده شوید',
  description: `فروشگاه خود را در ${PLATFORM_NAME} ثبت کنید: کارمزد شفاف برای هر دسته‌بندی، تسویه به شبای شما و دسترسی به خریداران نقدی و اقساطی.`,
  alternates: { canonical: '/vendor/landing' },
};

const REGISTER_HREF = '/vendor/register';

/** Commission range of a root and its descendants, from the live category tree. */
function commissionRange(node: CategoryTreeNode): { min: number; max: number } {
  const rates: number[] = [];
  const walk = (entry: CategoryTreeNode): void => {
    const rate = Number(entry.defaultCommissionRate);
    if (Number.isFinite(rate)) rates.push(rate);
    entry.children.forEach(walk);
  };
  walk(node);
  return rates.length > 0 ? { min: Math.min(...rates), max: Math.max(...rates) } : { min: 0, max: 0 };
}

function RangeText({ min, max }: { min: number; max: number }) {
  return <>{min === max ? formatPercent(min) : `${formatPercent(min)} تا ${formatPercent(max)}`}</>;
}

export default async function VendorLandingPage() {
  const [tree, plans] = await Promise.all([loadCategoryTree(600), loadCreditPlans(600)]);
  const bnpl = isBnplEnabled(plans);

  const benefits = [
    { icon: Store, title: 'فروشگاه اختصاصی', text: 'صفحهٔ فروشگاه با لوگو، معرفی و اینستاگرام شما؛ محصولات در جست‌وجو و دسته‌بندی‌ها دیده می‌شوند.' },
    ...(bnpl ? [{ icon: CalendarClock, title: 'فروش اقساطی بدون ریسک', text: 'خریدار قسطی می‌خرد، شما مبلغ کامل را دریافت می‌کنید؛ وصول اقساط با تأمین‌کنندهٔ اعتبار است.' }] : []),
    { icon: Wallet, title: 'تسویه به شبای شما', text: 'سهم هر سفارش پس از تأیید تحویل در کیف پول فروشگاه آزاد می‌شود و به شبای تأییدشده تسویه می‌گردد.' },
    { icon: ShieldCheck, title: 'پرداخت امن', text: 'پول خریدار تا تحویل نزد پلتفرم امانت است؛ برای شما و مشتری اعتماد می‌سازد.' },
    { icon: Import, title: 'ثبت سریع محصول', text: 'محصولات را دستی یا با درون‌ریزی از لینک کالا (عنوان، تصاویر و مشخصات) ثبت کنید.' },
    { icon: Truck, title: 'مدیریت سفارش و ارسال', text: 'هر سفارش با وضعیت، کد رهگیری و پیگیری جداگانه در پنل فروشنده.' },
  ];

  const steps = [
    { icon: ClipboardList, title: 'ثبت‌نام و ساخت فروشگاه', text: 'با شمارهٔ موبایل وارد شوید و نام فروشگاه، نشانی اینترنتی و شبای خود را وارد کنید.' },
    { icon: FileCheck2, title: 'ارسال مدارک و تأیید', text: 'تصویر کارت ملی و گواهی شبا را بارگذاری کنید؛ کارشناسان مدارک را بررسی و فروشگاه را تأیید می‌کنند.' },
    { icon: PackageCheck, title: 'ثبت محصول و شروع فروش', text: 'محصولات را با قیمت، موجودی و تصاویر ثبت کنید و سفارش‌ها را از پنل فروشنده ارسال کنید.' },
  ];

  return (
    <div className="flex flex-col gap-14">
      <section className="relative overflow-hidden rounded-3xl bg-gradient-to-l from-brand-700 via-brand-600 to-indigo-500 px-6 py-12 text-white md:px-12 md:py-16" data-testid="vendor-landing-hero">
        <div className="relative z-10 flex max-w-2xl flex-col gap-5">
          <span className="inline-flex w-fit items-center gap-1.5 rounded-full bg-white/15 px-3 py-1 text-xs font-medium">
            <BadgeCheck className="size-3.5" aria-hidden="true" /> فروشنده شوید
          </span>
          <h1 className="text-3xl font-black leading-tight md:text-5xl">کسب‌وکار خود را در {PLATFORM_NAME} گسترش دهید</h1>
          <p className="text-sm leading-7 text-white/85 md:text-base">
            به خریدارانی بفروشید که نقدی{bnpl ? ' یا اقساطی' : ''} خرید می‌کنند. کارمزد هر دسته‌بندی از پیش مشخص است و فقط از فروش موفق کسر می‌شود.
          </p>
          <div className="flex flex-col gap-3 sm:flex-row">
            <LinkButton href={REGISTER_HREF} variant="secondary" size="lg" className="border-0 text-brand-700" data-testid="vendor-landing-cta">
              شروع ثبت‌نام فروشنده <ArrowLeft className="size-4" aria-hidden="true" />
            </LinkButton>
            <LinkButton href="#commission" size="lg" className="bg-white/15 hover:bg-white/25">
              جدول کارمزدها
            </LinkButton>
          </div>
          {tree.ok ? (
            <p className="text-xs text-white/75">
              {formatCount(tree.data.totalProducts)} محصول در {formatCount(tree.data.totalCategories)} دسته‌بندی
            </p>
          ) : null}
        </div>
        <div className="pointer-events-none absolute -bottom-24 -left-24 size-80 rounded-full bg-white/10" />
      </section>

      <section className="flex flex-col gap-5" aria-labelledby="benefits-title">
        <h2 id="benefits-title" className="text-xl font-black text-slate-900 md:text-2xl">چرا {PLATFORM_NAME}؟</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="vendor-benefits">
          {benefits.map((item) => (
            <div key={item.title} className="flex items-start gap-3 rounded-2xl border border-slate-200 bg-white p-5">
              <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-700">
                <item.icon className="size-5" aria-hidden="true" />
              </span>
              <div>
                <p className="font-bold text-slate-900">{item.title}</p>
                <p className="mt-1 text-sm leading-7 text-slate-600">{item.text}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section id="commission" className="flex scroll-mt-24 flex-col gap-5" aria-labelledby="commission-title">
        <div className="flex flex-col gap-1">
          <h2 id="commission-title" className="flex items-center gap-2 text-xl font-black text-slate-900 md:text-2xl">
            <Percent className="size-5 text-brand-600" aria-hidden="true" /> کارمزد هر دسته‌بندی
          </h2>
          <p className="text-sm text-slate-600">درصد از مبلغ فروش هر کالا، هنگام تسویه کسر می‌شود. نرخ‌ها همان نرخ‌های جاری سامانه‌اند.</p>
        </div>
        {!tree.ok ? (
          <ErrorState error={tree.message} title="جدول کارمزد بارگذاری نشد" />
        ) : (
          <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
            <table className="w-full text-sm" data-testid="commission-table">
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  <th scope="col" className="px-4 py-3 text-start font-medium">دسته‌بندی</th>
                  <th scope="col" className="hidden px-4 py-3 text-start font-medium md:table-cell">زیردسته‌ها</th>
                  <th scope="col" className="px-4 py-3 text-start font-medium">کارمزد</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {tree.data.items.map((root) => (
                  <tr key={root.id} data-testid="commission-row">
                    <td className="px-4 py-3">
                      <span className="flex items-center gap-2 font-bold text-slate-800">
                        <CategoryIcon slug={root.slug} className="size-4 text-brand-600" />
                        {root.titleFa}
                      </span>
                    </td>
                    <td className="hidden px-4 py-3 text-slate-600 md:table-cell">
                      {root.children.length > 0
                        ? root.children.map((child) => `${child.titleFa} (${formatPercent(child.defaultCommissionRate)})`).join('، ')
                        : '—'}
                    </td>
                    <td className="px-4 py-3 font-bold text-brand-700">
                      <RangeText {...commissionRange(root)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="flex flex-col gap-5" aria-labelledby="steps-title">
        <h2 id="steps-title" className="text-xl font-black text-slate-900 md:text-2xl">شروع فروش در ۳ گام</h2>
        <ol className="grid gap-4 md:grid-cols-3" data-testid="vendor-steps">
          {steps.map((step, index) => (
            <li key={step.title} className="relative flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-5">
              <span className="flex size-10 items-center justify-center rounded-full bg-brand-600 text-lg font-black text-white">{formatCount(index + 1)}</span>
              <p className="flex items-center gap-2 font-bold text-slate-900">
                <step.icon className="size-5 text-brand-600" aria-hidden="true" />
                {step.title}
              </p>
              <p className="text-sm leading-7 text-slate-600">{step.text}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="flex flex-col items-center gap-4 rounded-3xl border border-brand-200 bg-brand-50 px-6 py-10 text-center">
        <h2 className="text-xl font-black text-slate-900 md:text-2xl">آماده‌اید؟</h2>
        <p className="max-w-xl text-sm leading-7 text-slate-600">ثبت‌نام با شمارهٔ موبایل انجام می‌شود. اگر حساب ندارید، پس از ورود با کد یک‌بارمصرف به فرم ساخت فروشگاه هدایت می‌شوید.</p>
        <LinkButton href={REGISTER_HREF} size="lg">
          ساخت فروشگاه <ArrowLeft className="size-4" aria-hidden="true" />
        </LinkButton>
      </section>
    </div>
  );
}
