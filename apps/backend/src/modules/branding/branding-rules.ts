/**
 * Storage format and validation rules for the platform's visual identity.
 *
 * Persisted in `system_configs` (no dedicated table — the TM's spec):
 *
 * | key                        | valueType | value                                     |
 * |----------------------------|-----------|-------------------------------------------|
 * | `branding.logo_url`        | STRING    | media URL, or `''` = not set (monogram)   |
 * | `branding.mobile_logo_url` | STRING    | media URL, or `''`                        |
 * | `branding.favicon_url`     | STRING    | media URL, or `''`                        |
 * | `branding.hero_banners`    | JSON      | `StoredHeroBanner[]`                      |
 *
 * A cleared value is stored as `''` rather than deleting the row so the admin
 * view keeps "last changed at" for every key. A missing row, `''` and an
 * unreadable value all mean "not set"; the public endpoint therefore always
 * degrades to the default identity instead of failing.
 *
 * Pure module (no Nest/Prisma) — unit-tested in `branding-rules.spec.ts`.
 */

import type { BrandingSlot } from '../media/branding-image';

export const BRANDING_KEYS = {
  logoUrl: 'branding.logo_url',
  mobileLogoUrl: 'branding.mobile_logo_url',
  faviconUrl: 'branding.favicon_url',
  heroBanners: 'branding.hero_banners',
} as const;

export type BrandingField = keyof typeof BRANDING_KEYS;
export const BRANDING_FIELDS = Object.keys(BRANDING_KEYS) as BrandingField[];
export const BRANDING_KEY_LIST: string[] = Object.values(BRANDING_KEYS);

/** Upload slot whose assets may be used for each image field. */
export const FIELD_SLOT: Readonly<Record<Exclude<BrandingField, 'heroBanners'>, BrandingSlot>> = {
  logoUrl: 'logo',
  mobileLogoUrl: 'mobile_logo',
  faviconUrl: 'favicon',
};

/** Public config cache (Redis). Purged after every committed update. */
export const BRANDING_CACHE_KEY = 'branding:public:v1';
/** Safety-net TTL only — invalidation is explicit. */
export const BRANDING_CACHE_TTL_SECONDS = 600;
/** Second purge after an update (see `BrandingService.invalidate`). */
export const BRANDING_DELAYED_INVALIDATION_MS = 2_000;

export const MAX_HERO_BANNERS = 10;
export const MAX_BANNER_TITLE_LENGTH = 120;
export const MAX_LINK_URL_LENGTH = 500;
/** How many recent changes the admin view lists. */
export const BRANDING_HISTORY_LIMIT = 20;
export const BRANDING_AUDIT_ENTITY = 'Branding';

export interface StoredHeroBanner {
  id: string;
  imageUrl: string;
  title: string | null;
  linkUrl: string | null;
  sortOrder: number;
  isActive: boolean;
}

export interface BrandingValues {
  logoUrl: string | null;
  mobileLogoUrl: string | null;
  faviconUrl: string | null;
  heroBanners: StoredHeroBanner[];
}

export interface PublicHeroBanner {
  id: string;
  imageUrl: string;
  title: string | null;
  linkUrl: string | null;
  sortOrder: number;
}

export interface PublicBranding {
  logoUrl: string | null;
  mobileLogoUrl: string | null;
  faviconUrl: string | null;
  heroBanners: PublicHeroBanner[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** Stable order: sortOrder, then the stored position. */
export function sortBanners<T extends { sortOrder: number }>(banners: readonly T[]): T[] {
  return banners
    .map((banner, index) => ({ banner, index }))
    .sort((a, b) => a.banner.sortOrder - b.banner.sortOrder || a.index - b.index)
    .map(({ banner }) => banner);
}

/**
 * Reads `branding.hero_banners`. Malformed JSON or entries are dropped (and
 * reported through `onInvalid`) — a corrupt row must not take the storefront down.
 */
export function parseStoredBanners(raw: string | null | undefined, onInvalid?: (reason: string) => void): StoredHeroBanner[] {
  if (raw === null || raw === undefined || raw.trim() === '') {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    onInvalid?.('hero banners value is not valid JSON');
    return [];
  }
  if (!Array.isArray(parsed)) {
    onInvalid?.('hero banners value is not an array');
    return [];
  }
  const banners: StoredHeroBanner[] = [];
  for (const entry of parsed) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || typeof entry.imageUrl !== 'string' || entry.imageUrl === '') {
      onInvalid?.('dropped a malformed hero banner entry');
      continue;
    }
    banners.push({
      id: entry.id,
      imageUrl: entry.imageUrl,
      title: optionalString(entry.title),
      linkUrl: optionalString(entry.linkUrl),
      sortOrder: typeof entry.sortOrder === 'number' && Number.isFinite(entry.sortOrder) ? entry.sortOrder : 0,
      isActive: entry.isActive !== false,
    });
  }
  return sortBanners(banners);
}

/** `system_configs` rows → values. */
export function valuesFromRows(rows: ReadonlyArray<{ key: string; value: string }>, onInvalid?: (reason: string) => void): BrandingValues {
  const byKey = new Map(rows.map((row) => [row.key, row.value]));
  return {
    logoUrl: optionalString(byKey.get(BRANDING_KEYS.logoUrl)),
    mobileLogoUrl: optionalString(byKey.get(BRANDING_KEYS.mobileLogoUrl)),
    faviconUrl: optionalString(byKey.get(BRANDING_KEYS.faviconUrl)),
    heroBanners: parseStoredBanners(byKey.get(BRANDING_KEYS.heroBanners), onInvalid),
  };
}

/** Public projection: active banners only, ordered, without the admin-only flag. */
export function toPublicBranding(values: BrandingValues): PublicBranding {
  return {
    logoUrl: values.logoUrl,
    mobileLogoUrl: values.mobileLogoUrl,
    faviconUrl: values.faviconUrl,
    heroBanners: sortBanners(values.heroBanners)
      .filter((banner) => banner.isActive)
      .map(({ id, imageUrl, title, linkUrl, sortOrder }) => ({ id, imageUrl, title, linkUrl, sortOrder })),
  };
}

/**
 * Banner link rules. Allowed: a site-relative path (`/search?categorySlug=x`)
 * or an absolute `https://` URL. Refused: protocol-relative `//host`, backslash
 * tricks (`/\host`), `javascript:`/`data:`/`http:` and control characters.
 * Returns the problem, or null when valid.
 */
export function linkUrlProblem(link: string): string | null {
  if (link.length > MAX_LINK_URL_LENGTH) {
    return `linkUrl must be at most ${MAX_LINK_URL_LENGTH} characters`;
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\s\\]/.test(link)) {
    return 'linkUrl must not contain whitespace, control characters or backslashes';
  }
  if (link.startsWith('/')) {
    if (link.startsWith('//')) {
      return 'linkUrl must be a site path like /search?… or an https:// URL';
    }
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(link);
  } catch {
    return 'linkUrl must be a site path like /search?… or an https:// URL';
  }
  if (parsed.protocol !== 'https:' || parsed.hostname === '' || parsed.username !== '' || parsed.password !== '') {
    return 'linkUrl must be a site path like /search?… or an https:// URL';
  }
  return null;
}

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

/** Changed fields between two value sets (for the audit row). */
export function changedFields(before: BrandingValues, after: BrandingValues): BrandingField[] {
  return BRANDING_FIELDS.filter((field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]));
}

/** Serialises a field for `system_configs.value`. */
export function serializeField(field: BrandingField, values: BrandingValues): string {
  if (field === 'heroBanners') {
    return JSON.stringify(values.heroBanners);
  }
  return values[field] ?? '';
}
