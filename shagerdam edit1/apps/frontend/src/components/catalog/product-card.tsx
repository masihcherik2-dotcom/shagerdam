import { BadgePercent, CalendarClock, ImageOff, Store } from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';

import type { ProductListItem } from '@/lib/api/types';
import { formatToman } from '@/lib/currency';
import { toPersianDigits } from '@/lib/format';
import { compareRials } from '@/lib/money';

/**
 * Listing card: thumbnail, "from" price with the matching strike-through
 * compare-at price and discount badge, colour swatches, store name and the
 * BNPL badge (shown only when the platform's credit programme is enabled).
 */
export function ProductCard({ product, bnplEnabled }: { product: ProductListItem; bnplEnabled: boolean }) {
  const { priceRange } = product;
  const hasRange = compareRials(priceRange.min, priceRange.max) !== 0;
  const swatches = product.colors.slice(0, 5);
  return (
    <Link
      href={`/products/${product.slug}`}
      className="group flex flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"
    >
      <div className="relative aspect-square bg-slate-100">
        {product.primaryImage ? (
          <Image
            src={product.primaryImage.thumbnailUrl ?? product.primaryImage.url}
            alt={product.title}
            fill
            sizes="(max-width: 768px) 50vw, 25vw"
            className="object-cover transition group-hover:scale-[1.02]"
            unoptimized
          />
        ) : (
          <div className="flex h-full items-center justify-center text-slate-400">
            <ImageOff className="size-10" />
          </div>
        )}
        <div className="absolute start-2 top-2 flex flex-col items-start gap-1">
          {product.maxDiscountPercent ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-rose-600 px-2 py-0.5 text-xs font-bold text-white">
              <BadgePercent className="size-3.5" />
              {toPersianDigits(product.maxDiscountPercent)}٪
            </span>
          ) : null}
          {bnplEnabled && product.inStock ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-600 px-2 py-0.5 text-[11px] font-bold text-white">
              <CalendarClock className="size-3.5" /> خرید اقساطی
            </span>
          ) : null}
        </div>
        {!product.inStock ? (
          <span className="absolute inset-x-0 bottom-0 bg-slate-900/70 py-1 text-center text-xs font-medium text-white">ناموجود</span>
        ) : null}
      </div>
      <div className="flex flex-1 flex-col gap-2 p-3">
        <h3 className="line-clamp-2 min-h-10 text-sm font-medium leading-5 text-slate-800">{product.title}</h3>
        <p className="flex items-center gap-1 text-xs text-slate-500">
          <Store className="size-3.5" /> {product.vendor.storeName}
        </p>
        {swatches.length > 0 ? (
          <div className="flex items-center gap-1" aria-label={`رنگ‌ها: ${product.colors.map((color) => color.name).join('، ')}`}>
            {swatches.map((color) => (
              <span
                key={color.name}
                title={color.name}
                className="size-4 rounded-full border border-slate-300"
                style={{ backgroundColor: color.hex ?? '#e2e8f0' }}
              />
            ))}
            {product.colors.length > swatches.length ? <span className="text-xs text-slate-400">+{toPersianDigits(product.colors.length - swatches.length)}</span> : null}
          </div>
        ) : null}
        <div className="mt-auto flex flex-col items-end gap-0.5 pt-1">
          {product.startingCompareAtPrice ? <span className="text-xs text-slate-400 line-through">{formatToman(product.startingCompareAtPrice)}</span> : null}
          <span className="text-sm font-bold text-slate-900">
            {hasRange ? <span className="me-1 text-xs font-normal text-slate-500">از</span> : null}
            {formatToman(priceRange.min)}
          </span>
        </div>
      </div>
    </Link>
  );
}

export function ProductGrid({ products, bnplEnabled }: { products: ProductListItem[]; bnplEnabled: boolean }) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
      {products.map((product) => (
        <ProductCard key={product.id} product={product} bnplEnabled={bnplEnabled} />
      ))}
    </div>
  );
}
