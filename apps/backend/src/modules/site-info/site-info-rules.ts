/**
 * Business identity and trust seals shown in the footer and on the contact /
 * legal pages. Legal identifiers are facts about the operating company, so
 * nothing is hard-coded: an administrator enters them in `/admin/site-info`
 * and the storefront renders a field only once it is set.
 *
 * Persisted in `system_configs` (one STRING row per field, `''` = cleared, as
 * for branding):
 *
 * | key                        | content                                         |
 * |----------------------------|-------------------------------------------------|
 * | `site.legal_name`          | registered company name                         |
 * | `site.national_id`         | شناسهٔ ملی (11 digits)                          |
 * | `site.registration_number` | شمارهٔ ثبت                                      |
 * | `site.support_phone`       | support phone, e.g. 021-91000000                |
 * | `site.support_email`       | support e-mail                                  |
 * | `site.office_address`      | head-office postal address                      |
 * | `site.postal_code`         | 10-digit postal code                            |
 * | `site.working_hours`       | free text, e.g. «شنبه تا چهارشنبه ۹ تا ۱۷»      |
 * | `site.enamad_link_url`     | eNamad verify URL (https://trustseal.enamad.ir/…) |
 * | `site.enamad_image_url`    | eNamad badge image (https://trustseal.enamad.ir/logo.aspx…) |
 * | `site.samandehi_link_url`  | Samandehi verify URL (https://logo.samandehi.ir/Verify.aspx…) |
 * | `site.samandehi_image_url` | Samandehi badge image (https://logo.samandehi.ir/logo.aspx…) |
 * | `site.google_site_verification` | Google Search Console token (`content` of the `google-site-verification` meta tag) |
 *
 * The seal URLs are the ones issued by enamad.ir / samandehi.ir for this
 * domain; only those two hosts are accepted so the footer can never be made
 * to load an arbitrary third-party image.
 *
 * Pure module (no Nest/Prisma) — unit-tested in `site-info-rules.spec.ts`.
 */

export const SITE_INFO_KEYS = {
  legalName: 'site.legal_name',
  nationalId: 'site.national_id',
  registrationNumber: 'site.registration_number',
  supportPhone: 'site.support_phone',
  supportEmail: 'site.support_email',
  officeAddress: 'site.office_address',
  postalCode: 'site.postal_code',
  workingHours: 'site.working_hours',
  enamadLinkUrl: 'site.enamad_link_url',
  enamadImageUrl: 'site.enamad_image_url',
  samandehiLinkUrl: 'site.samandehi_link_url',
  samandehiImageUrl: 'site.samandehi_image_url',
  googleVerificationTag: 'site.google_site_verification',
} as const;

export type SiteInfoField = keyof typeof SITE_INFO_KEYS;
export const SITE_INFO_FIELDS = Object.keys(SITE_INFO_KEYS) as SiteInfoField[];
export const SITE_INFO_KEY_LIST: string[] = Object.values(SITE_INFO_KEYS);

export type SiteInfoValues = Record<SiteInfoField, string | null>;

export const SITE_INFO_CACHE_KEY = 'site-info:public:v2';
export const SITE_INFO_CACHE_TTL_SECONDS = 600;
export const SITE_INFO_DELAYED_INVALIDATION_MS = 2_000;
export const SITE_INFO_AUDIT_ENTITY = 'SiteInfo';

export const MAX_LENGTH: Readonly<Record<SiteInfoField, number>> = {
  legalName: 150,
  nationalId: 11,
  registrationNumber: 20,
  supportPhone: 20,
  supportEmail: 254,
  officeAddress: 300,
  postalCode: 10,
  workingHours: 200,
  enamadLinkUrl: 500,
  enamadImageUrl: 500,
  samandehiLinkUrl: 500,
  samandehiImageUrl: 500,
  googleVerificationTag: 100,
};

/** Google's verification tokens are URL-safe base64-like strings (typically 43 characters). */
const GOOGLE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{10,100}$/;

/**
 * Accepts either the bare token or the whole tag Search Console shows
 * (`<meta name="google-site-verification" content="…" />`) and returns the token.
 */
export function extractGoogleVerificationToken(raw: string): string {
  const trimmed = raw.trim();
  const fromTag = /content\s*=\s*["']([^"']*)["']/i.exec(trimmed);
  if (fromTag && /google-site-verification/i.test(trimmed)) {
    return fromTag[1]!.trim();
  }
  return trimmed;
}

const SEAL_HOSTS: Readonly<Partial<Record<SiteInfoField, { host: string; path: RegExp }>>> = {
  enamadLinkUrl: { host: 'trustseal.enamad.ir', path: /^\/$/ },
  enamadImageUrl: { host: 'trustseal.enamad.ir', path: /^\/logo\.aspx$/i },
  samandehiLinkUrl: { host: 'logo.samandehi.ir', path: /^\/Verify\.aspx$/i },
  samandehiImageUrl: { host: 'logo.samandehi.ir', path: /^\/logo\.aspx$/i },
};

export const EMPTY_SITE_INFO: SiteInfoValues = Object.fromEntries(SITE_INFO_FIELDS.map((field) => [field, null])) as SiteInfoValues;

/** Persian/Arabic-Indic digits → ASCII, so «۰۲۱» and «021» are the same input. */
export function normalizeDigits(value: string): string {
  return value.replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0)).replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660));
}

/** Trims and collapses whitespace; control characters are rejected by {@link fieldProblem}. */
export function normalizeField(field: SiteInfoField, raw: string): string {
  const trimmed = raw.replace(/\s+/g, ' ').trim();
  if (field === 'nationalId' || field === 'registrationNumber' || field === 'postalCode' || field === 'supportPhone') {
    return normalizeDigits(trimmed).replace(/\s/g, '');
  }
  if (field === 'supportEmail') {
    return trimmed.toLowerCase();
  }
  if (field === 'googleVerificationTag') {
    return extractGoogleVerificationToken(raw);
  }
  return trimmed;
}

/** Validation of one normalised, non-empty value. Returns the problem, or null. */
export function fieldProblem(field: SiteInfoField, value: string): string | null {
  if (value.length > MAX_LENGTH[field]) {
    return `${field} must be at most ${MAX_LENGTH[field]} characters`;
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f<>]/.test(value)) {
    return `${field} must not contain control characters or angle brackets`;
  }
  switch (field) {
    case 'nationalId':
      return /^\d{11}$/.test(value) ? null : 'nationalId (شناسهٔ ملی) must be exactly 11 digits';
    case 'registrationNumber':
      return /^\d{1,20}$/.test(value) ? null : 'registrationNumber must contain digits only';
    case 'postalCode':
      return /^[1-9]\d{9}$/.test(value) ? null : 'postalCode must be 10 digits and must not start with 0';
    case 'supportPhone':
      return /^0\d{2,4}-?\d{4,8}$/.test(value) ? null : 'supportPhone must look like 021-91000000 or 09121234567';
    case 'supportEmail':
      return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value) ? null : 'supportEmail must be a valid e-mail address';
    case 'googleVerificationTag':
      return GOOGLE_TOKEN_PATTERN.test(value)
        ? null
        : 'googleVerificationTag must be the Search Console token (letters, digits, - and _) or the full google-site-verification meta tag';
    default:
      break;
  }
  const seal = SEAL_HOSTS[field];
  if (seal) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return `${field} must be the URL issued by ${seal.host}`;
    }
    if (url.protocol !== 'https:' || url.hostname !== seal.host || url.username !== '' || url.password !== '' || url.port !== '' || !seal.path.test(url.pathname) || url.search === '') {
      return `${field} must be the https://${seal.host} URL issued for this domain`;
    }
  }
  return null;
}

/** `system_configs` rows → values (unknown/empty → null; a stored value that no longer validates is dropped). */
export function valuesFromRows(rows: ReadonlyArray<{ key: string; value: string }>, onInvalid?: (reason: string) => void): SiteInfoValues {
  const byKey = new Map(rows.map((row) => [row.key, row.value]));
  const values = { ...EMPTY_SITE_INFO };
  for (const field of SITE_INFO_FIELDS) {
    const raw = byKey.get(SITE_INFO_KEYS[field]);
    if (raw === undefined || raw.trim() === '') continue;
    const problem = fieldProblem(field, raw);
    if (problem) {
      onInvalid?.(problem);
      continue;
    }
    values[field] = raw;
  }
  return values;
}

/** A seal is published only as a complete pair (a link without its image, or the reverse, is useless). */
export function toPublicSiteInfo(values: SiteInfoValues): SiteInfoValues {
  const result = { ...values };
  if (!result.enamadLinkUrl || !result.enamadImageUrl) {
    result.enamadLinkUrl = null;
    result.enamadImageUrl = null;
  }
  if (!result.samandehiLinkUrl || !result.samandehiImageUrl) {
    result.samandehiLinkUrl = null;
    result.samandehiImageUrl = null;
  }
  return result;
}

export function changedFields(before: SiteInfoValues, after: SiteInfoValues): SiteInfoField[] {
  return SITE_INFO_FIELDS.filter((field) => before[field] !== after[field]);
}
