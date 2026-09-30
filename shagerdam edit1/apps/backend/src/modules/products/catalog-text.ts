/**
 * Text normalisation for the catalogue.
 *
 * Persian text reaches the API from many keyboards: Arabic "ي"/"ك" instead of
 * Persian "ی"/"ک", Arabic-Indic or Persian digits instead of ASCII, stray control
 * characters from copy-paste. Normalising once on write (titles, brands,
 * descriptions) and again on the search input keeps `ILIKE` matching honest.
 */

const ARABIC_YEH = /[\u064A\u0649]/g; // ي ى
const ARABIC_KAF = /\u0643/g; // ك
const ARABIC_TEH_MARBUTA_HEH = /\u06C0/g; // ۀ → هٔ is kept as-is by most keyboards; only normalise the ligature form
const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const DIACRITICS = /[\u064B-\u065F\u0670]/g; // tashkil — never part of a searchable form
// eslint-disable-next-line no-control-regex -- stripping C0/C1 control characters is the point of this pattern
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

/** Canonical Persian letters, no control characters, collapsed inline whitespace. */
export function normalizePersianText(value: string): string {
  return value
    .normalize('NFC')
    .replace(CONTROL_CHARACTERS, '')
    .replace(ARABIC_YEH, 'ی')
    .replace(ARABIC_KAF, 'ک')
    .replace(ARABIC_TEH_MARBUTA_HEH, 'هٔ')
    .replace(/[^\S\n]+/g, ' ')
    .trim();
}

/** Multi-line variant for descriptions: keeps paragraph breaks, trims each line. */
export function normalizePersianParagraphs(value: string): string {
  return normalizePersianText(value.replace(/\r\n?/g, '\n'))
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

export function toAsciiDigits(value: string): string {
  return value.replace(/[۰-۹٠-٩]/g, (digit) => {
    const persian = PERSIAN_DIGITS.indexOf(digit);
    return String(persian >= 0 ? persian : ARABIC_DIGITS.indexOf(digit));
  });
}

export function toPersianDigits(value: string): string {
  return value.replace(/[0-9]/g, (digit) => PERSIAN_DIGITS[Number(digit)] as string);
}

/**
 * The forms a search term is matched in: as typed (normalised), with ASCII
 * digits and with Persian digits. "آیفون ۱۵" therefore finds "آیفون 15" and
 * vice versa. Duplicates are removed, so a term without digits yields one form.
 */
export function searchTermVariants(term: string): string[] {
  const normalized = normalizePersianText(term).replace(DIACRITICS, '');
  if (normalized.length === 0) {
    return [];
  }
  return [...new Set([normalized, toAsciiDigits(normalized), toPersianDigits(normalized)])];
}

/** Escapes `%`, `_` and `\` so user input is matched literally by (I)LIKE. */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/**
 * Product slugs: Unicode letters (lowercase where the script has case), digits
 * and single hyphens. Persian slugs are first-class — they are what Persian
 * shoppers type and share.
 */
export const PRODUCT_SLUG_PATTERN = /^[\p{Ll}\p{Lo}\p{Nd}]+(?:-[\p{Ll}\p{Lo}\p{Nd}]+)*$/u;
export const PRODUCT_SLUG_MAX_LENGTH = 200;

/**
 * Derives a slug from a title: canonical Persian letters, ASCII digits,
 * lowercase, every run of non-letter/digit characters (spaces, ZWNJ,
 * punctuation) becomes one hyphen. Returns an empty string when nothing usable
 * remains (e.g. a title made only of symbols) — the caller must then ask for a
 * custom slug.
 */
export function slugify(title: string): string {
  const slug = toAsciiDigits(normalizePersianText(title))
    .replace(DIACRITICS, '')
    .toLowerCase()
    .replace(/[^\p{Ll}\p{Lo}\p{Nd}]+/gu, '-')
    .replace(/^-+|-+$/g, '');

  if (slug.length <= PRODUCT_SLUG_MAX_LENGTH) {
    return slug;
  }
  // Cut on a hyphen boundary when possible so the slug does not end mid-word.
  const cut = slug.slice(0, PRODUCT_SLUG_MAX_LENGTH);
  const lastHyphen = cut.lastIndexOf('-');
  return (lastHyphen > PRODUCT_SLUG_MAX_LENGTH / 2 ? cut.slice(0, lastHyphen) : cut).replace(/-+$/, '');
}
