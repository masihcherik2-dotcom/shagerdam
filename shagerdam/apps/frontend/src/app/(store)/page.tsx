import { ArrowLeft, BadgeCheck, BadgePercent, CalendarClock, Flame, LayoutGrid, ShieldCheck, Sparkles, Store, Truck } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';

import { ProductGrid } from '@/components/catalog/product-card';
import { CategoryIcon } from '@/components/home/category-icon';
import { HeroCarousel } from '@/components/home/hero-carousel';
import { HomeHero } from '@/components/home/home-hero';
import { LinkButton } from '@/components/ui/button';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { loadBranding } from '@/lib/api/branding.server';
import { isBnplEnabled, loadCategoryTree, loadCreditPlans, loadProducts } from '@/lib/api/catalog.server';
import { REVALIDATE } from '@/lib/api/public.server';
import { loadSiteInfo } from '@/lib/api/site-info.server';
import type { InstallmentPlan } from '@/lib/api/types';
import { PLATFORM_NAME } from '@/lib/brand';
import { resolveSiteOrigin } from '@/lib/env';
import { formatCount, formatPercent, toPersianDigits } from '@/lib/format';
import { organizationJsonLd, serializeJsonLd, websiteJsonLd } from '@/lib/seo';

/** ISR window of the catalogue data (Data Cache); the HTML is rendered per request (session-aware header). */
export const revalidate = 60;

/** Only the home page is canonical to `/` (set per page — see app/layout.tsx). */
export const metadata: Metadata = { alternates: { canonical: '/' } };

export default async function HomePage() {
  const ttl = REVALIDATE.home;
  const [tree, popular, newest, offers, plans, branding, siteInfo] = await Promise.all([
    loadCategoryTree(ttl),
    loadProducts({ sortBy: 'popular', pageSize: 8, inStockOnly: true }, ttl),
    loadProducts({ sortBy: 'newest', pageSize: 8 }, ttl),
    // Special offers: in-stock discounted products (instalment-eligible when BNPL is on).
    loadProducts({ sortBy: 'popular', pageSize: 8, inStockOnly: true, onSaleOnly: true }, ttl),
    loadCreditPlans(ttl),
    loadBranding(),
    loadSiteInfo(),
  ]);
  const bnpl = isBnplEnabled(plans);
  const planItems: InstallmentPlan[] = plans.ok ? plans.data.items : [];
  const zeroInterest = planItems.filter((plan) => Number(plan.interestRatePercent) === 0);
  const longestPlan = planItems.reduce<InstallmentPlan | null>((best, plan) => (!best || plan.durationMonths > best.durationMonths ? plan : best), null);
  const offerCount = offers.ok ? offers.data.total : 0;
  const bestOffer = offers.ok ? Math.max(0, ...offers.data.items.map((item) => item.maxDiscountPercent ?? 0)) : 0;

  const origin = resolveSiteOrigin();
  const jsonLd = serializeJsonLd([
    organizationJsonLd({
      origin,
      name: PLATFORM_NAME,
      legalName: siteInfo.legalName,
      logoUrl: branding.logoUrl,
      supportPhone: siteInfo.supportPhone,
      supportEmail: siteInfo.supportEmail,
    }),
    websiteJsonLd(origin, PLATFORM_NAME),
  ]);

  return (
    <div className="flex flex-col gap-12">
      {/* Schema.org Organization + WebSite (SearchAction → /search?q=). */}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd }} />

      {/* Hero: the admin-managed banner carousel when there are active banners, otherwise the illustrated default hero. */}
      {branding.heroBanners.length > 0 ? (
        <HeroCarousel banners={branding.heroBanners} />
      ) : (
        <HomeHero bnplEnabled={bnpl} totals={tree.ok ? { products: tree.data.totalProducts, categories: tree.data.totalCategories } : null} />
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
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5" data-testid="home-categories">
            {tree.data.items.map((category) => (
              <Link
                key={category.id}
                href={`/categories/${category.slug}`}
                data-testid="home-category"
                className="flex flex-col items-center gap-2 rounded-2xl border border-slate-200 bg-white p-4 text-center transition hover:border-brand-300 hover:shadow-sm"
              >
                <span className="flex size-12 items-center justify-center rounded-2xl bg-brand-50 text-brand-700">
                  <CategoryIcon slug={category.slug} className="size-6" />
                </span>
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

      {/* Special offers (discounted, in stock; instalment badge when BNPL is on) */}
      {offers.ok && offers.data.items.length > 0 ? (
        <section className="flex flex-col gap-4" data-testid="home-offers">
          <SectionTitle
            icon={<BadgePercent className="size-5" />}
            title={bnpl ? 'پیشنهادهای ویژهٔ اقساطی' : 'پیشنهادهای ویژه'}
            href="/search?onSale=1&inStock=1&sort=popular"
          />
          <ProductGrid products={offers.data.items} bnplEnabled={bnpl} />
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

      {/* Mid-page banners — every figure comes from the live catalogue / plans. */}
      <section className="grid gap-4 md:grid-cols-2" data-testid="home-mid-banners">
        {offerCount > 0 ? (
          <Link
            href="/search?onSale=1"
            className="group relative flex min-h-36 flex-col justify-center gap-2 overflow-hidden rounded-3xl bg-gradient-to-l from-rose-600 to-orange-500 p-6 text-white"
            data-testid="banner-discounts"
          >
            <Flame className="size-7" aria-hidden="true" />
            <p className="text-xl font-black">{formatCount(offerCount)} کالای تخفیف‌دار موجود</p>
            <p className="text-sm text-white/85">
              {bestOffer > 0 ? `تخفیف تا ${formatPercent(bestOffer)} روی کالاهای منتخب` : 'تخفیف‌های فعال فروشگاه‌ها'} — مشاهدهٔ همه
              <ArrowLeft className="ms-1 inline size-4 transition group-hover:-translate-x-1" aria-hidden="true" />
            </p>
          </Link>
        ) : null}
        {bnpl && longestPlan ? (
          <Link
            href="/customer/credit"
            className="group relative flex min-h-36 flex-col justify-center gap-2 overflow-hidden rounded-3xl bg-gradient-to-l from-emerald-600 to-teal-500 p-6 text-white"
            data-testid="banner-credit"
          >
            <CalendarClock className="size-7" aria-hidden="true" />
            <p className="text-xl font-black">
              {zeroInterest.length > 0 ? `اقساط ${toPersianDigits(zeroInterest[0]!.durationMonths)} ماهه بدون سود` : `پرداخت تا ${toPersianDigits(longestPlan.durationMonths)} قسط`}
            </p>
            <p className="text-sm text-white/85">
              اعتبار خرید بگیرید و از همهٔ فروشگاه‌ها قسطی بخرید
              <ArrowLeft className="ms-1 inline size-4 transition group-hover:-translate-x-1" aria-hidden="true" />
            </p>
          </Link>
        ) : (
          <Link
            href="/vendor/landing"
            className="group relative flex min-h-36 flex-col justify-center gap-2 overflow-hidden rounded-3xl bg-gradient-to-l from-brand-700 to-indigo-500 p-6 text-white"
            data-testid="banner-sell"
          >
            <Store className="size-7" aria-hidden="true" />
            <p className="text-xl font-black">در {PLATFORM_NAME} بفروشید</p>
            <p className="text-sm text-white/85">
              فروشگاه خود را ثبت کنید و به خریداران سراسر کشور بفروشید
              <ArrowLeft className="ms-1 inline size-4 transition group-hover:-translate-x-1" aria-hidden="true" />
            </p>
          </Link>
        )}
      </section>

      <section className="flex flex-col gap-4">
        <SectionTitle icon={<Flame className="size-5" />} title="تازه‌ترین محصولات" href="/search?sort=newest" />
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
