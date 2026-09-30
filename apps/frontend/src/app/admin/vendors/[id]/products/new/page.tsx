'use client';

import { useParams } from 'next/navigation';
import { use } from 'react';

import { useSession } from '@/components/providers/session-provider';
import { adminBulkEndpoints } from '@/components/vendor/bulk-import-panel';
import { adminImportEndpoints } from '@/components/vendor/product-import-panel';
import { NewProductForm } from '@/components/vendor/new-product-form';
import { AsyncView, EmptyState, Skeleton } from '@/components/ui/states';
import type { VendorAdminDetail } from '@/lib/api/types';
import { can } from '@/lib/auth/access';
import { useApi } from '@/lib/hooks/use-api';

/**
 * Staff add a product to a store (SUPER_ADMIN / ADMIN): the vendor's product
 * form and link importer, bound to the per-store admin endpoints — the product
 * belongs to the store, imported images to the owner's media library, and the
 * audit trail names the administrator.
 */
export default function AdminVendorNewProductPage({ searchParams }: { searchParams: Promise<{ tab?: string | string[] }> }) {
  const { id } = useParams<{ id: string }>();
  const { tab } = use(searchParams);
  const { user } = useSession();
  const allowed = can(user?.role, 'manageVendors');
  const state = useApi<VendorAdminDetail>(allowed ? `/admin/vendors/${id}` : null);

  if (!allowed) return <EmptyState title="دسترسی ندارید" description="افزودن محصول برای فروشگاه فقط برای مدیران امکان‌پذیر است." />;

  return (
    <AsyncView state={state} skeleton={<Skeleton className="h-[480px]" />}>
      {(vendor) =>
        vendor.status !== 'APPROVED' ? (
          <EmptyState title="فروشگاه تأییدشده نیست" description="برای افزودن محصول، ابتدا فروشگاه را تأیید کنید." />
        ) : (
          <NewProductForm
            title={`افزودن محصول برای «${vendor.storeName}»`}
            description="با لینک دیجی‌کالا یا صفحهٔ کالای دیگر اطلاعات را پر کنید، قیمت و موجودی را وارد و ذخیره کنید؛ با تیک «منتشر شود» محصول بلافاصله در فروشگاه نمایش داده می‌شود."
            createEndpoint={`/admin/vendors/${encodeURIComponent(vendor.id)}/products`}
            importEndpoints={adminImportEndpoints(vendor.id)}
            imageUpload={false}
            cancelHref={`/admin/vendors/${vendor.id}`}
            savedHref={(product) => (product.isPublished ? `/products/${encodeURIComponent(product.slug)}` : `/admin/vendors/${vendor.id}`)}
            initialTab={tab === 'bulk' ? 'bulk' : 'single'}
            bulk={{
              endpoints: adminBulkEndpoints(vendor.id),
              staff: true,
              productLink: (product) => (product.isPublished ? { href: `/products/${encodeURIComponent(product.slug)}`, label: 'مشاهده در فروشگاه' } : null),
            }}
          />
        )
      }
    </AsyncView>
  );
}
