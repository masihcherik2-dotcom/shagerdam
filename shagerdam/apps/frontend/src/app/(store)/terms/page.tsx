import { BadgeCheck, CalendarClock, FileText, Gavel, Landmark, PackageCheck, Scale, ShieldCheck, ShoppingCart, Store, UserRound } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';

import { Bullets, LegalPage, type LegalSection } from '@/components/legal/legal-page';
import { loadCreditPlans } from '@/lib/api/catalog.server';
import type { CreditPlans } from '@/lib/api/types';
import { PLATFORM_NAME } from '@/lib/brand';
import { formatPercent, toPersianDigits } from '@/lib/format';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'قوانین و مقررات',
  description: `قوانین استفاده از بازار آنلاین ${PLATFORM_NAME}: امانت‌داری مالی (اسکرو)، تعهدات فروشندگان، شرایط خرید اقساطی (BNPL)، لغو، بازگشت و حل اختلاف.`,
  alternates: { canonical: '/terms' },
  openGraph: { title: `قوانین و مقررات | ${PLATFORM_NAME}`, url: '/terms', type: 'article' },
};

/** Installment plans exactly as the credit API offers them today (never a copy that can drift). */
function PlansTable({ plans }: { plans: CreditPlans | null }) {
  if (!plans || !plans.creditEnabled || plans.items.length === 0) {
    return <p className="rounded-xl bg-slate-50 px-4 py-3 text-slate-600">در حال حاضر طرح اقساطی فعالی ارائه نمی‌شود؛ به محض فعال شدن، شرایط هر طرح در همین بخش و در صفحهٔ هر محصول نمایش داده می‌شود.</p>;
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-x-auto rounded-xl border border-slate-200">
        <table className="w-full min-w-[32rem] text-right text-sm">
          <caption className="sr-only">طرح‌های اقساطی فعال</caption>
          <thead className="bg-slate-50 text-xs text-slate-500">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">طرح</th>
              <th scope="col" className="px-3 py-2 font-medium">مدت</th>
              <th scope="col" className="px-3 py-2 font-medium">سود کل دوره</th>
              <th scope="col" className="px-3 py-2 font-medium">فاصلهٔ اقساط</th>
              <th scope="col" className="px-3 py-2 font-medium">جریمهٔ تأخیر ماهانه</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {plans.items.map((plan) => (
              <tr key={plan.id}>
                <td className="px-3 py-2 font-medium text-slate-800">{plan.title}</td>
                <td className="px-3 py-2">{toPersianDigits(plan.durationMonths)} ماه</td>
                <td className="px-3 py-2">{Number(plan.interestRatePercent) === 0 ? 'بدون سود' : formatPercent(plan.interestRatePercent)}</td>
                <td className="px-3 py-2">هر {toPersianDigits(plan.installmentIntervalDays)} روز</td>
                <td className="px-3 py-2">{formatPercent(plan.penaltyRatePercentPerMonth)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {plans.provider ? (
        <p className="text-xs text-slate-500">
          تأمین‌کنندهٔ اعتبار: {plans.provider.name}
          {plans.provider.isSandbox ? ' — محیط آزمایشی؛ در این محیط هیچ اعتبار واقعی تخصیص داده نمی‌شود.' : ''}
        </p>
      ) : null}
    </div>
  );
}

export default async function TermsPage() {
  const plans = await loadCreditPlans();
  const sections: LegalSection[] = [
    {
      id: 'definitions',
      title: 'تعاریف و پذیرش مقررات',
      icon: FileText,
      body: (
        <>
          <p>
            {PLATFORM_NAME} یک بازار آنلاین چندفروشندگی است که خریداران را به فروشندگان احرازشده متصل می‌کند و پرداخت، امانت‌داری وجه و حل اختلاف را بر عهده دارد. ثبت‌نام یا ثبت سفارش به معنای پذیرش این مقررات است.
          </p>
          <Bullets
            items={[
              <><strong>خریدار:</strong> کاربری که با شمارهٔ موبایل خود وارد شده و کالا سفارش می‌دهد.</>,
              <><strong>فروشنده:</strong> شخص حقیقی یا حقوقی که مدارک هویتی و حساب بانکی (شبا) او توسط {PLATFORM_NAME} بررسی و تأیید شده است.</>,
              <><strong>سفارش و مرسوله:</strong> هر سفارش می‌تواند شامل کالای چند فروشنده باشد و برای هر فروشنده یک مرسولهٔ جداگانه با پیگیری مستقل ساخته می‌شود.</>,
              <><strong>حساب امانی (اسکرو):</strong> سهم فروشنده از مبلغ پرداختی که تا تحویل کالا نزد {PLATFORM_NAME} نگه‌داری می‌شود.</>,
            ]}
          />
        </>
      ),
    },
    {
      id: 'account',
      title: 'حساب کاربری',
      icon: UserRound,
      body: (
        <Bullets
          items={[
            'ورود با شمارهٔ موبایل و کد یک‌بارمصرف پیامکی انجام می‌شود؛ هر شمارهٔ موبایل فقط به یک حساب تعلق دارد.',
            'مسئولیت حفظ دسترسی به سیم‌کارت و حساب با کاربر است. در صورت گم شدن سیم‌کارت یا مشاهدهٔ فعالیت مشکوک فوراً با پشتیبانی تماس بگیرید.',
            'اطلاعات واردشده (نام، نشانی، کد ملی برای درخواست اعتبار) باید صحیح و متعلق به خود کاربر باشد.',
            'حساب‌هایی که برای تقلب، سوءاستفاده از تخفیف یا آزار دیگران استفاده شوند مسدود می‌شوند.',
          ]}
        />
      ),
    },
    {
      id: 'orders',
      title: 'سفارش، قیمت و پرداخت',
      icon: ShoppingCart,
      body: (
        <Bullets
          items={[
            'قیمت‌ها به تومان نمایش داده می‌شوند و مبلغ نهایی شامل هزینهٔ ارسال هر مرسوله، پیش از پرداخت در صفحهٔ تسویه اعلام می‌شود.',
            'پرداخت نقدی فقط از طریق درگاه بانکی متصل به شبکهٔ شاپرک انجام می‌شود؛ اطلاعات کارت بانکی شما هرگز در سامانهٔ ما وارد یا ذخیره نمی‌شود.',
            'موجودی کالا هنگام ثبت سفارش برای شما رزرو می‌شود. سفارشی که در مهلت تعیین‌شده (به‌طور پیش‌فرض ۳۰ دقیقه) پرداخت نشود لغو و موجودی آزاد می‌شود.',
            'پس از تأیید پرداخت، وضعیت هر مرسوله (در حال پردازش، ارسال‌شده، تحویل‌شده) در بخش «سفارش‌ها» قابل پیگیری است.',
          ]}
        />
      ),
    },
    {
      id: 'escrow',
      title: 'امانت‌داری مالی (اسکرو)',
      icon: Landmark,
      body: (
        <>
          <p>برای حفاظت از خریدار، مبلغ پرداختی مستقیم به فروشنده منتقل نمی‌شود:</p>
          <Bullets
            items={[
              `پس از پرداخت، سهم فروشنده (مبلغ کالا منهای کمیسیون ${PLATFORM_NAME}) در حساب امانی و در وضعیت «در انتظار تحویل» ثبت می‌شود و فروشنده امکان برداشت آن را ندارد.`,
              'فقط پس از ثبت تحویل مرسوله، این مبلغ به موجودی قابل تسویهٔ فروشنده منتقل می‌شود.',
              'اگر مرسوله پیش از تحویل لغو شود، سهم فروشنده از حساب امانی برگشت می‌خورد و مبلغ پرداختی شما توسط واحد مالی به حساب بانکی‌تان بازگردانده می‌شود.',
              'با ثبت درخواست اختلاف یا مرجوعی، سهم فروشنده از آن مرسوله فوراً مسدود می‌شود و تا صدور رأی نهایی قابل برداشت یا تسویه نیست.',
              'همهٔ تراکنش‌های کیف پول فروشندگان در دفتر حساب دوطرفه با امکان حسابرسی ثبت می‌شوند.',
            ]}
          />
        </>
      ),
    },
    {
      id: 'vendors',
      title: 'تعهدات فروشندگان',
      icon: Store,
      body: (
        <Bullets
          items={[
            'ارائهٔ مدارک هویتی معتبر و حساب بانکی (شبا) به نام خود فروشنده؛ فروش تنها پس از تأیید مدارک ممکن است.',
            'عرضهٔ کالای اصل و نو (مگر آنکه در توضیحات صریحاً خلاف آن ذکر شده باشد) با مشخصات، تصاویر و گارانتی مطابق واقعیت.',
            'به‌روز نگه داشتن موجودی و قیمت؛ قیمت اعلام‌شده در زمان سفارش برای فروشنده الزام‌آور است.',
            'ارسال به‌موقع مرسوله و ثبت وضعیت ارسال در پنل فروشنده.',
            'پاسخ به درخواست‌های اختلاف و مرجوعی در پنل فروشنده و پذیرش رأی داوری پلتفرم.',
            `پذیرش کسر کمیسیون ${PLATFORM_NAME} مطابق نرخ دسته‌بندی کالا؛ تسویهٔ موجودی قابل برداشت از طریق درخواست تسویه به حساب شبای تأییدشده انجام می‌شود.`,
            'عرضهٔ کالای ممنوع، قاچاق یا تقلبی و هرگونه دریافت وجه خارج از پلتفرم ممنوع است و به تعلیق فروشگاه و مسدود شدن محصولات می‌انجامد.',
          ]}
        />
      ),
    },
    {
      id: 'bnpl',
      title: 'خرید اقساطی (BNPL)',
      icon: CalendarClock,
      body: (
        <>
          <Bullets
            items={[
              'خرید اقساطی با اعتباری انجام می‌شود که تأمین‌کنندهٔ اعتبار (بانک یا نهاد مالی همکار) پس از بررسی درخواست شما در بخش «اعتبار و اقساط» تخصیص می‌دهد. تصمیم دربارهٔ اعطا و سقف اعتبار با تأمین‌کننده است.',
              'مبلغ خرید از اعتبار در دسترس شما کسر می‌شود؛ اگر اعتبار کافی نباشد، مابه‌التفاوت را می‌توانید به‌صورت نقدی از درگاه بانکی بپردازید (پرداخت ترکیبی).',
              'جدول اقساط شامل سررسید، اصل و سود هر قسط پیش از تأیید خرید نمایش داده می‌شود و پس از خرید در حساب کاربری قابل مشاهده است.',
              'در صورت تأخیر در پرداخت قسط، جریمهٔ تأخیر مطابق نرخ طرح انتخابی به مبلغ قسط افزوده می‌شود.',
              'لغو یا مرجوعی کالایی که با اعتبار اقساطی خریده شده، با هماهنگی تأمین‌کنندهٔ اعتبار و توسط کارشناسان پشتیبانی انجام می‌شود؛ برای این موارد از فرم تماس یا سامانهٔ حل اختلاف اقدام کنید.',
            ]}
          />
          <p className="font-medium text-slate-800">شرایط طرح‌های فعال:</p>
          <PlansTable plans={plans.ok ? plans.data : null} />
        </>
      ),
    },
    {
      id: 'returns',
      title: 'لغو و بازگشت کالا',
      icon: PackageCheck,
      body: (
        <p>
          شرایط کامل بازگشت کالا، مهلت ۷ روزه و نحوهٔ بازگشت وجه در صفحهٔ{' '}
          <Link href="/returns" className="font-medium text-brand-700 hover:underline">
            رویهٔ بازگرداندن کالا
          </Link>{' '}
          آمده است.
        </p>
      ),
    },
    {
      id: 'disputes',
      title: 'حل اختلاف',
      icon: Scale,
      body: (
        <Bullets
          items={[
            <>
              خریدار می‌تواند برای مرسولهٔ پرداخت‌شده‌ای که در حال پردازش، ارسال‌شده یا تحویل‌شده است، از{' '}
              <Link href="/customer/disputes" className="font-medium text-brand-700 hover:underline">
                سامانهٔ حل اختلاف
              </Link>{' '}
              درخواست ثبت کند و مدارک (تصویر کالا، فاکتور و…) پیوست کند.
            </>,
            'فروشنده می‌تواند درخواست را بپذیرد (بازگشت وجه) یا با ارائهٔ دفاعیه آن را به داوری ارجاع دهد.',
            `داوری توسط کارشناسان ${PLATFORM_NAME} و بر اساس مدارک طرفین انجام می‌شود و رأی آن (به نفع خریدار یا فروشنده) در سامانه ثبت و اجرا می‌شود.`,
            'برای هر مرسوله در هر زمان فقط یک درخواست فعال پذیرفته می‌شود و مرسوله‌ای که رأی نهایی دارد دوباره قابل طرح نیست.',
          ]}
        />
      ),
    },
    {
      id: 'liability',
      title: 'مسئولیت‌ها و قانون حاکم',
      icon: Gavel,
      body: (
        <Bullets
          items={[
            `مسئولیت اصالت، کیفیت و گارانتی کالا با فروشنده است؛ ${PLATFORM_NAME} با نگه‌داری وجه در حساب امانی و داوری اختلاف، اجرای تعهدات فروشنده را تضمین می‌کند.`,
            'این مقررات تابع قوانین جمهوری اسلامی ایران، از جمله قانون تجارت الکترونیکی و قانون حمایت از حقوق مصرف‌کنندگان است.',
            'هرگونه تغییر در این مقررات با به‌روزرسانی تاریخ بازنگری در همین صفحه اعلام می‌شود و برای سفارش‌های پس از آن تاریخ اعمال می‌شود.',
          ]}
        />
      ),
    },
  ];

  return (
    <LegalPage
      icon={ShieldCheck}
      eyebrow="قوانین استفاده از بازار آنلاین"
      title="قوانین و مقررات"
      current="/terms"
      summary={<p>این صفحه حقوق و تعهدات خریداران، فروشندگان و {PLATFORM_NAME} را توضیح می‌دهد؛ از پرداخت امن و امانت‌داری وجه تا خرید اقساطی و داوری اختلاف.</p>}
      sections={sections}
      aside={
        <div className="flex items-start gap-2 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-xs leading-6 text-emerald-800">
          <BadgeCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <p>پول شما تا تحویل کالا نزد {PLATFORM_NAME} امانت می‌ماند و بدون تحویل به فروشنده پرداخت نمی‌شود.</p>
        </div>
      }
    />
  );
}
