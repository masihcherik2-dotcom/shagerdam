import type { ReactNode } from 'react';

import { SiteFooter } from '@/components/layout/site-footer';
import { SiteHeader } from '@/components/layout/site-header';

/** Public marketing page: storefront chrome, not the vendor dashboard shell. */
export default function VendorLandingLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <SiteHeader />
      <main className="mx-auto min-h-[60vh] max-w-7xl px-4 py-6">{children}</main>
      <SiteFooter />
    </>
  );
}
