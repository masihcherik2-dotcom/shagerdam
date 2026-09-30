/**
 * Platform identity shown in the UI. Mirrors apps/backend/src/common/brand.ts
 * (and the `platform.name` system config seeded by the backend).
 */
export const PLATFORM_NAME = 'شاگردم';
export const PLATFORM_NAME_EN = 'Shagerdam';
export const PLATFORM_TAGLINE = 'پلتفرم هوشمند خرید و فروش اقساطی';
/** Document title of the home page and default for pages without their own title. */
export const PLATFORM_TITLE = `${PLATFORM_NAME} | ${PLATFORM_TAGLINE}`;
/** Monogram shown in the header/footer logo box. */
export const PLATFORM_MONOGRAM = 'ش';

/**
 * Google Search Console ownership token of the production site (public by design:
 * it is published in the <meta name="google-site-verification"> tag). Fallback for
 * when /admin/site-info has no value.
 */
export const GOOGLE_SITE_VERIFICATION = 'f_2ZrCsF2zPQ3xfR3iN9MHJd5l7iUDn8wYP3ctN38zg';
