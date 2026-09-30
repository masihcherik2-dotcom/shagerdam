import { ArrowLeft, BadgeCheck, CalendarClock, Factory, HandCoins, Handshake, Landmark, LayoutGrid, Package, Scale, Sparkles, Target } from 'lucide-react';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { LinkButton } from '@/components/ui/button';
import { loadCategoryTree } from '@/lib/api/catalog.server';
import { PLATFORM_NAME, PLATFORM_TAGLINE } from '@/lib/brand';
import { formatCount } from '@/lib/format';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'دربارهٔ ما',
  description: `${PLATFORM_NAME}، ${PLATFORM_TAGLINE}: حمایت از تولیدکنندگان، حذف واسطه‌ها و خرید اقساطی امن با پرداخت امانی.`,
  alternates: { canonical: '/about' },
  openGraph: { title: `دربارهٔ ${PLATFORM_NAME}`, url: '/about' },
};

const PILLARS: ReadonlyArray<{ icon: typeof Factory; title: string; text: string }> = [
  { icon: Factory, title: 'حمایت از تولیدکنندگان', text: 'تولیدکنندگان و کسب‌وکارهای کوچک بدون نیاز به فروشگاه فیزیکی یا سرمایهٔ تبلیغاتی سنگین، مستقیم به خریداران سراسر کشور دسترسی پیدا می‌کنند.' },
  { icon: Handshake, title: 'حذف واسطه‌ها', text: 'کالا مستقیم از فروشنده به دست شما می‌رسد؛ حذف واسطه‌های زنجیرهٔ فروش یعنی قیمت منصفانه‌تر برای خریدار و سهم بیشتر برای تولیدکننده.' },
  { icon: CalendarClock, title: 'خرید اقساطی در دسترس', text: 'با اعتبار تأمین‌کنندگان مالی همکار، خرید اقساطی بدون مراجعهٔ حضوری و با جدول اقساط شفاف از پیش از خرید ممکن است.' },
];

const TRUST: ReadonlyArray<{ icon: typeof Landmark; title: string; text: string }> = [
  { icon: Landmark, title: 'پرداخت امانی', text: 'وجه تا تحویل کالا نزد پلتفرم می‌ماند.' },
  { icon: BadgeCheck, title: 'فروشندگان احرازشده', text: 'هویت و حساب بانکی هر فروشنده بررسی می‌شود.' },
  { icon: Scale, title: 'داوری بی‌طرف', text: 'اختلاف‌ها بر اساس مدارک طرفین داوری می‌شود.' },
  { icon: HandCoins, title: 'قیمت شفاف', text: 'هزینهٔ ارسال و اقساط پیش از پرداخت اعلام می‌شود.' },
];

function Stat({ icon: Icon, value, label }: { icon: typeof Package; value: ReactNode; label: string }) {
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-white/20 bg-white/10 px-5 py-4">
      <Icon className="size-6 text-brand-100" aria-hidden="true" />
      <div>
        <p className="text-2xl font-black">{value}</p>
        <p className="text-xs text-brand-100">{label}</p>
      </div>
    </div>
  );
}

export default async function AboutPage() {
  const tree = await loadCategoryTree();

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-10">
      <section className="relative overflow-hidden rounded-3xl bg-gradient-to-l from-brand-900 via-brand-700 to-brand-600 p-8 text-white sm:p-12">
        <div className="flex max-w-2xl flex-col gap-4">
          <p className="inline-flex w-fit items-center gap-1.5 rounded-full bg-white/15 px-3 py-1 text-xs font-medium">
            <Sparkles className="size-3.5" aria-hidden="true" /> دربارهٔ {PLATFORM_NAME}
          </p>
          <h1 className="text-3xl font-black leading-tight sm:text-4xl">{PLATFORM_TAGLINE}</h1>
          <p className="text-sm leading-8 text-brand-50 sm:text-base">
            {PLATFORM_NAME} بازاری آنلاین است که تولیدکنندگان و فروشندگان احرازشده را بدون واسطه به خریداران وصل می‌کند و با پرداخت امانی و خرید اقساطی، خرید آنلاین را برای همه امن و در دسترس می‌کند.
          </p>
        </div>
        {tree.ok ? (
          <div className="mt-8 grid max-w-xl gap-3 sm:grid-cols-2">
            <Stat icon={Package} value={formatCount(tree.data.totalProducts)} label="کالای فعال در فروشگاه" />
            <Stat icon={LayoutGrid} value={formatCount(tree.data.totalCategories)} label="دسته‌بندی کالا" />
          </div>
        ) : null}
      </section>

      <section aria-labelledby="mission-title" className="flex flex-col gap-5">
        <h2 id="mission-title" className="flex items-center gap-2 text-xl font-black text-slate-900">
          <Target className="size-6 text-brand-600" aria-hidden="true" /> رسالت ما
        </h2>
        <div className="grid gap-4 md:grid-cols-3">
          {PILLARS.map((pillar) => {
            const Icon = pillar.icon;
            return (
              <article key={pillar.title} className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-6">
                <span className="flex size-12 items-center justify-center rounded-2xl bg-brand-50 text-brand-700">
                  <Icon className="size-6" aria-hidden="true" />
                </span>
                <h3 className="text-lg font-bold text-slate-900">{pillar.title}</h3>
                <p className="text-sm leading-7 text-slate-600">{pillar.text}</p>
              </article>
            );
          })}
        </div>
      </section>

      <section aria-labelledby="trust-title" className="flex flex-col gap-5 rounded-3xl border border-slate-200 bg-white p-6 sm:p-8">
        <h2 id="trust-title" className="text-xl font-black text-slate-900">
          چرا می‌توانید به {PLATFORM_NAME} اعتماد کنید؟
        </h2>
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {TRUST.map((item) => {
            const Icon = item.icon;
            return (
              <li key={item.title} className="flex items-start gap-3">
                <Icon className="mt-0.5 size-5 shrink-0 text-emerald-600" aria-hidden="true" />
                <span>
                  <strong className="block text-sm text-slate-900">{item.title}</strong>
                  <span className="text-xs leading-6 text-slate-600">{item.text}</span>
                </span>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="flex flex-col items-start justify-between gap-4 rounded-3xl bg-brand-50 p-6 sm:flex-row sm:items-center sm:p-8">
        <div>
          <h2 className="text-lg font-black text-slate-900">تولیدکننده یا فروشنده هستید؟</h2>
          <p className="mt-1 text-sm text-slate-600">فروشگاه خود را در {PLATFORM_NAME} بسازید و مستقیم به خریداران بفروشید.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <LinkButton href="/vendor/register" icon={<ArrowLeft className="size-4" />}>
            فروشنده شوید
          </LinkButton>
          <LinkButton href="/contact" variant="secondary">
            تماس با ما
          </LinkButton>
        </div>
      </section>
    </div>
  );
}
