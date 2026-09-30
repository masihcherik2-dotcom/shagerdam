/**
 * Image profiles for the platform's visual identity (logo, mobile logo,
 * favicon, home hero banners) and the SVG acceptance rules.
 *
 * Kept free of Nest/Prisma so the rules are unit-testable on their own.
 *
 * SVG policy: an SVG is accepted for the logo slots only (a banner is a photo),
 * and it is **never stored or served as SVG** — it is rasterised by Sharp
 * (librsvg) into WebP like every other upload. A served SVG is an active
 * document (script, external references, CSS) on the platform's origin; a
 * rasterised one is inert pixels. The XML is additionally screened before
 * librsvg parses it so entity-expansion ("billion laughs") and external
 * references are refused outright rather than relied on the parser to defuse.
 */

export const BRANDING_SLOTS = ['logo', 'mobile_logo', 'favicon', 'hero_banner'] as const;
export type BrandingSlot = (typeof BRANDING_SLOTS)[number];

/** `MediaAsset.purpose` recorded for each slot (the PATCH validator checks it). */
export const BRANDING_PURPOSE: Readonly<Record<BrandingSlot, string>> = {
  logo: 'branding_logo',
  mobile_logo: 'branding_mobile_logo',
  favicon: 'branding_favicon',
  hero_banner: 'branding_hero_banner',
};

export interface BrandingImageProfile {
  /** Box of the main rendition. */
  width: number;
  height: number;
  /**
   * `inside`: keep the aspect ratio within the box (logos, banners);
   * `contain`: exactly width×height, letter-boxed on transparency (favicon — a
   * browser tab icon must be square).
   */
  fit: 'inside' | 'contain';
  quality: number;
  /** Second rendition (admin preview / small icon), same fit rules. */
  thumbnail: { width: number; height: number; fit: 'inside' | 'contain'; quality: number };
  /** Lossless WebP keeps flat-colour logos crisp and small. */
  lossless: boolean;
  acceptsSvg: boolean;
  /** Minimum source size (after SVG rasterisation) — a blurry hero is worse than none. */
  minWidth: number;
  minHeight: number;
}

export const BRANDING_IMAGE_PROFILES: Readonly<Record<BrandingSlot, BrandingImageProfile>> = {
  logo: {
    width: 800,
    height: 240,
    fit: 'inside',
    quality: 90,
    thumbnail: { width: 320, height: 96, fit: 'inside', quality: 85 },
    lossless: true,
    acceptsSvg: true,
    minWidth: 64,
    minHeight: 16,
  },
  mobile_logo: {
    width: 512,
    height: 512,
    fit: 'inside',
    quality: 90,
    thumbnail: { width: 192, height: 192, fit: 'inside', quality: 85 },
    lossless: true,
    acceptsSvg: true,
    minWidth: 48,
    minHeight: 48,
  },
  favicon: {
    width: 512,
    height: 512,
    fit: 'contain',
    quality: 90,
    thumbnail: { width: 64, height: 64, fit: 'contain', quality: 90 },
    lossless: true,
    acceptsSvg: true,
    minWidth: 32,
    minHeight: 32,
  },
  hero_banner: {
    width: 1920,
    height: 1080,
    fit: 'inside',
    quality: 82,
    thumbnail: { width: 480, height: 270, fit: 'inside', quality: 75 },
    lossless: false,
    acceptsSvg: false,
    minWidth: 800,
    minHeight: 200,
  },
};

/** An SVG logo is text; anything larger than this is not a logo. */
export const MAX_SVG_BYTES = 512 * 1024;

/**
 * Render density for SVG rasterisation (librsvg's default is 72 dpi, i.e. the
 * SVG's nominal pixel size). 4× gives a sharp downscale for small nominal
 * sizes; the input-pixel limit still bounds huge canvases.
 */
export const SVG_RENDER_DENSITY = 288;

const SVG_HEAD_BYTES = 2048;

/**
 * True when the buffer looks like an SVG document: optional BOM/whitespace,
 * optional XML declaration, comments or doctype, then an `<svg` root element.
 */
export function isSvgDocument(buffer: Buffer): boolean {
  const head = buffer.subarray(0, SVG_HEAD_BYTES).toString('utf8').replace(/^\uFEFF/, '');
  const withoutPrologue = head
    .replace(/^\s*<\?xml[\s\S]*?\?>/i, '')
    .replace(/^(\s*<!--[\s\S]*?-->)+/, '')
    .replace(/^\s*<!DOCTYPE[^>[]*(\[[\s\S]*?\])?\s*>/i, '')
    .replace(/^(\s*<!--[\s\S]*?-->)+/, '');
  return /^\s*<svg[\s>]/i.test(withoutPrologue);
}

/** Why an SVG is refused, or null when it may be rasterised. */
export function svgRejectionReason(buffer: Buffer): string | null {
  if (buffer.byteLength > MAX_SVG_BYTES) {
    return `An SVG logo must not exceed ${MAX_SVG_BYTES / 1024} KB`;
  }
  const text = buffer.toString('utf8');
  if (/<!ENTITY/i.test(text)) {
    return 'SVG files declaring XML entities are not accepted';
  }
  // External resources (http(s)/file/data-less hrefs to other documents) would
  // make rendering depend on — or reach out to — something outside the file.
  if (/(?:xlink:)?href\s*=\s*["']\s*(?!#|data:image\/(?:png|jpeg|webp|gif);base64,)[^"']+["']/i.test(text)) {
    return 'SVG files referencing external resources are not accepted';
  }
  if (/@import|url\(\s*["']?\s*(?!#|data:)/i.test(text)) {
    return 'SVG files referencing external stylesheets or resources are not accepted';
  }
  return null;
}

export function isBrandingSlot(value: unknown): value is BrandingSlot {
  return typeof value === 'string' && (BRANDING_SLOTS as readonly string[]).includes(value);
}
