import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

import { CartProvider } from '@/components/providers/cart-provider';
import { SessionProvider } from '@/components/providers/session-provider';
import { ToastProvider } from '@/components/providers/toast-provider';
import { loadBranding } from '@/lib/api/branding.server';
import { getServerSession } from '@/lib/api/server';
import { loadSiteInfo } from '@/lib/api/site-info.server';
import { GOOGLE_SITE_VERIFICATION } from '@/lib/brand';
import { resolveSiteOrigin } from '@/lib/env';

import { vazirmatn } from './fonts';
import './globals.css';
import { PLATFORM_NAME, PLATFORM_TAGLINE, PLATFORM_TITLE } from '@/lib/brand';

export async function generateMetadata(): Promise<Metadata> {
  // Favicon / home-screen icon from the admin-managed branding; without one the
  // browser default applies (no broken icon link is emitted).
  const [branding, siteInfo] = await Promise.all([loadBranding(), loadSiteInfo()]);
  const appleIcon = branding.mobileLogoUrl ?? branding.faviconUrl;
  const description = `${PLATFORM_NAME}، ${PLATFORM_TAGLINE} — خرید نقدی یا اقساطی (BNPL) از فروشگاه‌های تأییدشده.`;
  return {
    // Absolute base for canonical/OG URLs; the og:image / twitter:image files
    // (app/opengraph-image.png, app/twitter-image.png) are emitted by Next.
    metadataBase: new URL(resolveSiteOrigin()),
    title: { default: PLATFORM_TITLE, template: `%s | ${PLATFORM_NAME}` },
    applicationName: PLATFORM_NAME,
    description,
    openGraph: {
      type: 'website',
      locale: 'fa_IR',
      siteName: PLATFORM_NAME,
      title: PLATFORM_TITLE,
      description,
      url: '/',
    },
    twitter: {
      card: 'summary_large_image',
      title: PLATFORM_TITLE,
      description,
    },
    formatDetection: { telephone: false },
    // Google Search Console ownership tag, managed in /admin/site-info (token validated by the API).
    // google-site-verification: the value saved in /admin/site-info wins (changeable without a deploy);
    // otherwise the site's own Search Console token, so verification never depends on the database.
    verification: { google: siteInfo.googleVerificationTag ?? GOOGLE_SITE_VERIFICATION },
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
