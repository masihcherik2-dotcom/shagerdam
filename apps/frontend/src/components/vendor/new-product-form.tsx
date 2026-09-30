'use client';

import { Link2, Rocket, Save } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent, type ReactNode } from 'react';

import { useToast } from '@/components/providers/toast-provider';
import { Button, LinkButton } from '@/components/ui/button';
import { FormError } from '@/components/ui/field';
import { Card, PageHeader } from '@/components/ui/misc';
import { BulkImportPanel, type BulkImportEndpoints } from '@/components/vendor/bulk-import-panel';
import { EMPTY_BASICS, ProductBasicsFields, validateBasics, type ProductBasics } from '@/components/vendor/product-basics';
import { ProductImportPanel, type ImportEndpoints, type ImportResult } from '@/components/vendor/product-import-panel';
import { SpecificationEditor } from '@/components/vendor/specification-editor';
import { VariantEditor } from '@/components/vendor/variant-editor';
import { apiPost } from '@/lib/api/client';
import type { BulkItem, CreateProductInput, CreateVariantInput, VendorProductDetail } from '@/lib/api/types';
import { useMutation } from '@/lib/hooks/use-api';
import { toPersianDigits } from '@/lib/format';
import { MAX_MEDIA_PER_PRODUCT, duplicateSkus, variantRowToInput, type VariantRow } from '@/lib/product-form';
import { draftSpecRows, imageFailureMessage, specRowsToInput, type SpecRow } from '@/lib/product-specs';

const FORM_ID = 'new-product-form';

export interface NewProductFormProps {
  /** POST target of the finished product. */
  createEndpoint: string;
  importEndpoints?: ImportEndpoints;
  /** See ProductBasicsFields.imageUpload. */
  imageUpload?: boolean;
  cancelHref: string;
  /** Where to go after saving. */
  savedHref: (product: VendorProductDetail) => string;
  title?: string;
  description?: string;
  /** Whole-store import tab (crawl a store's sitemaps and import every product as a background job). */
  bulk?: {
    endpoints: BulkImportEndpoints;
    staff?: boolean;
    productLink: (product: NonNullable<BulkItem['product']>) => { href: string; label: string } | null;
  };
  /** Tab open on arrival (`?tab=bulk`). */
  initialTab?: ImportTab;
}

export type ImportTab = 'single' | 'bulk';

/**
 * New-product form (basics, specifications, variants) with the link importer.
 * Used by vendors (/vendor/products/new) and by staff creating a product for a
 * store (/admin/vendors/[id]/products/new — per-store admin endpoints).
 */
export function NewProductForm({ createEndpoint, importEndpoints, imageUpload = true, cancelHref, savedHref, title = 'افزودن محصول', description, bulk, initialTab = 'single' }: NewProductFormProps) {
  const router = useRouter();
  const toast = useToast();
  const [basics, setBasics] = useState<ProductBasics>(EMPTY_BASICS);
  const [specRows, setSpecRows] = useState<SpecRow[]>([]);
  const [rows, setRows] = useState<VariantRow[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [specError, setSpecError] = useState<string | null>(null);
  const [variantError, setVariantError] = useState<string | null>(null);
  const [importNotes, setImportNotes] = useState<string[]>([]);
  const [tab, setTab] = useState<ImportTab>(bulk ? initialTab : 'single');
  // A whole-store item that needs review, opened in the single importer (the key remounts the panel with the link).
  const [singleUrl, setSingleUrl] = useState<{ url: string; key: number } | null>(null);
  const create = useMutation((body: CreateProductInput) => apiPost<VendorProductDetail>(createEndpoint, body));

  const hasExistingData = Boolean(basics.title.trim() || basics.brand.trim() || basics.description.trim() || specRows.length);

  function applyImport({ draft, images, failures }: ImportResult) {
    setBasics((current) => ({
      ...current,
      title: draft.title.slice(0, 200),
      brand: (draft.brand ?? '').slice(0, 80),
      description: draft.description ?? '',
      categoryId: draft.suggestedCategoryId ?? current.categoryId,
      images: [...current.images, ...images].slice(0, MAX_MEDIA_PER_PRODUCT),
    }));
    setSpecRows(draftSpecRows(draft));
    setErrors({});
    setSpecError(null);

    const notes: string[] = [];
    if (!draft.suggestedCategoryId) notes.push('دسته‌بندی منطبقی پیدا نشد؛ دسته را انتخاب کنید.');
    for (const failure of failures) notes.push(`تصویر «${failure.sourceUrl.split('/').pop() ?? failure.sourceUrl}» منتقل نشد: ${imageFailureMessage(failure.code)}`);
    setImportNotes(notes);
    toast.success(
      `اطلاعات کالا اعمال شد: ${toPersianDigits(draft.specifications.length)} ردیف مشخصات و ${toPersianDigits(images.length)} تصویر. قیمت، موجودی و تنوع‌ها را وارد کنید.`,
    );
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const { errors: fieldErrors, payload } = validateBasics(basics);
    setErrors(fieldErrors);
    const specs = specRowsToInput(specRows);
    setSpecError(specs.ok ? null : specs.error);
    let rowError: string | null = null;
    const variants: CreateVariantInput[] = [];
    if (rows.length === 0) rowError = 'دست‌کم یک تنوع (رنگ/سایز/قیمت/موجودی) لازم است.';
    const duplicates = duplicateSkus(rows);
    if (!rowError && duplicates.length) rowError = `SKU تکراری: ${duplicates.join('، ')}`;
    for (const row of rows) {
      if (rowError) break;
      const result = variantRowToInput(row);
      if (result.ok) variants.push(result.value);
      else rowError = result.error;
    }
    setVariantError(rowError);
    if (!payload || !specs.ok || rowError) return;
    const product = await create.run({ ...payload, specifications: specs.value, variants });
    if (product) {
      toast.success('محصول ذخیره شد.');
      router.push(savedHref(product));
    }
  }

  const skuPrefix = basics.slug || basics.title;

  return (
    <>
      <PageHeader
        title={title}
        description={description}
        action={
          tab === 'single' ? (
            <div className="flex gap-2">
              <LinkButton href={cancelHref} variant="secondary">
                انصراف
              </LinkButton>
              <Button type="submit" form={FORM_ID} loading={create.pending} icon={<Save className="size-4" />}>
                ذخیرهٔ محصول
              </Button>
            </div>
          ) : (
            <LinkButton href={cancelHref} variant="secondary">
              بازگشت
            </LinkButton>
          )
        }
      />
      <div className="flex flex-col gap-6">
        {/* Outside the product <form>: the import panel has its own form, and forms must not nest. */}
        <Card title={bulk ? undefined : 'واردکردن هوشمند از لینک کالا'}>
          {bulk ? (
            <div className="mb-5 flex flex-wrap gap-2 border-b border-slate-200 pb-3" role="tablist" aria-label="روش واردکردن">
              <TabButton active={tab === 'single'} onClick={() => setTab('single')} icon={<Link2 className="size-4" />} testId="import-tab-single">
                از لینک یک کالا
              </TabButton>
              <TabButton active={tab === 'bulk'} onClick={() => setTab('bulk')} icon={<Rocket className="size-4" />} testId="import-tab-bulk">
                درون‌ریزی کل فروشگاه (یک‌جا) 🚀
              </TabButton>
            </div>
          ) : null}
          {bulk ? (
            <div hidden={tab !== 'bulk'}>
              <BulkImportPanel
                endpoints={bulk.endpoints}
                staff={bulk.staff}
                productLink={bulk.productLink}
                onOpenInSingleImporter={(url) => {
                  setSingleUrl((current) => ({ url, key: (current?.key ?? 0) + 1 }));
                  setTab('single');
                  window.scrollTo({ top: 0, behavior: 'smooth' });
                }}
              />
            </div>
          ) : null}
          {tab === 'single' ? (
            <>
          <ProductImportPanel key={singleUrl?.key ?? 0} initialUrl={singleUrl?.url} endpoints={importEndpoints} imageSlots={MAX_MEDIA_PER_PRODUCT - basics.images.length} hasExistingData={hasExistingData} onApply={applyImport} />
          {importNotes.length > 0 ? (
            <ul className="mt-3 list-inside list-disc rounded-xl bg-amber-50 px-4 py-2 text-sm text-amber-800">
              {importNotes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          ) : null}
            </>
          ) : null}
        </Card>
        {tab === 'single' ? (
        <form id={FORM_ID} onSubmit={(event) => void submit(event)} noValidate className="flex flex-col gap-6">
          <Card title="مشخصات و تصاویر">
            <ProductBasicsFields value={basics} onChange={setBasics} errors={errors} imageUpload={imageUpload} />
          </Card>
          <Card title="مشخصات فنی">
            <SpecificationEditor rows={specRows} onChange={setSpecRows} />
            <FormError message={specError} />
          </Card>
          <Card title="تنوع‌ها (رنگ × سایز)">
            <VariantEditor rows={rows} onChange={setRows} skuPrefix={skuPrefix} />
          </Card>
          <FormError message={variantError ?? create.error?.message} />
          <div className="flex justify-end">
            <Button type="submit" size="lg" loading={create.pending} icon={<Save className="size-5" />}>
              ذخیرهٔ محصول
            </Button>
          </div>
        </form>
        ) : null}
      </div>
    </>
  );
}

function TabButton({ active, onClick, icon, testId, children }: { active: boolean; onClick: () => void; icon: ReactNode; testId: string; children: ReactNode }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      data-testid={testId}
      className={`inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-medium transition-colors ${active ? 'bg-brand-600 text-white shadow-sm' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'}`}
    >
      {icon}
      {children}
    </button>
  );
}
