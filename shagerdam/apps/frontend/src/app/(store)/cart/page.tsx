'use client';

import { AlertTriangle, ImageOff, Minus, PackageOpen, Plus, ShoppingBag, Store, Trash2, Truck } from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';
import { useState } from 'react';

import { useCart } from '@/components/providers/cart-provider';
import { useSession } from '@/components/providers/session-provider';
import { useToast } from '@/components/providers/toast-provider';
import { LinkButton } from '@/components/ui/button';
import { Money, PageHeader, ProgressBar } from '@/components/ui/misc';
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/states';
import { toApiError } from '@/lib/api/errors';
import type { CartLine, CartVendorGroup } from '@/lib/api/types';
import { formatToman } from '@/lib/currency';
import { formatCount, toPersianDigits } from '@/lib/format';
import { compareRials, shareOf } from '@/lib/money';

/** Backend line cap (MAX_LINE_QUANTITY). */
const MAX_LINE_QUANTITY = 100;

export default function CartPage() {
  const { cart, loading, error, reload } = useCart();
  const { user } = useSession();

  if (loading && !cart) {
    return (
      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]" role="status" aria-label="در حال بارگذاری سبد خرید">
        <div className="flex flex-col gap-4">
          <Skeleton className="h-48" />
          <Skeleton className="h-48" />
        </div>
        <Skeleton className="h-64" />
      </div>
    );
  }
  if (error && !cart) {
    return <ErrorState error={error} title="سبد خرید بارگذاری نشد" onRetry={() => void reload()} />;
  }
  if (!cart || cart.lineCount === 0) {
    return (
      <EmptyState
        icon={<ShoppingBag className="size-6" />}
        title="سبد خرید شما خالی است"
        description="محصولات دلخواه را از فروشگاه‌های مختلف به سبد اضافه کنید؛ همه را یک‌جا پرداخت می‌کنید."
        action={<LinkButton href="/search">مشاهدهٔ محصولات</LinkButton>}
      />
    );
  }

  const checkoutHref = user ? '/checkout' : `/login?next=${encodeURIComponent('/checkout')}`;

  return (
    <>
      <PageHeader title="سبد خرید" description={`${formatCount(cart.itemCount)} کالا از ${formatCount(cart.groups.length)} فروشگاه — هر فروشگاه یک مرسولهٔ جداگانه ارسال می‌کند.`} />
      <div className="grid items-start gap-6 lg:grid-cols-[1fr_20rem]">
        <div className="flex flex-col gap-4">
          {cart.hasPriceChanges ? (
            <p role="alert" className="flex items-start gap-2 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-900">
              <AlertTriangle className="mt-0.5 size-5 shrink-0" />
              قیمت برخی کالاها از زمان افزودن به سبد تغییر کرده است. مبلغ نهایی با قیمت‌های جدید محاسبه می‌شود؛ ردیف‌های تغییرکرده مشخص شده‌اند.
            </p>
          ) : null}
          {cart.groups.map((group) => (
            <VendorPackage key={group.vendor.storeSlug} group={group} />
          ))}
        </div>

        <aside className="flex flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm lg:sticky lg:top-20">
          <h2 className="text-base font-bold">خلاصهٔ سفارش</h2>
          <dl className="flex flex-col gap-3 text-sm">
            <div className="flex justify-between">
              <dt className="text-slate-600">مبلغ کالاها ({toPersianDigits(cart.itemCount)})</dt>
              <dd><Money rials={cart.itemsSubtotal} /></dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-600">هزینهٔ ارسال ({toPersianDigits(cart.groups.length)} مرسوله)</dt>
              <dd>{compareRials(cart.shippingTotal, 0) === 0 ? <span className="font-medium text-emerald-700">رایگان</span> : <Money rials={cart.shippingTotal} />}</dd>
            </div>
            <div className="flex justify-between border-t border-slate-100 pt-3 text-base font-black">
              <dt>مبلغ قابل پرداخت</dt>
              <dd><Money rials={cart.payableAmount} /></dd>
            </div>
          </dl>
          {cart.canCheckout ? (
            <LinkButton href={checkoutHref} size="lg">
              {user ? 'ادامه و انتخاب شیوهٔ پرداخت' : 'ورود و ادامهٔ خرید'}
            </LinkButton>
          ) : (
            <p className="rounded-xl bg-rose-50 px-3 py-2 text-xs leading-6 text-rose-800">برخی کالاها قابل خرید نیستند (ناموجود یا غیرفعال). آن‌ها را حذف یا تعدادشان را اصلاح کنید.</p>
          )}
          {!user ? <p className="text-xs leading-5 text-slate-500">پس از ورود، سبد خرید شما حفظ و با حسابتان یکی می‌شود.</p> : null}
        </aside>
      </div>
    </>
  );
}

function VendorPackage({ group }: { group: CartVendorGroup }) {
  const { shipping } = group;
  const remaining = shipping.remainingForFreeShipping;
  return (
    <section className="rounded-2xl border border-slate-200 bg-white shadow-sm" aria-label={`مرسولهٔ ${group.vendor.storeName}`}>
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-5 py-3">
        <p className="flex items-center gap-2 text-sm font-bold text-slate-900">
          <Store className="size-4 text-brand-600" /> {group.vendor.storeName}
        </p>
        <p className="flex items-center gap-1.5 text-xs text-slate-600">
          <Truck className="size-4" /> ارسال: {shipping.isFree ? <b className="text-emerald-700">رایگان</b> : <Money rials={shipping.fee} />}
        </p>
      </header>
      {!shipping.isFree && remaining !== null && compareRials(shipping.freeThreshold, 0) > 0 ? (
        <div className="flex flex-col gap-2 border-b border-slate-100 bg-emerald-50/50 px-5 py-3">
          <p className="text-xs text-emerald-900">
            فقط <b>{formatToman(remaining)}</b> دیگر از این فروشگاه بخرید تا ارسال رایگان شود.
          </p>
          <ProgressBar value={shareOf(group.itemsSubtotal, shipping.freeThreshold)} tone="success" label="پیشرفت تا ارسال رایگان" />
        </div>
      ) : shipping.isFree && compareRials(shipping.freeThreshold, 0) > 0 ? (
        <p className="border-b border-slate-100 bg-emerald-50/50 px-5 py-2 text-xs text-emerald-800">ارسال این مرسوله رایگان شد.</p>
      ) : null}
      <ul className="divide-y divide-slate-100">
        {group.lines.map((line) => (
          <CartLineRow key={line.id} line={line} />
        ))}
      </ul>
      <footer className="flex justify-between border-t border-slate-100 px-5 py-3 text-sm">
        <span className="text-slate-600">جمع این مرسوله</span>
        <Money rials={group.packageTotal} className="font-bold" />
      </footer>
    </section>
  );
}

function CartLineRow({ line }: { line: CartLine }) {
  const { updateQuantity, removeLine } = useCart();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const priceChanged = compareRials(line.unitPrice, line.priceWhenAdded) !== 0;
  const max = Math.min(line.availableQuantity, MAX_LINE_QUANTITY);
  const otherIssues = line.issues.filter((issue) => issue.code !== 'PRICE_CHANGED');

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    try {
      await action();
    } catch (caught) {
      toast.error(toApiError(caught).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className={`flex gap-4 px-5 py-4 ${busy ? 'opacity-60' : ''}`}>
      <Link href={`/products/${line.productSlug}`} className="relative size-20 shrink-0 overflow-hidden rounded-xl border border-slate-200 bg-slate-100">
        {line.image ? (
          <Image src={line.image.thumbnailUrl ?? line.image.url} alt={line.productTitle} fill sizes="80px" className="object-cover" unoptimized />
        ) : (
          <ImageOff className="m-auto mt-6 size-8 text-slate-400" />
        )}
      </Link>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <Link href={`/products/${line.productSlug}`} className="line-clamp-2 text-sm font-medium text-slate-800 hover:text-brand-700">
          {line.productTitle}
        </Link>
        <div className="flex flex-wrap items-center gap-3 text-xs text-slate-500">
          {line.colorName ? (
            <span className="flex items-center gap-1">
              <span className="size-3 rounded-full border border-slate-300" style={{ backgroundColor: line.colorHex ?? '#e2e8f0' }} /> {line.colorName}
            </span>
          ) : null}
          {line.size ? <span>سایز {line.size}</span> : null}
          {line.guarantee ? <span>{line.guarantee}</span> : null}
        </div>
        {priceChanged ? (
          <p className="flex flex-wrap items-center gap-1 text-xs text-amber-800">
            <AlertTriangle className="size-3.5" />
            قیمت از <span className="line-through">{formatToman(line.priceWhenAdded)}</span> به <b>{formatToman(line.unitPrice)}</b> تغییر کرد.
          </p>
        ) : null}
        {otherIssues.map((issue) => (
          <p key={issue.code} className="flex items-center gap-1 text-xs font-medium text-rose-700">
            <PackageOpen className="size-3.5" /> {issue.message}
          </p>
        ))}
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <div className="flex items-center rounded-xl border border-slate-300">
              <button
                type="button"
                disabled={busy || line.quantity >= max}
                onClick={() => void run(() => updateQuantity(line.id, line.quantity + 1))}
                className="p-2 disabled:opacity-30"
                aria-label="افزایش تعداد"
              >
                <Plus className="size-4" />
              </button>
              <span className="w-8 text-center text-sm font-bold">{toPersianDigits(line.quantity)}</span>
              <button
                type="button"
                disabled={busy || line.quantity <= 1}
                onClick={() => void run(() => updateQuantity(line.id, line.quantity - 1))}
                className="p-2 disabled:opacity-30"
                aria-label="کاهش تعداد"
              >
                <Minus className="size-4" />
              </button>
            </div>
            <button type="button" disabled={busy} onClick={() => void run(() => removeLine(line.id))} className="rounded-lg p-2 text-rose-600 hover:bg-rose-50" aria-label={`حذف ${line.productTitle}`}>
              <Trash2 className="size-4" />
            </button>
            {line.availableQuantity > 0 && line.availableQuantity <= 5 ? (
              <span className="text-xs text-amber-700">حداکثر {toPersianDigits(line.availableQuantity)} عدد موجود</span>
            ) : null}
          </div>
          <div className="flex flex-col items-end">
            <span className="text-xs text-slate-500">
              {line.compareAtPrice ? <span className="me-1 text-slate-400 line-through">{formatToman(line.compareAtPrice)}</span> : null}
              هر عدد {formatToman(line.unitPrice)}
            </span>
            <Money rials={line.lineTotal} className="text-sm font-bold" />
          </div>
        </div>
      </div>
    </li>
  );
}
