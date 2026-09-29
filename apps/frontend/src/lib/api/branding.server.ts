import { cache } from 'react';

import { EMPTY_BRANDING, type PublicBranding } from '../branding';
import { serverApiOrNull } from './server';

/**
 * Public branding for server components, fetched once per request (React
 * `cache`: layout metadata, header, footer and home share one call; the API
 * serves it from Redis). Any failure falls back to the default identity — the
 * logo is never a reason for a page to fail.
 */
export const loadBranding = cache(async (): Promise<PublicBranding> => {
  const branding = await serverApiOrNull<PublicBranding>('branding').catch(() => null);
  if (!branding || typeof branding !== 'object') return EMPTY_BRANDING;
  return {
    logoUrl: branding.logoUrl ?? null,
    mobileLogoUrl: branding.mobileLogoUrl ?? null,
    faviconUrl: branding.faviconUrl ?? null,
    heroBanners: Array.isArray(branding.heroBanners) ? branding.heroBanners : [],
  };
});
