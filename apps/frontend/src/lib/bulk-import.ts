import { messageForCode } from '@/lib/api/error-messages';
import type { ApiError } from '@/lib/api/errors';
import type { BulkItem, BulkItemNote, BulkItemStatus, BulkJob, BulkJobStatus, BulkPriceUnit } from '@/lib/api/types';
import { toPersianDigits } from '@/lib/format';
import type { Tone } from '@/lib/labels';

/** Server limits of the whole-store importer (mirrors the backend quotas). */
export const BULK_MAX_URLS = 200;
export const BULK_DAILY_LIMIT = 400;
export const BULK_POLL_INTERVAL_MS = 2_000;
export const MAX_SITEMAP_PASTE_LENGTH = 900_000;
export const BULK_MAX_PRODUCT_OPTIONS = [50, 100, 150, 200] as const;

export const bulkItemStatusLabels: Record<BulkItemStatus, { label: string; tone: Tone }> = {
  PENDING: { label: 'در صف', tone: 'neutral' },
  PROCESSING: { label: 'در حال استخراج…', tone: 'info' },
  SUCCEEDED: { label: 'ساخته شد', tone: 'success' },
  SKIPPED: { label: 'تکراری', tone: 'neutral' },
  NEEDS_REVIEW: { label: 'نیاز به بررسی', tone: 'warning' },
  FAILED: { label: 'ناموفق', tone: 'danger' },
};

export const bulkJobStatusLabels: Record<BulkJobStatus, { label: string; tone: Tone }> = {
  RUNNING: { label: 'در حال درون‌ریزی', tone: 'info' },
  COMPLETED: { label: 'پایان یافت', tone: 'success' },
  CANCELLED: { label: 'متوقف شد', tone: 'warning' },
  INTERRUPTED: { label: 'نیمه‌کاره ماند', tone: 'danger' },
};

export const priceUnitLabels: Record<BulkPriceUnit, string> = {
  AUTO: 'تشخیص خودکار از صفحه (پیشنهادی)',
  IRT: 'قیمت‌های سایت به تومان است',
  IRR: 'قیمت‌های سایت به ریال است',
};

const NOTE_MESSAGES: Record<BulkItemNote, string> = {
  NO_IMAGE: 'هیچ تصویری از صفحه دریافت نشد؛ تصویر را دستی اضافه کنید.',
  SOME_IMAGES_FAILED: 'برخی تصاویر دریافت نشد.',
  OUT_OF_STOCK: 'در سایت مبدأ ناموجود است؛ موجودی صفر ثبت شد.',
};

const ITEM_CODE_MESSAGES: Record<string, string> = {
  NO_PRICE: 'قیمتی در صفحه پیدا نشد؛ آن را در واردکنندهٔ تکی باز کنید و قیمت را وارد کنید.',
  UNKNOWN_CURRENCY: 'واحد پول قیمت مشخص نیست؛ واحد قیمت (تومان یا ریال) را انتخاب و دوباره تلاش کنید.',
  FOREIGN_CURRENCY: 'قیمت این صفحه به ارز خارجی است و به ریال تبدیل نمی‌شود؛ در واردکنندهٔ تکی باز کنید و قیمت را خودتان وارد کنید.',
  NO_CATEGORY: 'دسته‌بندی منطبقی پیدا نشد؛ «دستهٔ پیش‌فرض» را انتخاب و دوباره تلاش کنید.',
  ALREADY_IMPORTED: 'این صفحه قبلاً در همین فروشگاه درون‌ریزی شده است.',
  INVALID_DRAFT: 'اطلاعات صفحه با قوانین ثبت محصول سازگار نبود.',
  INTERRUPTED: 'درون‌ریزی پیش از پایان این مورد متوقف شد؛ با «ادامه» دوباره انجام می‌شود.',
  INTERNAL: 'خطای پیش‌بینی‌نشده در سرور.',
};

/** Persian explanation of an item's outcome (null when there is nothing to say). */
export function describeBulkItem(item: BulkItem): string | null {
  if (item.status === 'SUCCEEDED') {
    const notes = item.notes.map((note) => NOTE_MESSAGES[note]);
    return notes.length > 0 ? notes.join(' ') : null;
  }
  if (item.code === null) return null;
  const known = ITEM_CODE_MESSAGES[item.code] ?? messageForCode(item.code);
  if (known) return known;
  const http = /^HTTP_(\d{3})$/.exec(item.code);
  if (http) return `ثبت محصول با خطای ${toPersianDigits(http[1] ?? '')} رد شد${item.message ? ` (${item.message})` : ''}.`;
  return item.message ?? item.code;
}

/** Items a retry would process again (the backend's retryable statuses). */
export function isRetryableItem(item: BulkItem): boolean {
  return item.status === 'PENDING' || item.status === 'PROCESSING' || item.status === 'FAILED' || item.status === 'NEEDS_REVIEW';
}

export function retryableCount(job: BulkJob): number {
  return job.items.filter(isRetryableItem).length;
}

/** Short readable name of a product page: its decoded last path segment. */
export function productUrlLabel(url: string): string {
  try {
    const parsed = new URL(url);
    const segment = parsed.pathname.split('/').filter(Boolean).pop();
    return segment ? decodeURIComponent(segment).replace(/[-_]+/g, ' ') : parsed.hostname;
  } catch {
    return url;
  }
}

/** Accepts `zarrinmetal.ir` or a full address; returns an http(s) URL or null. */
export function normalizeStoreUrl(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed === '') return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(withScheme);
    if (!/^https?:$/.test(parsed.protocol) || !parsed.hostname.includes('.')) return null;
    return withScheme;
  } catch {
    return null;
  }
}

/** `3600` → «حدود ۶۰ دقیقهٔ دیگر». */
export function formatRetryAfter(seconds: number): string {
  if (seconds < 90) return `${toPersianDigits(Math.max(1, Math.round(seconds)))} ثانیهٔ دیگر`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `حدود ${toPersianDigits(minutes)} دقیقهٔ دیگر`;
  return `حدود ${toPersianDigits(Math.round(minutes / 60))} ساعت دیگر`;
}

/** Persian message of a failed crawl/start request; the 429 quotas get their own wording. */
export function bulkErrorMessage(error: ApiError, action: 'crawl' | 'start'): string {
  if (error.status !== 429) return error.message;
  const details = typeof error.details === 'object' && error.details !== null ? (error.details as Record<string, unknown>) : {};
  const wait = typeof details.retryAfterSeconds === 'number' ? formatRetryAfter(details.retryAfterSeconds) : 'کمی بعد';
  return action === 'crawl'
    ? `سقف اسکن فروشگاه (۲۰ بار در ساعت) پر شده است؛ ${wait} دوباره تلاش کنید.`
    : `سقف درون‌ریزی گروهی (${toPersianDigits(BULK_DAILY_LIMIT)} محصول در ۲۴ ساعت) با این تعداد پر می‌شود؛ تعداد را کمتر کنید یا ${wait} دوباره تلاش کنید.`;
}
