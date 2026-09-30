import { BadgeCheck, Building2, Headphones, Mail, MapPin, Phone, RotateCcw, ShieldCheck } from 'lucide-react';
import Link from 'next/link';

import { loadBranding } from '@/lib/api/branding.server';
import { loadSiteInfo } from '@/lib/api/site-info.server';
import type { SiteInfo } from '@/lib/api/types';
import { PLATFORM_NAME, PLATFORM_TAGLINE } from '@/lib/brand';
import { toPersianDigits } from '@/lib/format';
import { hasLegalIdentity, telHref } from '@/lib/site-info';

import { BrandLogo } from './brand-logo';

const TRUST_ITEMS = [
  { icon: ShieldCheck, title: 'ضمانت اصالت و پرداخت امانی', text: 'پول شما تا تحویل کالا نزد ما امانت می‌ماند' },
  { icon: RotateCcw, title: '۷ روز مهلت بازگشت', text: 'بازگشت کالای معیوب یا مغایر' },
  { icon: BadgeCheck, title: 'فروشندگان احرازشده', text: 'هویت و حساب بانکی همهٔ فروشندگان بررسی می‌شود' },
  { icon: Headphones, title: 'پشتیبانی همیشگی', text: 'فرم پیام و سامانهٔ حل اختلاف در همهٔ ساعات' },
] as const;

const LINK_GROUPS: ReadonlyArray<{ title: string; links: ReadonlyArray<{ href: string; label: string }> }> = [
  {
    title: 'خرید',
    links: [
      { href: '/search', label: 'همهٔ محصولات' },
      { href: '/search?sort=popular', label: 'پرفروش‌ترین‌ها' },
      { href: '/customer/credit', label: 'خرید اقساطی' },
      { href: '/customer/orders', label: 'پیگیری سفارش' },
    ],
  },
  {
    title: 'راهنما و قوانین',
    links: [
      { href: '/terms', label: 'قوانین و مقررات' },
      { href: '/privacy', label: 'حریم خصوصی' },
      { href: '/returns', label: 'رویهٔ بازگرداندن کالا' },
      { href: '/customer/disputes', label: 'حل اختلاف و مرجوعی' },
    ],
  },
  {
    title: `با ${PLATFORM_NAME}`,
    links: [
      { href: '/about', label: 'دربارهٔ ما' },
      { href: '/contact', label: 'تماس با ما' },
      { href: '/vendor/register', label: 'فروشنده شوید' },
      { href: '/status', label: 'وضعیت سامانه' },
    ],
  },
];

/**
 * eNamad / Samandehi seals, exactly as issued by enamad.ir and samandehi.ir
 * for this domain (entered by an admin in /admin/site-info). Nothing is shown
 * before they are issued — a seal can never be faked here.
 * `referrerPolicy="origin"` is required: the issuers verify the domain from the referrer.
 */
function TrustSeals({ info }: { info: SiteInfo }) {
  const seals = [
    info.enamadLinkUrl && info.enamadImageUrl ? { key: 'enamad', href: info.enamadLinkUrl, src: info.enamadImageUrl, alt: 'نماد اعتماد الکترونیکی (اینماد)' } : null,
    info.samandehiLinkUrl && info.samandehiImageUrl ? { key: 'samandehi', href: info.samandehiLinkUrl, src: info.samandehiImageUrl, alt: 'نشان ملی ثبت رسانه‌های دیجیتال (ساماندهی)' } : null,
  ].filter((seal) => seal !== null);
  if (seals.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <p className="font-bold text-slate-800">نمادهای اعتماد</p>
      <div className="flex flex-wrap gap-3" data-testid="trust-seals">
        {seals.map((seal) => (
          <a key={seal.key} href={seal.href} target="_blank" rel="noopener" referrerPolicy="origin" className="flex size-[104px] items-center justify-center rounded-2xl border border-slate-200 bg-white p-2 hover:border-brand-300">
            {/* eslint-disable-next-line @next/next/no-img-element -- third-party seal image served by the issuer; must not be proxied. */}
            <img src={seal.src} alt={seal.alt} referrerPolicy="origin" width={88} height={88} loading="lazy" className="max-h-full max-w-full object-contain" />
          </a>
        ))}
      </div>
    </div>
  );
}

function LegalIdentity({ info }: { info: SiteInfo }) {
  const contact = info.supportPhone || info.supportEmail;
  if (!hasLegalIdentity(info) && !contact) return null;
  return (
    <div className="flex flex-col gap-2 text-xs leading-6 text-slate-600" data-testid="legal-identity">
      <p className="flex items-center gap-1.5 text-sm font-bold text-slate-800">
        <Building2 className="size-4 text-slate-500" aria-hidden="true" /> مشخصات کسب‌وکار
      </p>
      {info.legalName ? <p className="font-medium text-slate-700">{info.legalName}</p> : null}
      {info.nationalId || info.registrationNumber ? (
        <p className="flex flex-wrap gap-x-4">
          {info.nationalId ? <span>شناسهٔ ملی: {toPersianDigits(info.nationalId)}</span> : null}
          {info.registrationNumber ? <span>شمارهٔ ثبت: {toPersianDigits(info.registrationNumber)}</span> : null}
        </p>
      ) : null}
      {info.supportPhone ? (
        <p className="flex items-center gap-1.5">
          <Phone className="size-3.5 text-slate-400" aria-hidden="true" /> تلفن:{' '}
          <a href={telHref(info.supportPhone)} dir="ltr" className="hover:text-brand-700">
            {toPersianDigits(info.supportPhone)}
          </a>
        </p>
      ) : null}
      {info.supportEmail ? (
        <p className="flex items-center gap-1.5">
          <Mail className="size-3.5 text-slate-400" aria-hidden="true" /> ایمیل:{' '}
          <a href={`mailto:${info.supportEmail}`} dir="ltr" className="hover:text-brand-700">
            {info.supportEmail}
          </a>
        </p>
      ) : null}
      {info.officeAddress ? (
        <address className="flex items-start gap-1.5 not-italic">
          <MapPin className="mt-1 size-3.5 shrink-0 text-slate-400" aria-hidden="true" />
          <span>
            {info.officeAddress}
            {info.postalCode ? ` — کد پستی ${toPersianDigits(info.postalCode)}` : ''}
          </span>
        </address>
      ) : null}
    </div>
  );
}

export async function SiteFooter() {
  const [branding, info] = await Promise.all([loadBranding(), loadSiteInfo()]);
  const year = new Intl.DateTimeFormat('fa-IR-u-ca-persian', { year: 'numeric' }).format(new Date());

  return (
    <footer className="mt-16 border-t border-slate-200 bg-white">
      {/* Trust banner */}
      <div className="border-b border-slate-100 bg-slate-50">
        <ul className="mx-auto grid max-w-7xl gap-4 px-4 py-6 sm:grid-cols-2 lg:grid-cols-4" aria-label="تعهدات ما">
          {TRUST_ITEMS.map((item) => {
            const Icon = item.icon;
            return (
              <li key={item.title} className="flex items-center gap-3">
                <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-brand-50 text-brand-700">
                  <Icon className="size-5" aria-hidden="true" />
                </span>
                <span>
                  <strong className="block text-sm text-slate-900">{item.title}</strong>
                  <span className="text-xs text-slate-500">{item.text}</span>
                </span>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="mx-auto grid max-w-7xl gap-8 px-4 py-10 text-sm text-slate-600 md:grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr_1fr]">
        <div className="flex flex-col gap-3">
          <BrandLogo variant="footer" logoUrl={branding.logoUrl} />
          <p className="text-xs font-medium text-slate-500">{PLATFORM_TAGLINE}</p>
          <p className="leading-7">بازار آنلاین چندفروشندگی با پرداخت امن درگاه بانکی و خرید اقساطی. پول شما تا تحویل کالا نزد {PLATFORM_NAME} امانت می‌ماند.</p>
        </div>
        {LINK_GROUPS.map((group) => (
          <nav key={group.title} className="flex flex-col gap-2" aria-label={group.title}>
            <p className="font-bold text-slate-800">{group.title}</p>
            {group.links.map((link) => (
              <Link key={link.href} href={link.href} className="hover:text-brand-700">
                {link.label}
              </Link>
            ))}
          </nav>
        ))}
      </div>

      <div className="mx-auto flex max-w-7xl flex-col gap-6 border-t border-slate-100 px-4 py-6 md:flex-row md:items-start md:justify-between">
        <LegalIdentity info={info} />
        <TrustSeals info={info} />
      </div>

      <div className="border-t border-slate-100 py-4 text-center text-xs text-slate-500">
        © {year} {PLATFORM_NAME} — تمامی حقوق محفوظ است.
      </div>
    </footer>
  );
}
