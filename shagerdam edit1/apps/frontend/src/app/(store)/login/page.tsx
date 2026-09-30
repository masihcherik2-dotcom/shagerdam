import type { Metadata } from 'next';
import { Suspense } from 'react';

import { LoginForm } from '@/components/auth/login-form';
import { Skeleton } from '@/components/ui/states';

export const metadata: Metadata = { title: 'ورود | ثبت‌نام', robots: { index: false } };

export default function LoginPage() {
  return (
    <div className="mx-auto w-full max-w-md py-6">
      <Suspense fallback={<Skeleton className="h-96" />}>
        <LoginForm />
      </Suspense>
    </div>
  );
}
