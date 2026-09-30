import { CalendarCheck, ChevronLeft, type LucideIcon } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { PLATFORM_NAME } from '@/lib/brand';

/**
 * Date of the current revision of the legal texts (Persian calendar, shown as
 * is). Update together with the texts; the history lives in git.
 */
export const LEGAL_REVISION_LABEL = '۹ مهر ۱۴۰۵';

export interface LegalSection {
  id: string;
  title: string;
  icon: LucideIcon;
  body: ReactNode;
}

const RELATED: ReadonlyArray<{ href: string; label: string }> = [
  { href: '/terms', label: 'قوانین و مقررات' },
  { href: '/privacy', label: 'حریم خصوصی' },
  { href: '/returns', label: 'بازگشت کالا' },
  { href: '/contact', label: 'تماس با ما' },
  { href: '/about', label: 'دربارهٔ ما' },
];

/** Shared layout of the legal/trust pages: heading, table of contents, numbered sections, related links. */
export function LegalPage({
  icon: Icon,
  eyebrow,
  title,
  summary,
  sections,
  current,
  aside,
  showRevision = true,
}: {
  icon: LucideIcon;
  eyebrow: string;
  title: string;
  summary: ReactNode;
  sections: LegalSection[];
  current: string;
  aside?: ReactNode;
  showRevision?: boolean;
}) {
  return (
    <article className="mx-auto flex max-w-5xl flex-col gap-8">
      <nav aria-label="مسیر" className="flex items-center gap-1 text-xs text-slate-500">
        <Link href="/" className="hover:text-brand-700">
          {PLATFORM_NAME}
        </Link>
        <ChevronLeft className="size-3" aria-hidden="true" />
        <span className="text-slate-700">{title}</span>
      </nav>

      <header className="flex flex-col gap-4 rounded-3xl border border-slate-200 bg-gradient-to-l from-brand-50 to-white p-6 sm:flex-row sm:items-start sm:p-8">
        <span className="flex size-14 shrink-0 items-center justify-center rounded-2xl bg-brand-600 text-white shadow-sm">
          <Icon className="size-7" aria-hidden="true" />
        </span>
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium text-brand-700">{eyebrow}</p>
          <h1 className="text-2xl font-black text-slate-900 sm:text-3xl">{title}</h1>
          <div className="text-sm leading-7 text-slate-600">{summary}</div>
          {showRevision ? (
            <p className="mt-1 inline-flex items-center gap-1.5 text-xs text-slate-500">
              <CalendarCheck className="size-3.5" aria-hidden="true" /> آخرین بازنگری: {LEGAL_REVISION_LABEL}
            </p>
          ) : null}
        </div>
      </header>

      <div className="grid gap-8 lg:grid-cols-[15rem_1fr]">
        <aside className="flex flex-col gap-4 lg:sticky lg:top-20 lg:self-start">
          {sections.length > 1 ? (
            <nav aria-label="فهرست مطالب" className="rounded-2xl border border-slate-200 bg-white p-4">
              <p className="mb-2 text-sm font-bold text-slate-800">فهرست مطالب</p>
              <ol className="flex flex-col gap-1.5 text-sm">
                {sections.map((section, index) => (
                  <li key={section.id}>
                    <a href={`#${section.id}`} className="flex gap-2 text-slate-600 hover:text-brand-700">
                      <span className="text-slate-400">{(index + 1).toLocaleString('fa-IR')}.</span>
                      {section.title}
                    </a>
                  </li>
                ))}
              </ol>
            </nav>
          ) : null}
          {aside}
        </aside>

        <div className="flex flex-col gap-5">
          {sections.map((section, index) => {
            const SectionIcon = section.icon;
            return (
              <section key={section.id} id={section.id} aria-labelledby={`${section.id}-title`} className="scroll-mt-24 rounded-2xl border border-slate-200 bg-white p-6">
                <h2 id={`${section.id}-title`} className="mb-3 flex items-center gap-2 text-lg font-bold text-slate-900">
                  <span className="flex size-8 items-center justify-center rounded-xl bg-brand-50 text-brand-700">
                    <SectionIcon className="size-4" aria-hidden="true" />
                  </span>
                  <span className="text-slate-400">{(index + 1).toLocaleString('fa-IR')}.</span> {section.title}
                </h2>
                <div className="legal-prose flex flex-col gap-3 text-sm leading-8 text-slate-700">{section.body}</div>
              </section>
            );
          })}

          <nav aria-label="صفحات مرتبط" className="flex flex-wrap gap-2 pt-2">
            {RELATED.filter((link) => link.href !== current).map((link) => (
              <Link key={link.href} href={link.href} className="rounded-full border border-slate-200 bg-white px-4 py-1.5 text-sm text-slate-600 hover:border-brand-300 hover:text-brand-700">
                {link.label}
              </Link>
            ))}
          </nav>
        </div>
      </div>
    </article>
  );
}

/** Bulleted list with the platform's list styling. */
export function Bullets({ items }: { items: ReactNode[] }) {
  return (
    <ul className="flex list-disc flex-col gap-1.5 ps-5 marker:text-brand-400">
      {items.map((item, index) => (
        <li key={index}>{item}</li>
      ))}
    </ul>
  );
}
