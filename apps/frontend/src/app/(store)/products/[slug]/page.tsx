import { AtSign, BadgeCheck, ChevronLeft, Store } from 'lucide-react';
import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { ProductGallery } from '@/components/catalog/product-gallery';
import { ProductSpecifications } from '@/components/catalog/product-specifications';
import { VariantPanel } from '@/components/catalog/variant-panel';
import { Badge } from '@/components/ui/misc';
import { loadCreditPlans } from '@/lib/api/catalog.server';
import { PLATFORM_NAME } from '@/lib/brand';
import { serverApiOrNull } from '@/lib/api/server';
import type { ProductDetail } from '@/lib/api/types';
import { formatDate } from '@/lib/format';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<{ variant?: string | string[] }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const product = await serverApiOrNull<ProductDetail>(`products/${encodeURIComponent(slug)}`).catch(() => null);
  return product ? { title: product.title, description: product.description?.slice(0, 160) ?? undefined } : { title: 'محصول' };
}

export default async function ProductPage({ params, searchParams }: Props) {
  const { slug } = await params;
  const { variant } = await searchParams;
  const initialSku = typeof variant === 'string' ? variant : null;
  const [product, plans] = await Promise.all([serverApiOrNull<ProductDetail>(`products/${encodeURIComponent(slug)}`), loadCreditPlans()]);
  if (!product) {
    notFound();
  }
  const vendor = product.vendor;
  const instagram = vendor.instagramHandle?.replace(/^@/, '');

  return (
    <div className="flex flex-col gap-8">
      <nav aria-label="مسیر" className="flex flex-wrap items-center gap-1 text-xs text-slate-500">
        <Link href="/" className="hover:text-brand-700">
          {PLATFORM_NAME}
        </Link>
        {product.breadcrumbs.map((crumb) => (
          <span key={crumb.id} className="flex items-center gap-1">
            <ChevronLeft className="size-3" />
            <Link href={`/categories/${crumb.slug}`} className="hover:text-brand-700">
              {crumb.titleFa}
            </Link>
          </span>
        ))}
      </nav>

      <div className="grid gap-8 lg:grid-cols-2">
        <ProductGallery media={product.media} title={product.title} />

        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-2">
            {product.brand ? <span className="text-sm font-medium text-brand-700">{product.brand}</span> : null}
            <h1 className="text-2xl font-black leading-snug text-slate-900">{product.title}</h1>
          </div>

          {product.variants.length === 0 ? (
            <p className="rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-600">این محصول در حال حاضر گزینهٔ قابل فروشی ندارد.</p>
          ) : (
            <VariantPanel product={product} plans={plans.ok ? plans.data : null} initialSku={initialSku} />
          )}

          {/* Vendor card */}
          <section className="flex items-start gap-4 rounded-2xl border border-slate-200 bg-white p-4" aria-label="فروشنده">
            <div className="relative size-14 shrink-0 overflow-hidden rounded-2xl border border-slate-200 bg-slate-100">
              {vendor.logoUrl ? (
                <Image src={vendor.logoUrl} alt={vendor.storeName} fill sizes="56px" className="object-cover" unoptimized />
              ) : (
                <Store className="m-auto mt-3.5 size-7 text-slate-400" />
              )}
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-bold text-slate-900">{vendor.storeName}</p>
                {vendor.verifiedAt ? (
                  <Badge tone="success">
                    <BadgeCheck className="size-3.5" /> فروشگاه احرازشده
                  </Badge>
                ) : null}
              </div>
              {vendor.verifiedAt ? <p className="text-xs text-slate-500">عضو تأییدشده از {formatDate(vendor.verifiedAt)}</p> : null}
              {vendor.bio ? <p className="line-clamp-3 text-sm leading-6 text-slate-600">{vendor.bio}</p> : null}
              <div className="flex flex-wrap gap-3 text-sm">
                <Link href={`/search?vendor=${encodeURIComponent(vendor.storeSlug)}`} className="font-medium text-brand-700 hover:underline">
                  سایر محصولات این فروشگاه
                </Link>
                {instagram ? (
                  <a href={`https://instagram.com/${encodeURIComponent(instagram)}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium text-pink-700 hover:underline">
                    <AtSign className="size-4" /> اینستاگرام <span dir="ltr">@{instagram}</span>
                  </a>
                ) : null}
              </div>
            </div>
          </section>
        </div>
      </div>

      {product.description ? (
        <section className="rounded-2xl border border-slate-200 bg-white p-6">
          <h2 className="mb-3 text-lg font-bold text-slate-900">معرفی محصول</h2>
          <p className="whitespace-pre-line text-sm leading-8 text-slate-700">{product.description}</p>
        </section>
      ) : null}

      <ProductSpecifications specifications={product.specifications ?? []} />
    </div>
  );
}
