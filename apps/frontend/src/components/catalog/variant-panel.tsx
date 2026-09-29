'use client';

import { BadgePercent, Check, Minus, Plus, ShieldCheck, ShoppingCart } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';

import { useCart } from '@/components/providers/cart-provider';
import { useToast } from '@/components/providers/toast-provider';
import { Button } from '@/components/ui/button';
import type { CreditPlans, ProductDetail, PublicVariant } from '@/lib/api/types';
import { toApiError } from '@/lib/api/errors';
import { formatToman } from '@/lib/currency';
import { toPersianDigits } from '@/lib/format';
import { multiplyRials } from '@/lib/money';

import { InstallmentCalculator } from './installment-calculator';

/** Matching key for a colour/size choice (null = the product has no such dimension). */
function pick(variants: PublicVariant[], color: string | null, size: string | null): PublicVariant | undefined {
  return variants.find((variant) => variant.colorName === color && variant.size === size);
}

/**
 * Colour × size matrix. Selecting options resolves the exact variant, whose
 * price, compare-at price, SKU, guarantee and live stock are shown; combos
 * that do not exist or are sold out are disabled. Add to Cart posts the
 * variant to the live cart and is disabled when out of stock.
 */
export function VariantPanel({ product, plans, initialSku = null }: { product: ProductDetail; plans: CreditPlans | null; initialSku?: string | null }) {
  const { addItem } = useCart();
  const toast = useToast();
  const variants = product.variants;
  const colors = product.colors;
  const sizes = product.sizes;

  // `?variant=<SKU>` (links published to price-comparison sites such as Torob)
  // opens that exact offer; otherwise the first variant in stock.
  const requested = initialSku ? variants.find((variant) => variant.sku === initialSku.trim().toUpperCase()) : undefined;
  const initial = requested ?? variants.find((variant) => variant.inStock) ?? variants[0];
  const [color, setColor] = useState<string | null>(initial?.colorName ?? null);
  const [size, setSize] = useState<string | null>(initial?.size ?? null);
  const [quantity, setQuantity] = useState(1);
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState(false);

  const selected = pick(variants, color, size);
  const maxQuantity = selected ? Math.min(selected.availableQuantity, 100) : 0;
  const lineAmount = useMemo(() => (selected ? multiplyRials(selected.price, Math.max(1, Math.min(quantity, Math.max(1, maxQuantity)))) : null), [selected, quantity, maxQuantity]);

  function chooseColor(next: string) {
    setColor(next);
    // Keep the size when that combination exists, otherwise jump to the first size of the colour.
    if (!pick(variants, next, size)) {
      const fallback = variants.find((variant) => variant.colorName === next && variant.inStock) ?? variants.find((variant) => variant.colorName === next);
      setSize(fallback?.size ?? null);
    }
    setQuantity(1);
    setAdded(false);
  }

  function chooseSize(next: string) {
    setSize(next);
    setQuantity(1);
    setAdded(false);
  }

  async function add() {
    if (!selected) return;
    setAdding(true);
    try {
      await addItem(selected.id, quantity);
      setAdded(true);
      toast.success(`${toPersianDigits(quantity)} عدد «${product.title}» به سبد خرید اضافه شد.`);
    } catch (caught) {
      toast.error(toApiError(caught).message);
    } finally {
      setAdding(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      {colors.length > 0 ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-sm font-bold text-slate-800">
            رنگ: <span className="font-normal text-slate-600">{color ?? '—'}</span>
          </legend>
          <div className="flex flex-wrap gap-2">
            {colors.map((option) => {
              const exists = variants.some((variant) => variant.colorName === option.name);
              const inStock = variants.some((variant) => variant.colorName === option.name && variant.inStock);
              const active = option.name === color;
              return (
                <button
                  key={option.name}
                  type="button"
                  disabled={!exists}
                  aria-pressed={active}
                  onClick={() => chooseColor(option.name)}
                  title={inStock ? option.name : `${option.name} (ناموجود)`}
                  className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm ${active ? 'border-brand-600 ring-2 ring-brand-100' : 'border-slate-300'} ${inStock ? '' : 'opacity-50'}`}
                >
                  <span className="size-5 rounded-full border border-slate-300" style={{ backgroundColor: option.hex ?? '#e2e8f0' }} />
                  {option.name}
                  {active ? <Check className="size-4 text-brand-600" /> : null}
                </button>
              );
            })}
          </div>
        </fieldset>
      ) : null}

      {sizes.length > 0 ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-sm font-bold text-slate-800">
            سایز: <span className="font-normal text-slate-600">{size ?? '—'}</span>
          </legend>
          <div className="flex flex-wrap gap-2">
            {sizes.map((option) => {
              const variant = pick(variants, color, option);
              const active = option === size;
              return (
                <button
                  key={option}
                  type="button"
                  disabled={!variant}
                  aria-pressed={active}
                  onClick={() => chooseSize(option)}
                  className={`min-w-12 rounded-xl border px-3 py-1.5 text-sm ${active ? 'border-brand-600 bg-brand-50 font-bold text-brand-700' : 'border-slate-300 text-slate-700'} ${!variant ? 'cursor-not-allowed line-through opacity-40' : !variant.inStock ? 'opacity-50' : ''}`}
                >
                  {option}
                </button>
              );
            })}
          </div>
        </fieldset>
      ) : null}

      <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
        {selected ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <div className="flex flex-col gap-1">
                {selected.compareAtPrice ? (
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-slate-400 line-through">{formatToman(selected.compareAtPrice)}</span>
                    {selected.discountPercent ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-rose-600 px-2 py-0.5 text-xs font-bold text-white">
                        <BadgePercent className="size-3.5" /> {toPersianDigits(selected.discountPercent)}٪
                      </span>
                    ) : null}
                  </div>
                ) : null}
                <span className="text-2xl font-black text-slate-900">{formatToman(selected.price)}</span>
              </div>
              <div className="text-end text-xs text-slate-500">
                <p dir="ltr" className="font-mono">
                  SKU: {selected.sku}
                </p>
                <p className={selected.inStock ? (selected.availableQuantity <= 3 ? 'font-bold text-amber-700' : 'text-emerald-700') : 'font-bold text-rose-700'}>
                  {selected.inStock
                    ? selected.availableQuantity <= 3
                      ? `فقط ${toPersianDigits(selected.availableQuantity)} عدد باقی مانده`
                      : `موجود در انبار (${toPersianDigits(selected.availableQuantity)} عدد)`
                    : 'ناموجود'}
                </p>
              </div>
            </div>
            {selected.guarantee ? (
              <p className="flex items-center gap-1.5 text-sm text-slate-600">
                <ShieldCheck className="size-4 text-emerald-600" /> {selected.guarantee}
              </p>
            ) : null}

            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center rounded-xl border border-slate-300 bg-white">
                <button type="button" onClick={() => setQuantity((value) => Math.min(maxQuantity, value + 1))} disabled={!selected.inStock || quantity >= maxQuantity} className="p-2.5 disabled:opacity-30" aria-label="افزایش تعداد">
                  <Plus className="size-4" />
                </button>
                <span className="w-10 text-center text-sm font-bold" aria-live="polite">
                  {toPersianDigits(quantity)}
                </span>
                <button type="button" onClick={() => setQuantity((value) => Math.max(1, value - 1))} disabled={quantity <= 1} className="p-2.5 disabled:opacity-30" aria-label="کاهش تعداد">
                  <Minus className="size-4" />
                </button>
              </div>
              <Button size="lg" className="flex-1" onClick={() => void add()} loading={adding} disabled={!selected.inStock} icon={<ShoppingCart className="size-5" />}>
                {selected.inStock ? 'افزودن به سبد خرید' : 'ناموجود'}
              </Button>
            </div>
            {added ? (
              <Link href="/cart" className="text-center text-sm font-medium text-brand-700 hover:underline">
                مشاهدهٔ سبد خرید و ادامهٔ خرید ←
              </Link>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-slate-600">این ترکیب رنگ و سایز موجود نیست؛ گزینهٔ دیگری انتخاب کنید.</p>
        )}
      </div>

      {plans && plans.creditEnabled && plans.items.length > 0 && lineAmount && selected?.inStock ? (
        <InstallmentCalculator amount={lineAmount} plans={plans} />
      ) : null}
    </div>
  );
}
