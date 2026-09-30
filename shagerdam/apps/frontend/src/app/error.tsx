'use client';

import { ErrorState } from '@/components/ui/states';

/** Last-resort boundary: a render/server error shows a retryable error state instead of a blank page. */
export default function GlobalRouteError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="mx-auto max-w-xl px-4 py-16">
      <ErrorState error={error.message || 'خطای غیرمنتظره‌ای رخ داد.'} title="نمایش این صفحه ممکن نشد" onRetry={reset} />
    </main>
  );
}
