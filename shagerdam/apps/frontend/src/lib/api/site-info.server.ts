import { cache } from 'react';

import { EMPTY_SITE_INFO, normalizeSiteInfo } from '../site-info';
import type { SiteInfo } from './types';
import { serverApiOrNull } from './server';

/**
 * Business identity for server components, fetched once per request (footer,
 * contact page and legal pages share one call; the API serves it from Redis).
 * A failure degrades to "nothing configured" — contact details are never a
 * reason for a page to fail.
 */
export const loadSiteInfo = cache(async (): Promise<SiteInfo> => {
  const info = await serverApiOrNull<SiteInfo>('site-info').catch(() => null);
  return info ? normalizeSiteInfo(info) : EMPTY_SITE_INFO;
});
