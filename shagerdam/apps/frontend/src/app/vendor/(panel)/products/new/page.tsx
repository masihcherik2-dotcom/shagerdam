'use client';

import { NewProductForm } from '@/components/vendor/new-product-form';

export default function NewVendorProductPage() {
  return <NewProductForm createEndpoint="/vendor/products" cancelHref="/vendor/products" savedHref={(product) => `/vendor/products/${product.id}`} />;
}
