import { AtSign, BadgeCheck, ChevronLeft, Store } from 'lucide-react';
import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { cache } from 'react';

import { ProductGallery } from '@/components/catalog/product-gallery';
import { ProductSpecifications } from '@/components/catalog/product-specifications';
import { VariantPanel } from '@/components/catalog/variant-panel';
import { Badge } from '@/components/ui/misc';
import { loadCreditPlans } from '@/lib/api/catalog.server';
import { PLATFORM_NAME } from '@/lib/brand';
import { serverApiOrNull } from '@/lib/api/server';
import type { ProductDetail } from '@/lib/api/types';
import { resolveSiteOrigin } from '@/lib/env';
import { formatDate } from '@/lib/format';
import { absoluteUrl, productBreadcrumbJsonLd, productJsonLd, productMetaDescription, serializeJsonLd } from '@/lib/seo';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<{ variant?: string | string[] }> };

/** One backend call per request, shared by generateMetadata and the page. */
const loadProduct = cache((slug: string) => serverApiOrNull<ProductDetail>(`products/${encodeURIComponent(slug)}`));

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const product = await loadProduct(slug).catch(() => null);
  if (!product) return { title: 'محصول یافت نشد', robots: { index: false } };
  const path = `/products/${encodeURIComponent(product.slug)}`;
  const description = productMetaDescription(product);
  const origin = resolveSiteOrigin();
  const images = product.media.slice(0, 1).map((image) => ({ url: absoluteUrl(origin, image.url), alt: product.title }));
  return {
    title: product.title,
    description,
    alternates: { canonical: path },
    openGraph: { type: 'website', url: path, title: product.title, description, ...(images.length > 0 ? { images } : {}) },
    twitter: { card: images.length > 0 ? 'summary_large_image' : 'summary', title: product.title, description, ...(images.length > 0 ? { images: images.map((image) => image.url) } : {}) },
  };
}

export default async function ProductPage({ params, searchParams }: Props) {
  const { slug } = await params;
  const { variant } = await searchParams;
  const initialSku = typeof variant === 'string' ? variant : null;
  const [product, plans] = await Promise.all([loadProduct(slug), loadCreditPlans()]);
  if (!product) {
    notFound();
  }
  const vendor = product.vendor;
  const origin = resolveSiteOrigin();
  const jsonLd = serializeJsonLd([productJsonLd(product, origin), productBreadcrumbJsonLd(product, origin, PLATFORM_NAME)]);
  const instagram = vendor.instagramHandle?.replace(/^@/, '');

  return (
    <div className="flex flex-col gap-8">
      {/* Schema.org Product + BreadcrumbList; serializeJsonLd escapes `<` so the payload cannot close the script tag. */}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd }} />
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
