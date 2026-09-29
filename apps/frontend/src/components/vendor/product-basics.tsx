'use client';

import { Checkbox, Field, Input, Select, Textarea, TomanInput } from '@/components/ui/field';
import { FileDrop, type UploadedFile } from '@/components/ui/file-drop';
import { Skeleton } from '@/components/ui/states';
import type { CategoryTree, CreateProductInput } from '@/lib/api/types';
import { tomanToRials } from '@/lib/currency';
import { useApi } from '@/lib/hooks/use-api';
import { toPersianDigits } from '@/lib/format';
import { MAX_MEDIA_PER_PRODUCT, PRODUCT_SLUG_PATTERN, flattenCategories } from '@/lib/product-form';

export interface ProductBasics {
  title: string;
  slug: string;
  categoryId: string;
  brand: string;
  basePriceToman: string;
  description: string;
  images: UploadedFile[];
  isPublished: boolean;
}

export const EMPTY_BASICS: ProductBasics = { title: '', slug: '', categoryId: '', brand: '', basePriceToman: '', description: '', images: [], isPublished: true };

export type BasicsPayload = Omit<CreateProductInput, 'variants'>;

/** Client-side mirror of CreateProductDto; returns field errors or the API payload (Rials). */
export function validateBasics(value: ProductBasics): { errors: Record<string, string>; payload: BasicsPayload | null } {
  const errors: Record<string, string> = {};
  const title = value.title.trim();
  if (title.length < 3 || title.length > 200) errors.title = 'عنوان باید ۳ تا ۲۰۰ نویسه باشد.';
  const slug = value.slug.trim();
  if (slug && (!PRODUCT_SLUG_PATTERN.test(slug) || slug.length > 200)) errors.slug = 'نامک فقط حروف کوچک لاتین، رقم و خط تیره.';
  if (!value.categoryId) errors.categoryId = 'دسته‌بندی را انتخاب کنید.';
  if (value.brand.trim().length > 80) errors.brand = 'برند حداکثر ۸۰ نویسه است.';
  let basePrice = 0;
  try {
    basePrice = tomanToRials(value.basePriceToman);
    if (basePrice <= 0) errors.basePrice = 'قیمت پایه باید بیشتر از صفر باشد.';
  } catch (caught) {
    errors.basePrice = caught instanceof Error ? caught.message : 'قیمت نامعتبر است.';
  }
  if (Object.keys(errors).length) return { errors, payload: null };
  return {
    errors,
    payload: {
      title,
      ...(slug ? { slug } : {}),
      categoryId: value.categoryId,
      brand: value.brand.trim() || null,
      description: value.description.trim() || null,
      basePrice,
      mediaIds: value.images.map((image) => image.id),
      isPublished: value.isPublished,
    },
  };
}

export function ProductBasicsFields({ value, onChange, errors }: { value: ProductBasics; onChange: (value: ProductBasics) => void; errors: Record<string, string> }) {
  const tree = useApi<CategoryTree>('/categories/tree');
  const set = <K extends keyof ProductBasics>(key: K, next: ProductBasics[K]) => onChange({ ...value, [key]: next });
  const options = tree.data ? flattenCategories(tree.data.items) : [];

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Field label="عنوان محصول" required error={errors.title} className="md:col-span-2">
        {(id, described) => <Input id={id} aria-describedby={described} maxLength={200} value={value.title} onChange={(event) => set('title', event.target.value)} />}
      </Field>
      <Field label="دسته‌بندی" required error={errors.categoryId ?? tree.error?.message}>
        {(id, described) =>
          tree.loading && !tree.data ? (
            <Skeleton className="h-10" />
          ) : (
            <Select id={id} aria-describedby={described} value={value.categoryId} onChange={(event) => set('categoryId', event.target.value)}>
              <option value="">انتخاب کنید…</option>
              {options.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </Select>
          )
        }
      </Field>
      <Field label="برند" error={errors.brand}>
        {(id, described) => <Input id={id} aria-describedby={described} maxLength={80} value={value.brand} onChange={(event) => set('brand', event.target.value)} />}
      </Field>
      <Field label="قیمت پایه (تومان)" required error={errors.basePrice} hint="قیمت نمایشی پیش‌فرض؛ قیمت واقعی هر تنوع در جدول تنوع‌ها تعیین می‌شود.">
        {(id, described) => <TomanInput id={id} aria-describedby={described} value={value.basePriceToman} onChange={(event) => set('basePriceToman', event.target.value)} />}
      </Field>
      <Field label="نامک (اختیاری)" error={errors.slug} hint="خالی بگذارید تا از عنوان ساخته شود.">
        {(id, described) => <Input id={id} aria-describedby={described} dir="ltr" maxLength={200} value={value.slug} onChange={(event) => set('slug', event.target.value.toLowerCase())} />}
      </Field>
      <Field label="توضیحات" className="md:col-span-2">
        {(id) => <Textarea id={id} rows={5} maxLength={20000} value={value.description} onChange={(event) => set('description', event.target.value)} />}
      </Field>
      <div className="md:col-span-2">
        <FileDrop
          upload={{ kind: 'image', purpose: 'product_image' }}
          value={value.images}
          onChange={(images) => set('images', images)}
          max={MAX_MEDIA_PER_PRODUCT}
          accept="image/jpeg,image/png,image/webp"
          label="تصاویر محصول"
          hint={`حداکثر ${toPersianDigits(MAX_MEDIA_PER_PRODUCT)} تصویر؛ تصویر اول، تصویر اصلی است. ترتیب را با دکمه‌ها تغییر دهید.`}
          orderable
        />
      </div>
      <div className="md:col-span-2">
        <Checkbox label="پس از ذخیره در فروشگاه منتشر شود" checked={value.isPublished} onChange={(event) => set('isPublished', event.target.checked)} />
      </div>
    </div>
  );
}
