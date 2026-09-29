/**
 * Iranian mobile number handling.
 *
 * Two formats exist in the wild and both are accepted from clients:
 *   - national: `09XXXXXXXXX` — 11 digits, the format printed on invoices,
 *     exactly the `^09[0-9]{9}$` pattern the platform's contract specifies;
 *   - E.164:    `+989XXXXXXXXX` — 13 characters, country code 98 followed by the
 *     same ten digits without the leading zero.
 *
 * The database stores exactly one canonical form — E.164 — because
 * `users.mobile` is the identity business key and carries a unique index. Two
 * spellings of one number would create two accounts and split the OTP rate
 * limiter's buckets. Every write path must therefore go through {@link toE164}.
 *
 * The length constants below are the specification of that canonical form and
 * are asserted by unit tests: a validator that accepts `+98999000001` (12
 * characters, one digit short) would silently admit malformed numbers.
 */

/** National format: `09` followed by nine digits (11 characters). */
export const IRANIAN_MOBILE_NATIONAL_PATTERN = /^09[0-9]{9}$/;

/** National length in characters. */
export const NATIONAL_LENGTH = 11;

/** Canonical format: `+98`, then `9`, then nine digits (13 characters). */
export const IRANIAN_MOBILE_E164_PATTERN = /^\+989[0-9]{9}$/;

/** Canonical length in characters. */
export const E164_LENGTH = 13;

/** Digits only, with the country code but no `+`: `989XXXXXXXXX` (12 digits). */
const WITHOUT_PLUS_PATTERN = /^989[0-9]{9}$/;

/** International access-code spelling: `00989XXXXXXXXX` (14 digits). */
const WITH_ACCESS_CODE_PATTERN = /^00989[0-9]{9}$/;

/**
 * Normalizes any accepted spelling to E.164, or returns `null` when the input is
 * not a valid Iranian mobile number.
 *
 * Accepted: `09XXXXXXXXX`, `+989XXXXXXXXX`, `989XXXXXXXXX`, `00989XXXXXXXXX`.
 * Persian/Arabic-Indic digits and separators are normalized first, because users
 * paste numbers out of SMS messages and spreadsheet cells.
 */
export function toE164(input: string): string | null {
  const digits = toAsciiDigits(input).replace(/[\s()-]/g, '');

  if (IRANIAN_MOBILE_NATIONAL_PATTERN.test(digits)) {
    return `+98${digits.slice(1)}`;
  }
  if (WITH_ACCESS_CODE_PATTERN.test(digits)) {
    return `+98${digits.slice(4)}`;
  }
  if (WITHOUT_PLUS_PATTERN.test(digits)) {
    return `+98${digits.slice(2)}`;
  }
  if (IRANIAN_MOBILE_E164_PATTERN.test(digits)) {
    return digits;
  }
  return null;
}

/** Returns the national `09XXXXXXXXX` spelling of a canonical E.164 value. */
export function toNationalFormat(e164: string): string {
  return e164.startsWith('+98') ? `0${e164.slice(3)}` : e164;
}

/** Masks a mobile number for logs: `+989120000001` → `+98912****001`. */
export function maskMobile(mobile: string): string {
  if (mobile.length < 8) {
    return '***';
  }
  return `${mobile.slice(0, 6)}****${mobile.slice(-3)}`;
}

/** Converts Persian (۰-۹) and Arabic-Indic (٠-٩) digits to ASCII digits. */
export function toAsciiDigits(input: string): string {
  return input
    .replace(/[\u06F0-\u06F9]/g, (char) => String(char.charCodeAt(0) - 0x06f0))
    .replace(/[\u0660-\u0669]/g, (char) => String(char.charCodeAt(0) - 0x0660));
}
