import type { UploadedFile } from '@/components/ui/file-drop';
import type { ImportedProductDraft, IngestedImage, ProductSpecification } from '@/lib/api/types';

/** Mirrors backend product-rules.ts (and the product_specifications columns). */
export const MAX_SPECIFICATIONS_PER_PRODUCT = 150;
export const SPECIFICATION_GROUP_MAX_LENGTH = 100;
export const SPECIFICATION_TITLE_MAX_LENGTH = 150;
export const SPECIFICATION_VALUE_MAX_LENGTH = 2000;

/** Editable specification row (a stable `key` keeps React inputs attached while rows move). */
export interface SpecRow {
  key: string;
  groupTitle: string;
  title: string;
  value: string;
}

let specCounter = 0;
export function newSpecKey(): string {
  specCounter += 1;
  return `spec-${specCounter}`;
}

export function emptySpecRow(groupTitle = ''): SpecRow {
  return { key: newSpecKey(), groupTitle, title: '', value: '' };
}

export function specRowsFrom(list: ReadonlyArray<ProductSpecification>): SpecRow[] {
  return list.map((spec) => ({ key: newSpecKey(), groupTitle: spec.groupTitle ?? '', title: spec.title, value: spec.value }));
}

export type SpecResult = { ok: true; value: ProductSpecification[] } | { ok: false; error: string };

/**
 * Validates the rows and returns the API payload. Completely empty rows are
 * dropped silently (an "add row" the vendor never filled); a half-filled row is
 * an error so nothing the vendor typed disappears without notice.
 */
export function specRowsToInput(rows: ReadonlyArray<SpecRow>): SpecResult {
  const value: ProductSpecification[] = [];
  for (const [index, row] of rows.entries()) {
    const groupTitle = row.groupTitle.trim();
    const title = row.title.trim();
    const text = row.value.replace(/\r\n?/g, '\n').trim();
    if (!groupTitle && !title && !text) continue;
    const label = `ردیف ${index + 1} مشخصات`;
    if (!title) return { ok: false, error: `${label}: عنوان ویژگی خالی است.` };
    if (!text) return { ok: false, error: `${label}: مقدار «${title}» خالی است.` };
    if (groupTitle.length > SPECIFICATION_GROUP_MAX_LENGTH) return { ok: false, error: `${label}: نام گروه حداکثر ${SPECIFICATION_GROUP_MAX_LENGTH} نویسه است.` };
    if (title.length > SPECIFICATION_TITLE_MAX_LENGTH) return { ok: false, error: `${label}: عنوان حداکثر ${SPECIFICATION_TITLE_MAX_LENGTH} نویسه است.` };
    if (text.length > SPECIFICATION_VALUE_MAX_LENGTH) return { ok: false, error: `${label}: مقدار حداکثر ${SPECIFICATION_VALUE_MAX_LENGTH} نویسه است.` };
    value.push({ groupTitle: groupTitle || null, title, value: text });
  }
  if (value.length > MAX_SPECIFICATIONS_PER_PRODUCT) {
    return { ok: false, error: `حداکثر ${MAX_SPECIFICATIONS_PER_PRODUCT} ردیف مشخصات مجاز است.` };
  }
  return { ok: true, value };
}

/** Consecutive rows with the same group, for display (the storefront table and the editor). */
export function groupSpecifications<T extends { groupTitle: string | null }>(list: ReadonlyArray<T>): Array<{ groupTitle: string | null; items: T[] }> {
  const groups: Array<{ groupTitle: string | null; items: T[] }> = [];
  for (const item of list) {
    const last = groups[groups.length - 1];
    if (last && last.groupTitle === item.groupTitle) last.items.push(item);
    else groups.push({ groupTitle: item.groupTitle, items: [item] });
  }
  return groups;
}

/** Gallery entry for an image the importer stored in our media pipeline. */
export function ingestedToUploaded(image: IngestedImage): UploadedFile {
  const name = decodeURIComponent(new URL(image.sourceUrl).pathname.split('/').filter(Boolean).pop() ?? 'image');
  return { id: image.id, url: image.url, thumbnailUrl: image.thumbnailUrl, name };
}

/** Specification rows from an import draft (group → groupTitle). */
export function draftSpecRows(draft: ImportedProductDraft): SpecRow[] {
  return specRowsFrom(draft.specifications.map((spec) => ({ groupTitle: spec.group, title: spec.title, value: spec.value })));
}

const SOURCE_LABELS: Record<ImportedProductDraft['source'], string> = { DIGIKALA: 'دیجی‌کالا', GENERIC: 'سایت فروشگاهی' };
const STRATEGY_LABELS: Record<ImportedProductDraft['strategies'][number], string> = {
  DIGIKALA_API: 'API دیجی‌کالا',
  JSON_LD: 'Schema.org (JSON-LD)',
  MICRODATA: 'Microdata',
  WOOCOMMERCE_ATTRIBUTES: 'جدول ویژگی‌های ووکامرس',
  OPEN_GRAPH: 'OpenGraph',
  HTML_META: 'عنوان و توضیح صفحه',
};

export function importSourceLabel(draft: ImportedProductDraft): string {
  return SOURCE_LABELS[draft.source];
}

export function importStrategyLabels(draft: ImportedProductDraft): string[] {
  return draft.strategies.map((strategy) => STRATEGY_LABELS[strategy] ?? strategy);
}

const IMAGE_FAILURE_MESSAGES: Record<string, string> = {
  INVALID_IMAGE: 'فایل تصویر معتبر نیست یا قالب آن پشتیبانی نمی‌شود.',
  UPSTREAM_STATUS: 'سرور تصویر خطا داد.',
  TIMEOUT: 'دریافت تصویر بیش از ۱۰ ثانیه طول کشید.',
  TOO_LARGE: 'حجم تصویر بیش از حد مجاز است.',
  NETWORK: 'ارتباط با سرور تصویر برقرار نشد.',
  BLOCKED_TARGET: 'نشانی تصویر غیرعمومی است.',
  TOO_MANY_REDIRECTS: 'سرور تصویر بیش از حد تغییر مسیر داد.',
  UNSUPPORTED_CONTENT: 'قالب پاسخ پشتیبانی نمی‌شود.',
};

export function imageFailureMessage(code: string): string {
  return IMAGE_FAILURE_MESSAGES[code] ?? 'تصویر دریافت نشد.';
}
