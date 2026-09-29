import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

import { CartProvider } from '@/components/providers/cart-provider';
import { SessionProvider } from '@/components/providers/session-provider';
import { ToastProvider } from '@/components/providers/toast-provider';
import { loadBranding } from '@/lib/api/branding.server';
import { getServerSession } from '@/lib/api/server';

import { vazirmatn } from './fonts';
import './globals.css';
import { PLATFORM_NAME, PLATFORM_TAGLINE, PLATFORM_TITLE } from '@/lib/brand';

export async function generateMetadata(): Promise<Metadata> {
  // Favicon / home-screen icon from the admin-managed branding; without one the
  // browser default applies (no broken icon link is emitted).
  const branding = await loadBranding();
  const appleIcon = branding.mobileLogoUrl ?? branding.faviconUrl;
  return {
    title: { default: PLATFORM_TITLE, template: `%s | ${PLATFORM_NAME}` },
    applicationName: PLATFORM_NAME,
    description: `${PLATFORM_NAME}، ${PLATFORM_TAGLINE} — خرید نقدی یا اقساطی (BNPL) از فروشگاه‌های تأییدشده.`,
    ...(branding.faviconUrl || appleIcon
      ? {
          icons: {
            ...(branding.faviconUrl ? { icon: [{ url: branding.faviconUrl, type: 'image/webp' }], shortcut: branding.faviconUrl } : {}),
            ...(appleIcon ? { apple: appleIcon } : {}),
          },
        }
      : {}),
  };
}

export const viewport: Viewport = {
  themeColor: '#1d4ed8',
};

export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  // First render already knows who is signed in (no flash of the anonymous header).
  const session = await getServerSession();
  return (
    // dir="rtl" + lang="fa": the whole application is right-to-left; Tailwind's
    // logical utilities (ps-*, pe-*, ms-*, me-*, text-start…) follow it.
    <html lang="fa" dir="rtl" className={vazirmatn.variable}>
      <body className="min-h-screen bg-surface-muted text-slate-900 antialiased">
        <SessionProvider initial={session}>
          <ToastProvider>
            <CartProvider>{children}</CartProvider>
          </ToastProvider>
        </SessionProvider>
      </body>
    </html>
  );
}
