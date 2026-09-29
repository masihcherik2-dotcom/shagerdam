'use client';

import { CircleAlert, DownloadCloud, ImageDown, Link2, Sparkles } from 'lucide-react';
import { useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Checkbox, FormError, Input } from '@/components/ui/field';
import type { UploadedFile } from '@/components/ui/file-drop';
import { Badge } from '@/components/ui/misc';
import { Modal } from '@/components/ui/modal';
import { IMPORT_EXTRACT_TIMEOUT_MS, IMPORT_IMAGES_TIMEOUT_MS, apiPost } from '@/lib/api/client';
import { toApiError } from '@/lib/api/errors';
import type { FailedImage, ImportedProductDraft, IngestImagesResponse } from '@/lib/api/types';
import { useMutation } from '@/lib/hooks/use-api';
import { toPersianDigits } from '@/lib/format';
import { importSourceLabel, importStrategyLabels, ingestedToUploaded } from '@/lib/product-specs';

export interface ImportResult {
  draft: ImportedProductDraft;
  images: UploadedFile[];
  failures: FailedImage[];
}

interface ProductImportPanelProps {
  /** Free gallery slots (the product limit minus images already in the form). */
  imageSlots: number;
  /** The form already has content that applying the draft would overwrite. */
  hasExistingData: boolean;
  onApply: (result: ImportResult) => void;
}

const fileName = (url: string): string => {
  try {
    const parsed = new URL(url);
    return decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() ?? parsed.hostname);
  } catch {
    return url;
  }
};

/**
 * "Import from a link" for the new-product form. Step 1 fetches the draft
 * (POST /vendor/products/import/extract-spec — nothing is stored); step 2, in
 * a preview dialog, the vendor picks the images to keep and applies the draft:
 * the chosen images are copied into our media storage (ingest-images) and the
 * form is filled. The vendor then only adds price, stock and variants.
 */
export function ProductImportPanel({ imageSlots, hasExistingData, onApply }: ProductImportPanelProps) {
  const [url, setUrl] = useState('');
  const [urlError, setUrlError] = useState<string | null>(null);
  const [draft, setDraft] = useState<ImportedProductDraft | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [withImages, setWithImages] = useState(true);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);

  const extract = useMutation((link: string) =>
    apiPost<ImportedProductDraft>('/vendor/products/import/extract-spec', { url: link }, { timeout: IMPORT_EXTRACT_TIMEOUT_MS }),
  );

  async function fetchDraft(event: FormEvent) {
    event.preventDefault();
    const link = url.trim();
    if (!/^https?:\/\/\S+$/i.test(link)) {
      setUrlError('نشانی کامل صفحهٔ کالا را وارد کنید (با http:// یا https://).');
      return;
    }
    setUrlError(null);
    const result = await extract.run(link);
    if (result) {
      setDraft(result);
      setSelected(new Set(result.imageUrls.slice(0, imageSlots)));
      setWithImages(result.imageUrls.length > 0 && imageSlots > 0);
      setApplyError(null);
    }
  }

  function toggleImage(imageUrl: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(imageUrl)) next.delete(imageUrl);
      else if (next.size < imageSlots) next.add(imageUrl);
      return next;
    });
  }

  async function apply() {
    if (!draft) return;
    const imageUrls = withImages ? draft.imageUrls.filter((imageUrl) => selected.has(imageUrl)).slice(0, imageSlots) : [];
    setApplying(true);
    setApplyError(null);
    try {
      let images: UploadedFile[] = [];
      let failures: FailedImage[] = [];
      if (imageUrls.length > 0) {
        const ingested = await apiPost<IngestImagesResponse>('/vendor/products/import/ingest-images', { imageUrls }, { timeout: IMPORT_IMAGES_TIMEOUT_MS });
        images = ingested.items.map((item) => ingestedToUploaded(item));
        failures = ingested.failures;
      }
      onApply({ draft, images, failures });
      setDraft(null);
      setUrl('');
    } catch (caught) {
      setApplyError(toApiError(caught).message);
    } finally {
      setApplying(false);
    }
  }

  const selectedCount = draft ? draft.imageUrls.filter((imageUrl) => selected.has(imageUrl)).length : 0;

  return (
    <>
      <form onSubmit={(event) => void fetchDraft(event)} noValidate className="flex flex-col gap-3">
        <p className="flex items-start gap-2 text-sm text-slate-600">
          <Sparkles className="mt-0.5 size-4 shrink-0 text-brand-600" />
          لینک صفحهٔ کالا در دیجی‌کالا یا هر فروشگاه اینترنتی دیگر را وارد کنید تا عنوان، برند، توضیحات، جدول مشخصات و تصاویر به‌صورت خودکار پر شود. شما فقط قیمت، موجودی و تنوع‌ها را وارد می‌کنید.
        </p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <div className="relative flex-1">
            <Link2 className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" aria-hidden />
            <Input
              type="url"
              dir="ltr"
              inputMode="url"
              aria-label="لینک صفحهٔ کالا"
              aria-invalid={urlError ? true : undefined}
              placeholder="https://www.digikala.com/product/dkp-…"
              className="ps-9"
              maxLength={2048}
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              disabled={extract.pending}
            />
          </div>
          <Button type="submit" loading={extract.pending} icon={<DownloadCloud className="size-4" />}>
            {extract.pending ? 'در حال دریافت…' : 'دریافت اطلاعات کالا'}
          </Button>
        </div>
        <FormError message={urlError ?? extract.error?.message} />
      </form>

      <Modal
        open={draft !== null}
        title="پیش‌نمایش اطلاعات دریافت‌شده"
        size="lg"
        onClose={() => (applying ? undefined : setDraft(null))}
        footer={
          <>
            <Button variant="secondary" onClick={() => setDraft(null)} disabled={applying}>
              انصراف
            </Button>
            <Button onClick={() => void apply()} loading={applying} icon={<ImageDown className="size-4" />}>
              {applying ? 'در حال انتقال تصاویر…' : 'اعمال در فرم'}
            </Button>
          </>
        }
      >
        {draft ? (
          <div className="flex flex-col gap-4 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="info">منبع: {importSourceLabel(draft)}</Badge>
              {importStrategyLabels(draft).map((label) => (
                <Badge key={label}>{label}</Badge>
              ))}
            </div>

            <dl className="grid gap-x-4 gap-y-2 sm:grid-cols-[8rem_1fr]">
              <dt className="text-slate-500">عنوان</dt>
              <dd className="font-medium">{draft.title}</dd>
              {draft.titleEn ? (
                <>
                  <dt className="text-slate-500">عنوان لاتین</dt>
                  <dd dir="ltr" className="text-start">
                    {draft.titleEn}
                  </dd>
                </>
              ) : null}
              <dt className="text-slate-500">برند</dt>
              <dd>{draft.brand ?? '—'}</dd>
              <dt className="text-slate-500">دسته‌بندی</dt>
              <dd>
                {draft.suggestedCategoryId ? (
                  <span>{draft.suggestedCategory ?? 'پیشنهاد شد'} — دستهٔ منطبق در فروشگاه انتخاب می‌شود.</span>
                ) : (
                  <span className="text-amber-700">
                    {draft.suggestedCategory ? `«${draft.suggestedCategory}» در دسته‌های فروشگاه پیدا نشد` : 'دسته‌بندی مشخص نشد'}؛ پس از اعمال، دسته را خودتان انتخاب کنید.
                  </span>
                )}
              </dd>
              <dt className="text-slate-500">مشخصات فنی</dt>
              <dd>{toPersianDigits(draft.specifications.length)} ردیف</dd>
              <dt className="text-slate-500">توضیحات</dt>
              <dd className="line-clamp-3 whitespace-pre-line text-slate-600">{draft.description ?? '—'}</dd>
            </dl>

            <div className="rounded-xl border border-slate-200 p-3">
              {draft.imageUrls.length === 0 ? (
                <p className="text-slate-500">تصویری در این صفحه پیدا نشد.</p>
              ) : imageSlots === 0 ? (
                <p className="text-amber-700">گالری محصول پر است؛ برای افزودن تصویر، ابتدا تصویری را از فرم حذف کنید.</p>
              ) : (
                <>
                  <Checkbox
                    label={`انتقال تصاویر به فروشگاه (${toPersianDigits(selectedCount)} از ${toPersianDigits(draft.imageUrls.length)} تصویر؛ حداکثر ${toPersianDigits(imageSlots)})`}
                    checked={withImages}
                    onChange={(event) => setWithImages(event.target.checked)}
                  />
                  {withImages ? (
                    <ul className="mt-3 grid max-h-48 gap-1 overflow-y-auto sm:grid-cols-2">
                      {draft.imageUrls.map((imageUrl, index) => (
                        <li key={imageUrl}>
                          <label className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1 hover:bg-slate-50">
                            <input
                              type="checkbox"
                              className="size-4 accent-brand-600"
                              checked={selected.has(imageUrl)}
                              disabled={!selected.has(imageUrl) && selectedCount >= imageSlots}
                              onChange={() => toggleImage(imageUrl)}
                            />
                            <span className="text-xs text-slate-500">{toPersianDigits(index + 1)}.</span>
                            <span dir="ltr" className="truncate text-xs text-slate-700" title={imageUrl}>
                              {fileName(imageUrl)}
                            </span>
                            {index === 0 ? <Badge tone="success">اصلی</Badge> : null}
                          </label>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  <p className="mt-2 text-xs text-slate-500">تصاویر روی سرور فروشگاه ذخیره و به WebP با تصویر بندانگشتی تبدیل می‌شوند.</p>
                </>
              )}
            </div>

            {hasExistingData ? (
              <p className="flex items-start gap-2 rounded-xl bg-amber-50 px-3 py-2 text-amber-800">
                <CircleAlert className="mt-0.5 size-4 shrink-0" />
                عنوان، برند، توضیحات، دسته‌بندی و جدول مشخصاتِ فعلی فرم با این اطلاعات جایگزین می‌شود؛ تصاویر فعلی حفظ و تصاویر جدید به انتهای گالری افزوده می‌شوند.
              </p>
            ) : null}
            <p className="text-xs text-slate-500">
              مسئولیت درستی اطلاعات و داشتن اجازهٔ استفاده از متن و تصاویر منبع با فروشنده است؛ پیش از انتشار، اطلاعات را بازبینی کنید.
            </p>
            <FormError message={applyError} />
          </div>
        ) : null}
      </Modal>
    </>
  );
}
