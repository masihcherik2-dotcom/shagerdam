import { SystemHealthPanel } from '@/components/system-health-panel';
import { getSystemHealthServerSide } from '@/lib/api/health.server';
import type { SystemHealth } from '@/lib/api/health';
import { PLATFORM_NAME } from '@/lib/brand';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  // Server-side call at request time: the page always shows the live state of
  // the API (database, Redis, memory, uptime), never cached output.
  let initialHealth: SystemHealth | null = null;
  let initialError: string | null = null;

  try {
    initialHealth = await getSystemHealthServerSide();
  } catch (error) {
    initialError = error instanceof Error ? error.message : 'خطای نامشخص در ارتباط با API';
  }

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-6 py-14">
      <header className="flex flex-col gap-2">
        <p className="text-sm font-medium text-brand-600">{PLATFORM_NAME}</p>
        <h1 className="text-3xl font-bold text-slate-900">وضعیت سامانه</h1>
        <p className="text-sm leading-6 text-slate-600">
          این صفحه وضعیت زندهٔ سرویس‌های زیرساختی (PostgreSQL و Redis) و همچنین وضعیت پردازش API
          را نمایش می‌دهد. داده‌های نمایش‌داده‌شده از خود سرویس‌ها خوانده می‌شوند.
        </p>
      </header>

      <SystemHealthPanel initialHealth={initialHealth} initialError={initialError} />

      <footer className="border-t border-slate-200 pt-4 text-xs text-slate-500">
        <p>{PLATFORM_NAME} — نسخهٔ ۰.۱.۰ | API: مسیر امن از طریق پروکسی Next.js به سرویس Backend</p>
      </footer>
    </main>
  );
}
