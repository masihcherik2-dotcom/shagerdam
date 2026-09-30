import { CircleAlert, Inbox, RefreshCw } from 'lucide-react';
import type { ReactNode } from 'react';

import type { ApiError } from '@/lib/api/errors';

export function Skeleton({ className = '' }: { className?: string }) {
  return <div aria-hidden className={`animate-pulse rounded-lg bg-slate-200/80 ${className}`} />;
}

/** Stack of skeleton rows for lists and tables. */
export function SkeletonRows({ rows = 5, className = 'h-14' }: { rows?: number; className?: string }) {
  return (
    <div className="flex flex-col gap-3" role="status" aria-label="در حال بارگذاری">
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className={className} />
      ))}
    </div>
  );
}

export function SkeletonCards({ count = 8 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4" role="status" aria-label="در حال بارگذاری">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="flex flex-col gap-2 rounded-2xl border border-slate-100 bg-white p-3">
          <Skeleton className="aspect-square w-full" />
          <Skeleton className="h-4 w-4/5" />
          <Skeleton className="h-4 w-2/5" />
        </div>
      ))}
    </div>
  );
}

export function EmptyState({ title, description, action, icon }: { title: string; description?: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-slate-300 bg-white px-6 py-12 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-slate-100 text-slate-500">{icon ?? <Inbox className="size-6" />}</span>
      <h3 className="text-base font-bold text-slate-800">{title}</h3>
      {description ? <p className="max-w-md text-sm leading-6 text-slate-500">{description}</p> : null}
      {action}
    </div>
  );
}

export function ErrorState({ error, title = 'دریافت اطلاعات ممکن نشد', onRetry }: { error: ApiError | Error | string; title?: string; onRetry?: () => void }) {
  const message = typeof error === 'string' ? error : error.message;
  return (
    <div role="alert" className="flex flex-col items-center gap-3 rounded-2xl border border-rose-200 bg-rose-50 px-6 py-10 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-rose-100 text-rose-600">
        <CircleAlert className="size-6" />
      </span>
      <h3 className="text-base font-bold text-rose-900">{title}</h3>
      <p className="max-w-md text-sm leading-6 text-rose-800">{message}</p>
      {onRetry ? (
        <button type="button" onClick={onRetry} className="inline-flex items-center gap-2 rounded-xl border border-rose-300 bg-white px-4 py-2 text-sm font-medium text-rose-800 hover:bg-rose-100">
          <RefreshCw className="size-4" /> تلاش دوباره
        </button>
      ) : null}
    </div>
  );
}

/**
 * Renders the right state of an API-backed view: skeleton while loading,
 * error with retry, empty state, or the content.
 */
export function AsyncView<T>({
  state,
  skeleton,
  isEmpty,
  empty,
  children,
}: {
  state: { data: T | undefined; error: ApiError | undefined; loading: boolean; reload: () => Promise<void> };
  skeleton?: ReactNode;
  isEmpty?: (data: T) => boolean;
  empty?: ReactNode;
  children: (data: T) => ReactNode;
}) {
  if (state.loading && state.data === undefined) {
    return <>{skeleton ?? <SkeletonRows />}</>;
  }
  if (state.error && state.data === undefined) {
    return <ErrorState error={state.error} onRetry={() => void state.reload()} />;
  }
  if (state.data === undefined) {
    return <>{skeleton ?? <SkeletonRows />}</>;
  }
  if (isEmpty?.(state.data)) {
    return <>{empty ?? <EmptyState title="موردی یافت نشد" />}</>;
  }
  return <>{children(state.data)}</>;
}
