import type { DraftPublishSummary, PublishDraftsResult } from '@/lib/api/types';
import { toPersianDigits } from '@/lib/format';

/** Drafts that stay unpublished, and why (Persian, one line per reason). */
export function draftsLeftBehind(summary: DraftPublishSummary): string[] {
  const notes: string[] = [];
  if (summary.noActiveVariant > 0) notes.push(`${toPersianDigits(summary.noActiveVariant)} محصول هیچ تنوع فعالی ندارد؛ ابتدا یک تنوع را فعال کنید.`);
  if (summary.blocked > 0) notes.push(`${toPersianDigits(summary.blocked)} محصول توسط مدیریت مسدود است و منتشر نمی‌شود.`);
  if (summary.storeNotApproved > 0) notes.push(`${toPersianDigits(summary.storeNotApproved)} محصول متعلق به فروشگاه‌های تأییدنشده یا تعلیق‌شده است.`);
  return notes;
}

/** Toast after a bulk publish. */
export function publishResultMessage(result: PublishDraftsResult): string {
  const left = result.remaining.noActiveVariant + result.remaining.blocked + result.remaining.storeNotApproved;
  const head = result.published > 0 ? `${toPersianDigits(result.published)} محصول منتشر شد.` : 'محصولی برای انتشار نبود.';
  return left > 0 ? `${head} ${toPersianDigits(left)} پیش‌نویس به‌دلیل نقص یا مسدودی منتشر نشد.` : head;
}
