import type { MetadataRoute } from 'next';

import { resolveSiteOrigin } from '@/lib/env';
import { ROBOTS_DISALLOW } from '@/lib/seo';

// Rendered per request: the origin comes from the runtime environment.
export const dynamic = 'force-dynamic';

export default function robots(): MetadataRoute.Robots {
  const origin = resolveSiteOrigin();
  return {
    rules: [{ userAgent: '*', allow: '/', disallow: [...ROBOTS_DISALLOW] }],
    sitemap: `${origin}/sitemap.xml`,
    host: origin,
  };
}
