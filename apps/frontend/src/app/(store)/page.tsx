import { ArrowLeft, BadgeCheck, CalendarClock, LayoutGrid, ShieldCheck, Sparkles, Truck } from 'lucide-react';
import Link from 'next/link';

import { ProductGrid } from '@/components/catalog/product-card';
import { HeroCarousel } from '@/components/home/hero-carousel';
import { LinkButton } from '@/components/ui/button';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { loadBranding } from '@/lib/api/branding.server';
import { isBnplEnabled, loadCategoryTree, loadCreditPlans, loadProducts } from '@/lib/api/catalog.server';
import type { InstallmentPlan } from '@/lib/api/types';
import { formatCount, formatPercent, toPersianDigits } from '@/lib/format';
import { PLATFORM_NAME } from '@/lib/brand';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const [tree, popular, newest, plans, branding] = await Promise.all([
    loadCategoryTree(),
    loadProducts({ sortBy: 'popular', pageSize: 8, inStockOnly: true }),
    loadProducts({ sortBy: 'newest', pageSize: 8 }),
    loadCreditPlans(),
    loadBranding(),
  ]);
  const bnpl = isBnplEnabled(plans);
  const planItems: InstallmentPlan[] = plans.ok ? plans.data.items : [];
  const zeroInterest = planItems.filter((plan) => Number(plan.interestRatePercent) === 0);

  return (
    <div className="flex flex-col gap-12">
      {/* Hero: the admin-managed banner carousel when there are active banners, otherwise the default hero. */}
      {branding.heroBanners.length > 0 ? (
        <HeroCarousel banners={branding.heroBanners} />
      ) : (
        <section className="relative overflow-hidden rounded-3xl bg-gradient-to-l from-brand-700 via-brand-600 to-sky-500 px-6 py-12 text-white md:px-12 md:py-16">
          <div className="relative z-10 flex max-w-2xl flex-col gap-5">
            <span className="inline-flex w-fit items-center gap-1.5 rounded-full bg-white/15 px-3 py-1 text-xs font-medium">
              <Sparkles className="size-3.5" /> بازار آنلاین چندفروشندگی
            </span>
            <h1 className="text-3xl font-black leading-tight md:text-5xl">هر چه می‌خواهید، از فروشگاه‌های تأییدشده؛ نقدی یا اقساطی</h1>
            <p className="text-sm leading-7 text-white/85 md:text-base">
              پول شما تا زمان تحویل کالا نزد {PLATFORM_NAME} امانت می‌ماند. سفارش از چند فروشگاه را یک‌جا پرداخت کنید و هر مرسوله را جداگانه پیگیری کنید.
            </p>
            <div className="flex flex-wrap gap-3">
              <LinkButton href="/search" variant="secondary" size="lg" className="border-0 text-brand-700">
                شروع خرید <ArrowLeft className="size-4" />
              </LinkButton>
              {bnpl ? (
                <LinkButton href="/customer/credit" size="lg" className="bg-white/15 hover:bg-white/25">
                  دریافت اعتبار خرید
                </LinkButton>
              ) : null}
            </div>
            {tree.ok ? (
              <p className="text-xs text-white/75">
                {formatCount(tree.data.totalProducts)} محصول در {formatCount(tree.data.totalCategories)} دسته‌بندی
              </p>
            ) : null}
          </div>
          <div className="pointer-events-none absolute -bottom-24 -left-24 size-80 rounded-full bg-white/10" />
          <div className="pointer-events-none absolute -top-16 left-40 size-48 rounded-full bg-white/10" />
        </section>
      )}

      {/* Trust strip */}
      <section className="grid gap-3 sm:grid-cols-3">
        {[
          { icon: ShieldCheck, title: 'پرداخت امن و امانی', text: 'مبلغ تا تأیید تحویل به فروشنده پرداخت نمی‌شود.' },
          { icon: BadgeCheck, title: 'فروشندگان احرازشده', text: 'مدارک هویتی و حساب بانکی هر فروشگاه بررسی می‌شود.' },
          { icon: Truck, title: 'پیگیری هر مرسوله', text: 'کد رهگیری و وضعیت هر بسته جداگانه نمایش داده می‌شود.' },
        ].map((item) => (
          <div key={item.title} className="flex items-start gap-3 rounded-2xl border border-slate-200 bg-white p-4">
            <item.icon className="mt-0.5 size-6 shrink-0 text-brand-600" />
            <div>
              <p className="text-sm font-bold text-slate-900">{item.title}</p>
              <p className="mt-1 text-xs leading-6 text-slate-500">{item.text}</p>
            </div>
          </div>
        ))}
      </section>

      {/* Category grid */}
      <section className="flex flex-col gap-4">
        <SectionTitle icon={<LayoutGrid className="size-5" />} title="دسته‌بندی‌ها" href="/search" />
        {!tree.ok ? (
          <ErrorState error={tree.message} title="دسته‌بندی‌ها بارگذاری نشد" />
        ) : tree.data.items.length === 0 ? (
          <EmptyState title="هنوز دسته‌بندی فعالی وجود ندارد" />
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {tree.data.items.map((category) => (
              <Link
                key={category.id}
                href={`/categories/${category.slug}`}
                className="flex flex-col items-center gap-2 rounded-2xl border border-slate-200 bg-white p-4 text-center transition hover:border-brand-300 hover:shadow-sm"
              >
                <span className="flex size-12 items-center justify-center rounded-2xl bg-brand-50 text-lg font-black text-brand-700">{category.titleFa.charAt(0)}</span>
                <span className="text-sm font-bold text-slate-800">{category.titleFa}</span>
                <span className="text-xs text-slate-500">{formatCount(category.totalProductCount)} محصول</span>
              </Link>
            ))}
          </div>
        )}
      </section>

      {/* BNPL promo — driven by the live installment plans */}
      {bnpl ? (
        <section className="grid items-center gap-6 overflow-hidden rounded-3xl border border-emerald-200 bg-gradient-to-l from-emerald-50 to-white p-6 md:grid-cols-[1.2fr_1fr] md:p-10">
          <div className="flex flex-col gap-4">
            <span className="inline-flex w-fit items-center gap-1.5 rounded-full bg-emerald-600 px-3 py-1 text-xs font-bold text-white">
              <CalendarClock className="size-3.5" /> الان بخر، بعداً پرداخت کن
            </span>
            <h2 className="text-2xl font-black text-slate-900 md:text-3xl">
              {zeroInterest.length > 0
                ? `خرید اقساطی ${toPersianDigits(zeroInterest[0]!.durationMonths)} ماهه بدون سود`
                : 'خرید اقساطی با اعتبار بانکی'}
            </h2>
            <p className="text-sm leading-7 text-slate-600">
              با یک بار دریافت اعتبار از {plans.ok && plans.data.provider ? plans.data.provider.name : 'بانک همکار'}، سبد خرید خود را از همهٔ فروشگاه‌ها به‌صورت اقساطی پرداخت کنید. اگر اعتبارتان کمتر از مبلغ سفارش باشد، باقی‌مانده را با کارت بانکی بپردازید.
            </p>
            <div>
              <LinkButton href="/customer/credit" variant="success">
                درخواست اعتبار
              </LinkButton>
            </div>
          </div>
          <ul className="grid gap-3">
            {planItems.map((plan) => (
              <li key={plan.id} className="flex items-center justify-between rounded-2xl border border-emerald-100 bg-white px-4 py-3">
                <span className="text-sm font-bold text-slate-800">{plan.title}</span>
                <span className="text-xs text-slate-600">
                  {toPersianDigits(plan.durationMonths)} قسط ·{' '}
                  {Number(plan.interestRatePercent) === 0 ? <b className="text-emerald-700">بدون سود</b> : `سود کل ${formatPercent(plan.interestRatePercent)}`}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* Featured (best sellers) */}
      <section className="flex flex-col gap-4">
        <SectionTitle icon={<Sparkles className="size-5" />} title="پرفروش‌ترین‌ها" href="/search?sort=popular" />
        {!popular.ok ? (
          <ErrorState error={popular.message} title="محصولات بارگذاری نشد" />
        ) : popular.data.items.length === 0 ? (
          <EmptyState title="هنوز محصولی برای نمایش وجود ندارد" description="به‌محض انتشار محصولات توسط فروشندگان، این بخش پر می‌شود." />
        ) : (
          <ProductGrid products={popular.data.items} bnplEnabled={bnpl} />
        )}
      </section>

      <section className="flex flex-col gap-4">
        <SectionTitle title="تازه‌ترین محصولات" href="/search?sort=newest" />
        {!newest.ok ? (
          <ErrorState error={newest.message} title="محصولات بارگذاری نشد" />
        ) : newest.data.items.length === 0 ? (
          <EmptyState title="محصولی ثبت نشده است" />
        ) : (
          <ProductGrid products={newest.data.items} bnplEnabled={bnpl} />
        )}
      </section>
    </div>
  );
}

function SectionTitle({ title, href, icon }: { title: string; href: string; icon?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <h2 className="flex items-center gap-2 text-lg font-black text-slate-900 md:text-xl">
        {icon ? <span className="text-brand-600">{icon}</span> : null}
        {title}
      </h2>
      <Link href={href} className="inline-flex items-center gap-1 text-sm font-medium text-brand-700 hover:underline">
        مشاهدهٔ همه <ArrowLeft className="size-4" />
      </Link>
    </div>
  );
}
