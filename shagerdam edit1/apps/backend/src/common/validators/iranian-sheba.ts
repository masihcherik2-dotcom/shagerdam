import { toAsciiDigits } from './iranian-mobile';

/**
 * Iranian IBAN (`شبا`) validation.
 *
 * An Iranian IBAN is exactly 26 characters: the country code `IR`, two check
 * digits, then a 22-digit BBAN (3-digit bank code + 19-digit account). The check
 * digits follow ISO 13616 / ISO 7064 MOD 97-10:
 *
 *   1. move the first four characters to the end;
 *   2. replace every letter with its numeric value (`A` = 10 … `Z` = 35);
 *   3. the resulting integer must be ≡ 1 (mod 97).
 *
 * Validating the check digits — instead of matching `IR[0-9]{24}` — is what stops
 * a typo from being stored as a payout destination. A mistyped IBAN that passes
 * the regex but fails the checksum would send a vendor's money to a stranger's
 * account, and the platform would have no way to recover it.
 *
 * Digit normalization is reused from the mobile validator so a client that sends
 * Persian digits or spaces (`IR‌۸۲۰۵۴۰۱۰۸۰۱۰۲۳۴۵۶۷۸۹۰۱۲`) is accepted and
 * canonicalized rather than rejected for formatting.
 */
const IRANIAN_IBAN_LENGTH = 26;
const IRANIAN_IBAN_PATTERN = /^IR[0-9]{24}$/;
const BBAN_LENGTH = 22;

const LETTER_VALUES: Record<string, string> = {};
for (let index = 0; index < 26; index += 1) {
  LETTER_VALUES[String.fromCharCode(65 + index)] = String(10 + index);
}

/** Strips separators, converts Persian digits and uppercases the country code. */
export function normalizeSheba(input: string): string {
  return toAsciiDigits(input)
    .replace(/[\s-]/g, '')
    .toUpperCase();
}

/** Full ISO 13616 validation, including the MOD 97-10 check digits. */
export function isValidSheba(input: string): boolean {
  const iban = normalizeSheba(input);

  if (iban.length !== IRANIAN_IBAN_LENGTH || !IRANIAN_IBAN_PATTERN.test(iban)) {
    return false;
  }

  const rearranged = `${iban.slice(4)}${iban.slice(0, 4)}`;
  const numeric = rearranged.replace(/[A-Z]/g, (letter) => LETTER_VALUES[letter] ?? '');

  // The intermediate string (up to 26 digits) exceeds `Number.MAX_SAFE_INTEGER`,
  // so the remainder is computed digit by digit — the standard MOD 97-10 stream
  // algorithm. No arbitrary-precision dependency is needed for a fixed length.
  let remainder = 0;
  for (const digit of numeric) {
    remainder = (remainder * 10 + Number(digit)) % 97;
  }

  return remainder === 1;
}

/**
 * Bank code (the first three BBAN digits), or `null` when the IBAN is not valid.
 * Derived only from a checksum-valid IBAN: a bank code read off a mistyped account
 * number would be a report about a different bank than the one that was intended.
 */
export function shebaBankCode(input: string): string | null {
  const iban = normalizeSheba(input);
  if (!isValidSheba(iban)) {
    return null;
  }
  return iban.slice(4, 7);
}

/** Groups the canonical IBAN into blocks of four for display: `IR8205 4010 …`. */
export function formatSheba(input: string): string {
  return normalizeSheba(input).replace(/(.{4})/g, '$1 ').trim();
}

/** Last four digits of the account; safe to show in a list or an SMS. */
export function maskSheba(input: string): string {
  const iban = normalizeSheba(input);
  if (iban.length !== IRANIAN_IBAN_LENGTH) {
    return 'IR…';
  }
  return `IR…${iban.slice(-4)}`;
}

export { BBAN_LENGTH, IRANIAN_IBAN_LENGTH };
