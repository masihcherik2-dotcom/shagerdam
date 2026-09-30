import { ArrowLeft, CalendarClock, ShieldCheck, Sparkles, Store } from 'lucide-react';
import Image from 'next/image';

import { LinkButton } from '@/components/ui/button';
import { PLATFORM_NAME } from '@/lib/brand';
import { formatCount } from '@/lib/format';

import heroIllustration from './hero-illustration.webp';

/**
 * Default home hero (shown when no admin banner is active): brand illustration
 * and the two primary journeys — instalment buying and entering the store.
 * Desktop: text beside the illustration; mobile: stacked, illustration first
 * and smaller, buttons full width.
 */
export function HomeHero({ bnplEnabled, totals }: { bnplEnabled: boolean; totals: { products: number; categories: number } | null }) {
  return (
    <section
      className="relative overflow-hidden rounded-3xl bg-gradient-to-l from-brand-700 via-brand-600 to-sky-500 text-white"
      aria-labelledby="home-hero-title"
      data-testid="home-hero"
    >
      <div className="relative z-10 grid items-center gap-6 px-5 py-8 md:grid-cols-[1.1fr_1fr] md:gap-10 md:px-12 md:py-14">
        <div className="order-2 flex flex-col gap-5 md:order-1">
          <span className="inline-flex w-fit items-center gap-1.5 rounded-full bg-white/15 px-3 py-1 text-xs font-medium">
            <Sparkles className="size-3.5" aria-hidden="true" /> بازار آنلاین چندفروشندگی {PLATFORM_NAME}
          </span>
          <h1 id="home-hero-title" className="text-2xl font-black leading-tight sm:text-3xl md:text-5xl">
            هر چه می‌خواهید، از فروشگاه‌های تأییدشده؛ نقدی یا اقساطی
          </h1>
          <p className="text-sm leading-7 text-white/85 md:text-base">
            پول شما تا زمان تحویل کالا نزد {PLATFORM_NAME} امانت می‌ماند. سفارش از چند فروشگاه را یک‌جا پرداخت کنید و هر مرسوله را جداگانه پیگیری کنید.
          </p>
          <div className="flex flex-col gap-3 sm:flex-row">
            <LinkButton
              href={bnplEnabled ? '/customer/credit' : '/search?onSale=1'}
              size="lg"
              className="w-full border-0 bg-emerald-500 text-white hover:bg-emerald-400 sm:w-auto"
              icon={<CalendarClock className="size-5" aria-hidden="true" />}
              data-testid="hero-cta-installment"
            >
              {bnplEnabled ? 'خرید اقساطی' : 'پیشنهادهای ویژه'}
            </LinkButton>
            <LinkButton
              href="/search"
              variant="secondary"
              size="lg"
              className="w-full border-0 text-brand-700 sm:w-auto"
              icon={<Store className="size-5" aria-hidden="true" />}
              data-testid="hero-cta-store"
            >
              ورود به فروشگاه <ArrowLeft className="size-4" aria-hidden="true" />
            </LinkButton>
          </div>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-white/80">
            <span className="inline-flex items-center gap-1.5">
              <ShieldCheck className="size-4" aria-hidden="true" /> پرداخت امانی تا تحویل
            </span>
            {totals ? (
              <span>
                {formatCount(totals.products)} محصول در {formatCount(totals.categories)} دسته‌بندی
              </span>
            ) : null}
          </div>
        </div>
        <div className="order-1 mx-auto w-full max-w-[260px] sm:max-w-sm md:order-2 md:max-w-none">
          <div className="rounded-3xl bg-white/95 p-2 shadow-xl shadow-brand-900/20">
            <Image src={heroIllustration} alt="" priority sizes="(min-width: 768px) 40vw, 260px" className="h-auto w-full rounded-2xl" />
          </div>
        </div>
      </div>
      <div className="pointer-events-none absolute -bottom-24 -left-24 size-80 rounded-full bg-white/10" />
      <div className="pointer-events-none absolute -top-16 left-40 size-48 rounded-full bg-white/10" />
    </section>
  );
}
