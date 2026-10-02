'use client';

import { Send } from 'lucide-react';
import { useState } from 'react';

import { useToast } from '@/components/providers/toast-provider';
import { Button } from '@/components/ui/button';
import { FormError } from '@/components/ui/field';
import { Modal } from '@/components/ui/modal';
import { apiPost } from '@/lib/api/client';
import { toApiError } from '@/lib/api/errors';
import type { DraftPublishSummary, PublishDraftsResult } from '@/lib/api/types';
import { useApi } from '@/lib/hooks/use-api';
import { toPersianDigits } from '@/lib/format';
import { draftsLeftBehind, publishResultMessage } from '@/lib/products/publish-drafts';

/**
 * «انتشار همه محصولات پیش‌نویس»: previews how many drafts qualify (same
 * rules as publishing one product), asks for confirmation, publishes them in
 * one request and reloads the list.
 *
 * `endpoint` is `/vendor/products/publish-drafts` or
 * `/admin/products/publish-drafts` (staff may narrow it to one store).
 */
export function PublishDraftsButton({ endpoint, vendorSlug, scopeLabel, onPublished }: { endpoint: string; vendorSlug?: string; scopeLabel: string; onPublished: () => Promise<void> }) {
  const toast = useToast();
  const query = vendorSlug ? { vendorSlug } : undefined;
  const summary = useApi<DraftPublishSummary>(endpoint, query);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const publishable = summary.data?.publishable ?? 0;

  async function publish() {
    setBusy(true);
    setError(null);
    try {
      const result = await apiPost<PublishDraftsResult>(endpoint, undefined, { params: query });
      summary.setData(result.remaining);
      toast.success(publishResultMessage(result));
      setOpen(false);
      await onPublished();
    } catch (caught) {
      setError(toApiError(caught).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button
        variant="secondary"
        icon={<Send className="size-4" />}
        disabled={summary.loading || publishable === 0}
        onClick={() => {
          setError(null);
          setOpen(true);
          void summary.reload();
        }}
        data-testid="publish-drafts"
        title={publishable === 0 && !summary.loading ? 'پیش‌نویس قابل انتشاری وجود ندارد' : undefined}
      >
        انتشار همه محصولات پیش‌نویس{publishable > 0 ? ` (${toPersianDigits(publishable)})` : ''}
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="انتشار همه محصولات پیش‌نویس"
        footer={
          <>
            <Button loading={busy} disabled={publishable === 0} onClick={() => void publish()} data-testid="publish-drafts-confirm">
              {`انتشار ${toPersianDigits(publishable)} محصول`}
            </Button>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              انصراف
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3 text-sm leading-7 text-slate-700">
          <p>
            {toPersianDigits(publishable)} محصول پیش‌نویس {scopeLabel} بلافاصله در ویترین و صفحهٔ دسته‌بندی‌ها نمایش داده می‌شوند. محصولاتی که قبلاً از فروشگاه برداشته
            شده‌اند هم پیش‌نویس حساب می‌شوند و دوباره منتشر می‌شوند.
          </p>
          {summary.data
            ? draftsLeftBehind(summary.data).map((note) => (
                <p key={note} className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
                  {note}
                </p>
              ))
            : null}
          <FormError message={error ?? summary.error?.message ?? null} />
        </div>
      </Modal>
    </>
  );
}
