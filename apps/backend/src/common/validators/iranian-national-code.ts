import { toAsciiDigits } from './iranian-mobile';

/**
 * Iranian national code (`کد ملی`) validation.
 *
 * The code is ten digits where the last digit is a check digit computed from the
 * first nine with weights 10…2. The algorithm below is the officially published
 * one and is what the civil registry uses:
 *
 *   sum = Σ digit[i] × (10 - i)   for i = 0…8
 *   remainder = sum mod 11
 *   check digit = remainder < 2 ? remainder : 11 - remainder
 *
 * Structural rules that also matter in practice:
 *   - all ten digits identical (`1111111111`) is rejected by the registry;
 *   - the code must be exactly ten digits after digit normalization.
 */
const NATIONAL_CODE_PATTERN = /^[0-9]{10}$/;
const REPEATED_DIGITS_PATTERN = /^(\d)\1{9}$/;

/** Normalizes Persian/Arabic-Indic digits and separators, then validates the checksum. */
export function isValidNationalCode(input: string): boolean {
  const code = toAsciiDigits(input).replace(/[\s-]/g, '');

  if (!NATIONAL_CODE_PATTERN.test(code) || REPEATED_DIGITS_PATTERN.test(code)) {
    return false;
  }

  const checkDigit = Number(code[9]);
  let sum = 0;
  for (let index = 0; index < 9; index += 1) {
    sum += Number(code[index]) * (10 - index);
  }

  const remainder = sum % 11;
  const expected = remainder < 2 ? remainder : 11 - remainder;
  return expected === checkDigit;
}

/** Strips separators and returns the canonical ten-digit form (no validation). */
export function normalizeNationalCode(input: string): string {
  return toAsciiDigits(input).replace(/[\s-]/g, '');
}
