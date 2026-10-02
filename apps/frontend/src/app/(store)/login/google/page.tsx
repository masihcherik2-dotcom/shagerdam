import type { Metadata } from 'next';
import { Suspense } from 'react';

import { GoogleMobileBinding } from '@/components/auth/google-mobile-binding';
import { Skeleton } from '@/components/ui/states';

export const metadata: Metadata = { title: 'تکمیل ورود با گوگل', robots: { index: false } };

export default function GoogleLoginCompletionPage() {
  return (
    <div className="mx-auto w-full max-w-md py-6">
      <Suspense fallback={<Skeleton className="h-96" />}>
        <GoogleMobileBinding />
      </Suspense>
    </div>
  );
}
