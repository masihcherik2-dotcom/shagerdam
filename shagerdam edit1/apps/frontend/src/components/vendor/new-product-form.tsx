'use client';

import { Save } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import { useToast } from '@/components/providers/toast-provider';
import { Button, LinkButton } from '@/components/ui/button';
import { FormError } from '@/components/ui/field';
import { Card, PageHeader } from '@/components/ui/misc';
import { EMPTY_BASICS, ProductBasicsFields, validateBasics, type ProductBasics } from '@/components/vendor/product-basics';
import { ProductImportPanel, type ImportEndpoints, type ImportResult } from '@/components/vendor/product-import-panel';
import { SpecificationEditor } from '@/components/vendor/specification-editor';
import { VariantEditor } from '@/components/vendor/variant-editor';
import { apiPost } from '@/lib/api/client';
import type { CreateProductInput, CreateVariantInput, VendorProductDetail } from '@/lib/api/types';
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
}

/**
 * New-product form (basics, specifications, variants) with the link importer.
 * Used by vendors (/vendor/products/new) and by staff creating a product for a
 * store (/admin/vendors/[id]/products/new — per-store admin endpoints).
 */
export function NewProductForm({ createEndpoint, importEndpoints, imageUpload = true, cancelHref, savedHref, title = 'افزودن محصول', description }: NewProductFormProps) {
  const router = useRouter();
  const toast = useToast();
  const [basics, setBasics] = useState<ProductBasics>(EMPTY_BASICS);
  const [specRows, setSpecRows] = useState<SpecRow[]>([]);
  const [rows, setRows] = useState<VariantRow[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [specError, setSpecError] = useState<string | null>(null);
  const [variantError, setVariantError] = useState<string | null>(null);
  const [importNotes, setImportNotes] = useState<string[]>([]);
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
          <div className="flex gap-2">
            <LinkButton href={cancelHref} variant="secondary">
              انصراف
            </LinkButton>
            <Button type="submit" form={FORM_ID} loading={create.pending} icon={<Save className="size-4" />}>
              ذخیرهٔ محصول
            </Button>
          </div>
        }
      />
      <div className="flex flex-col gap-6">
        {/* Outside the product <form>: the import panel has its own form, and forms must not nest. */}
        <Card title="واردکردن هوشمند از لینک کالا">
          <ProductImportPanel endpoints={importEndpoints} imageSlots={MAX_MEDIA_PER_PRODUCT - basics.images.length} hasExistingData={hasExistingData} onApply={applyImport} />
          {importNotes.length > 0 ? (
            <ul className="mt-3 list-inside list-disc rounded-xl bg-amber-50 px-4 py-2 text-sm text-amber-800">
              {importNotes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          ) : null}
        </Card>
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
      </div>
    </>
  );
}
