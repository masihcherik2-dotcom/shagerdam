/**
 * Dynamic visual identity (GET /api/v1/branding). Every value is optional:
 * without a configured logo the storefront shows the built-in monogram
 * (lib/brand.ts), without banners the default home hero.
 */
export interface HeroBanner {
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
  heroBanners: HeroBanner[];
}

export interface AdminHeroBanner extends HeroBanner {
  isActive: boolean;
}

export interface AdminBranding {
  logoUrl: string | null;
  mobileLogoUrl: string | null;
  faviconUrl: string | null;
  heroBanners: AdminHeroBanner[];
  updatedAt: Record<'logoUrl' | 'mobileLogoUrl' | 'faviconUrl' | 'heroBanners', string | null>;
  history: Array<{ id: string; createdAt: string; actor: { id: string; fullName: string } | null; changedFields: string[] }>;
  auditLogId?: string;
}

export type BrandingSlot = 'logo' | 'mobile_logo' | 'favicon' | 'hero_banner';

export interface BrandingAsset {
  id: string;
  slot: BrandingSlot;
  url: string;
  thumbnailUrl: string;
  mimeType: string;
  width: number;
  height: number;
  sizeBytes: number;
  originalSizeBytes: number;
}

export const EMPTY_BRANDING: PublicBranding = { logoUrl: null, mobileLogoUrl: null, faviconUrl: null, heroBanners: [] };

/** Mirrors the backend rule: a site path (`/…`, not `//…`) or an https URL. */
export function isValidBannerLink(link: string): boolean {
  if (link.length > 500 || /[\s\\]/.test(link)) return false;
  if (link.startsWith('/')) return !link.startsWith('//');
  try {
    const url = new URL(link);
    return url.protocol === 'https:' && url.hostname !== '' && url.username === '' && url.password === '';
  } catch {
    return false;
  }
}

/** Links leaving the site open in a new tab. */
export function isExternalLink(link: string): boolean {
  return /^https:\/\//i.test(link);
}

/** Human labels of the fields in the change history. */
export const BRANDING_FIELD_LABELS: Record<string, string> = {
  logoUrl: 'لوگو',
  mobileLogoUrl: 'لوگوی موبایل',
  faviconUrl: 'فاوآیکن',
  heroBanners: 'بنرها',
};
