'use client';

import { use } from 'react';

import { VENDOR_BULK_ENDPOINTS } from '@/components/vendor/bulk-import-panel';
import { NewProductForm } from '@/components/vendor/new-product-form';

/** `?tab=bulk` opens the whole-store import tab (linked from the product list). */
export default function NewVendorProductPage({ searchParams }: { searchParams: Promise<{ tab?: string | string[] }> }) {
  const { tab } = use(searchParams);
  return (
    <NewProductForm
      createEndpoint="/vendor/products"
      cancelHref="/vendor/products"
      savedHref={(product) => `/vendor/products/${product.id}`}
      initialTab={tab === 'bulk' ? 'bulk' : 'single'}
      bulk={{
        endpoints: VENDOR_BULK_ENDPOINTS,
        productLink: (product) => ({ href: `/vendor/products/${product.id}`, label: product.isPublished ? 'ویرایش محصول' : 'ویرایش و انتشار' }),
      }}
    />
  );
}
