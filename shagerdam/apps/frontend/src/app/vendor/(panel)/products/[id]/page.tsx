'use client';

import { ExternalLink, Plus, Save, ShieldAlert } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import { useToast } from '@/components/providers/toast-provider';
import { Button, LinkButton } from '@/components/ui/button';
import { FormError, Input } from '@/components/ui/field';
import { Card, PageHeader } from '@/components/ui/misc';
import { AsyncView, Skeleton } from '@/components/ui/states';
import { ProductBasicsFields, validateBasics, type ProductBasics } from '@/components/vendor/product-basics';
import { ProductStatusBadge } from '@/components/vendor/product-status-badge';
import { SpecificationEditor } from '@/components/vendor/specification-editor';
import { VariantEditor } from '@/components/vendor/variant-editor';
import { apiPatch, apiPost } from '@/lib/api/client';
import { toApiError } from '@/lib/api/errors';
import type { UpdateProductInput, UpdateVariantInput, VendorProductDetail, VendorVariant } from '@/lib/api/types';
import { rialsToToman, tomanToRials } from '@/lib/currency';
import { useApi, useMutation } from '@/lib/hooks/use-api';
import { formatCount, formatDateTime, toLatinDigits, toPersianDigits } from '@/lib/format';
import { MAX_STOCK, MAX_VARIANTS_PER_PRODUCT, duplicateSkus, variantRowToInput, type VariantRow } from '@/lib/product-form';
import { specRowsFrom, specRowsToInput, type SpecRow } from '@/lib/product-specs';

function basicsFrom(product: VendorProductDetail): ProductBasics {
  return {
    title: product.title,
    slug: product.slug,
    categoryId: product.category.id,
    brand: product.brand ?? '',
    basePriceToman: rialsToToman(product.basePrice),
    description: product.description ?? '',
    // Only gallery entries backed by an uploaded asset can be re-sent as mediaIds.
    images: product.media.filter((media) => media.mediaAssetId !== null).map((media) => ({ id: media.mediaAssetId ?? '', url: media.url, thumbnailUrl: media.thumbnailUrl, name: media.url.split('/').pop() ?? 'image' })),
    isPublished: product.isPublished,
  };
}

export default function EditVendorProductPage() {
  const { id } = useParams<{ id: string }>();
  const state = useApi<VendorProductDetail>(`/vendor/products/${id}`);
  return (
    <AsyncView state={state} skeleton={<Skeleton className="h-[600px]" />}>
      {(product) => <Editor key={product.updatedAt} product={product} reload={state.reload} />}
    </AsyncView>
  );
}

function Editor({ product, reload }: { product: VendorProductDetail; reload: () => Promise<void> }) {
  const toast = useToast();
  const [basics, setBasics] = useState<ProductBasics>(() => basicsFrom(product));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [newRows, setNewRows] = useState<VariantRow[]>([]);
  const [rowsError, setRowsError] = useState<string | null>(null);
  const [addingVariants, setAddingVariants] = useState(false);
  const [specRows, setSpecRows] = useState<SpecRow[]>(() => specRowsFrom(product.specifications));
  const [specError, setSpecError] = useState<string | null>(null);
  const saveSpecs = useMutation((body: UpdateProductInput) => apiPatch<VendorProductDetail>(`/vendor/products/${product.id}`, body));
  const save = useMutation((body: UpdateProductInput) => apiPatch<VendorProductDetail>(`/vendor/products/${product.id}`, body));
  const blocked = product.moderation.isBlockedByAdmin;

  async function saveBasics(event: FormEvent) {
    event.preventDefault();
    const { errors: fieldErrors, payload } = validateBasics(basics);
    setErrors(fieldErrors);
    if (!payload) return;
    const body: UpdateProductInput = { ...payload };
    if (blocked) delete body.isPublished; // staff block wins; publishing is refused anyway
    const result = await save.run(body);
    if (result) {
      toast.success('مشخصات محصول ذخیره شد.');
      await reload();
    }
  }

  async function saveSpecifications(event: FormEvent) {
    event.preventDefault();
    const specs = specRowsToInput(specRows);
    if (!specs.ok) return setSpecError(specs.error);
    setSpecError(null);
    const result = await saveSpecs.run({ specifications: specs.value });
    if (result) {
      toast.success('مشخصات فنی ذخیره شد.');
      await reload();
    }
  }

  async function addVariants() {
    const existing = new Set(product.variants.map((variant) => variant.sku));
    const duplicates = duplicateSkus(newRows).concat(newRows.map((row) => row.sku.trim().toUpperCase()).filter((sku) => existing.has(sku)));
    if (duplicates.length) return setRowsError(`SKU تکراری: ${[...new Set(duplicates)].join('، ')}`);
    const inputs = [];
    for (const row of newRows) {
      const result = variantRowToInput(row);
      if (!result.ok) return setRowsError(result.error);
      inputs.push({ key: row.key, input: result.value });
    }
    setRowsError(null);
    setAddingVariants(true);
    // One POST per variant; rows that succeed are removed so a retry only resends the failures.
    const failed = new Set<string>();
    let firstError: string | null = null;
    for (const { key, input } of inputs) {
      try {
        await apiPost(`/vendor/products/${product.id}/variants`, input);
      } catch (caught) {
        failed.add(key);
        firstError ??= `${input.sku}: ${toApiError(caught).message}`;
      }
    }
    setAddingVariants(false);
    const added = inputs.length - failed.size;
    if (added > 0) toast.success(`${toPersianDigits(added)} تنوع افزوده شد.`);
    if (firstError) {
      setRowsError(firstError);
      setNewRows((rows) => rows.filter((row) => failed.has(row.key)));
    }
    if (added > 0) await reload();
  }

  return (
    <>
      <PageHeader
        title={product.title}
        description={`آخرین به‌روزرسانی: ${formatDateTime(product.updatedAt)}`}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <ProductStatusBadge product={product} />
            {product.isPublished && !blocked ? (
              <Link href={`/products/${product.slug}`} target="_blank" className="flex items-center gap-1 text-sm text-brand-700 hover:underline">
                مشاهده در فروشگاه <ExternalLink className="size-4" />
              </Link>
            ) : null}
            <LinkButton href="/vendor/products" variant="secondary">
              بازگشت
            </LinkButton>
          </div>
        }
      />
      {blocked ? (
        <div className="mb-4 flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
          <ShieldAlert className="mt-0.5 size-5 shrink-0" />
          <div>
            این محصول توسط مدیریت مسدود شده و در فروشگاه نمایش داده نمی‌شود.
            {product.moderation.blockedReason ? <div className="mt-1">علت: {product.moderation.blockedReason}</div> : null}
          </div>
        </div>
      ) : null}

      <div className="flex flex-col gap-6">
        <Card title="مشخصات و تصاویر">
          <form onSubmit={(event) => void saveBasics(event)} noValidate className="flex flex-col gap-4">
            <ProductBasicsFields value={basics} onChange={setBasics} errors={errors} />
            <FormError message={save.error?.message} />
            <div>
              <Button type="submit" loading={save.pending} icon={<Save className="size-4" />}>
                ذخیرهٔ مشخصات
              </Button>
            </div>
          </form>
        </Card>

        <Card title="مشخصات فنی">
          <form onSubmit={(event) => void saveSpecifications(event)} noValidate className="flex flex-col gap-4">
            <SpecificationEditor rows={specRows} onChange={setSpecRows} />
            <FormError message={specError ?? saveSpecs.error?.message} />
            <div>
              <Button type="submit" loading={saveSpecs.pending} icon={<Save className="size-4" />}>
                ذخیرهٔ مشخصات فنی
              </Button>
            </div>
          </form>
        </Card>

        <Card title={`تنوع‌ها (${toPersianDigits(product.variants.length)})`}>
          <div className="overflow-x-auto rounded-xl border border-slate-200">
            <table className="w-full min-w-[900px] text-sm">
              <thead className="bg-slate-50 text-xs text-slate-600">
                <tr>
                  <th className="px-2 py-2 text-start font-medium">SKU</th>
                  <th className="px-2 py-2 text-start font-medium">رنگ / سایز</th>
                  <th className="px-2 py-2 text-start font-medium">قیمت (تومان)</th>
                  <th className="px-2 py-2 text-start font-medium">قبل از تخفیف</th>
                  <th className="px-2 py-2 text-start font-medium">موجودی</th>
                  <th className="px-2 py-2 text-start font-medium">رزرو / قابل فروش</th>
                  <th className="px-2 py-2 text-start font-medium">فعال</th>
                  <th className="px-2 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {product.variants.map((variant) => (
                  <VariantRowEditor key={`${variant.id}-${variant.updatedAt}`} variant={variant} onSaved={() => void reload()} />
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card title="افزودن تنوع جدید">
          <VariantEditor rows={newRows} onChange={setNewRows} skuPrefix={product.slug} capacity={MAX_VARIANTS_PER_PRODUCT - product.variants.length} />
          <FormError message={rowsError} />
          {newRows.length > 0 ? (
            <div className="mt-4">
              <Button loading={addingVariants} icon={<Plus className="size-4" />} onClick={() => void addVariants()}>
                ثبت {toPersianDigits(newRows.length)} تنوع جدید
              </Button>
            </div>
          ) : null}
        </Card>
      </div>
    </>
  );
}

function VariantRowEditor({ variant, onSaved }: { variant: VendorVariant; onSaved: () => void }) {
  const toast = useToast();
  const [price, setPrice] = useState(rialsToToman(variant.price));
  const [compare, setCompare] = useState(variant.compareAtPrice ? rialsToToman(variant.compareAtPrice) : '');
  const [stock, setStock] = useState(String(variant.stockQuantity));
  const [active, setActive] = useState(variant.isActive);
  const [error, setError] = useState<string | null>(null);
  const update = useMutation((body: UpdateVariantInput) => apiPatch<VendorVariant>(`/vendor/products/variants/${variant.id}`, body));

  async function saveRow() {
    const body: UpdateVariantInput = {};
    try {
      const nextPrice = tomanToRials(price);
      if (nextPrice <= 0) return setError('قیمت باید بیشتر از صفر باشد.');
      if (nextPrice !== Number(variant.price)) body.price = nextPrice;
      const nextCompare = compare.trim() ? tomanToRials(compare) : null;
      if (nextCompare !== null && nextCompare <= nextPrice) return setError('قیمت قبل از تخفیف باید بیشتر از قیمت فروش باشد.');
      if (nextCompare !== (variant.compareAtPrice === null ? null : Number(variant.compareAtPrice))) body.compareAtPrice = nextCompare;
    } catch (caught) {
      return setError(caught instanceof Error ? caught.message : 'مبلغ نامعتبر است.');
    }
    const stockText = toLatinDigits(stock.trim());
    if (!/^\d+$/.test(stockText) || Number(stockText) > MAX_STOCK) return setError('موجودی باید عدد صحیح نامنفی باشد.');
    if (Number(stockText) !== variant.stockQuantity) body.stockQuantity = Number(stockText);
    if (active !== variant.isActive) body.isActive = active;
    setError(null);
    if (Object.keys(body).length === 0) return;
    const result = await update.run(body);
    if (result) {
      toast.success(`تنوع ${variant.sku} به‌روزرسانی شد.`);
      onSaved();
    }
  }

  const dirty =
    price !== rialsToToman(variant.price) || compare !== (variant.compareAtPrice ? rialsToToman(variant.compareAtPrice) : '') || stock !== String(variant.stockQuantity) || active !== variant.isActive;

  return (
    <>
      <tr className={variant.isActive ? '' : 'bg-slate-50 text-slate-500'}>
        <td className="px-2 py-1.5">
          <span dir="ltr" className="font-mono text-xs">
            {variant.sku}
          </span>
        </td>
        <td className="px-2 py-1.5">
          <span className="flex items-center gap-1.5 text-xs">
            {variant.colorHex ? <span className="size-3 rounded-full border" style={{ background: variant.colorHex }} /> : null}
            {[variant.colorName, variant.size].filter(Boolean).join(' / ') || '—'}
          </span>
        </td>
        <td className="px-2 py-1.5">
          <Input aria-label="قیمت" dir="ltr" value={price} onChange={(event) => setPrice(event.target.value)} className="h-9 w-32" />
        </td>
        <td className="px-2 py-1.5">
          <Input aria-label="قیمت قبل از تخفیف" dir="ltr" value={compare} onChange={(event) => setCompare(event.target.value)} className="h-9 w-32" />
        </td>
        <td className="px-2 py-1.5">
          <Input aria-label="موجودی" dir="ltr" inputMode="numeric" value={stock} onChange={(event) => setStock(event.target.value)} className="h-9 w-24" />
        </td>
        <td className="px-2 py-1.5 text-xs">
          {formatCount(variant.reservedQuantity)} / <b>{formatCount(variant.availableQuantity)}</b>
        </td>
        <td className="px-2 py-1.5">
          <input type="checkbox" aria-label="فعال" checked={active} onChange={(event) => setActive(event.target.checked)} className="size-4 accent-brand-600" />
        </td>
        <td className="px-2 py-1.5">
          <Button size="sm" variant={dirty ? 'primary' : 'ghost'} disabled={!dirty} loading={update.pending} onClick={() => void saveRow()}>
            ذخیره
          </Button>
        </td>
      </tr>
      {error ?? update.error ? (
        <tr>
          <td colSpan={8} className="px-2 pb-2 text-xs text-rose-700">
            {error ?? update.error?.message}
          </td>
        </tr>
      ) : null}
    </>
  );
}
