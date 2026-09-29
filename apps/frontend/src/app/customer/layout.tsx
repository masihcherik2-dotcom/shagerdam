import type { ReactNode } from 'react';

import { DashboardShell } from '@/components/layout/dashboard-shell';
import { SiteHeader } from '@/components/layout/site-header';

export const dynamic = 'force-dynamic';

/** Access is enforced by src/middleware.ts (role guard) and again by every backend endpoint. */
export default function CustomerLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <SiteHeader />
      <DashboardShell area="customer">{children}</DashboardShell>
    </>
  );
}
