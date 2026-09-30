/**
 * Geographic reference data (not business data): the 31 provinces of Iran,
 * used by the address form's province selector.
 */
export const IRAN_PROVINCES = [
  'آذربایجان شرقی',
  'آذربایجان غربی',
  'اردبیل',
  'اصفهان',
  'البرز',
  'ایلام',
  'بوشهر',
  'تهران',
  'چهارمحال و بختیاری',
  'خراسان جنوبی',
  'خراسان رضوی',
  'خراسان شمالی',
  'خوزستان',
  'زنجان',
  'سمنان',
  'سیستان و بلوچستان',
  'فارس',
  'قزوین',
  'قم',
  'کردستان',
  'کرمان',
  'کرمانشاه',
  'کهگیلویه و بویراحمد',
  'گلستان',
  'گیلان',
  'لرستان',
  'مازندران',
  'مرکزی',
  'هرمزگان',
  'همدان',
  'یزد',
] as const;

/** Same rule as the backend (POSTAL_CODE_PATTERN): 10 digits, not starting with 0. */
export const POSTAL_CODE_PATTERN = /^[1-9][0-9]{9}$/;

/** Iranian mobile in any common form: 09xxxxxxxxx, 9xxxxxxxxx, +989xxxxxxxxx, 00989xxxxxxxxx. */
export const IRAN_MOBILE_PATTERN = /^(?:\+98|0098|98|0)?9\d{9}$/;

/** Iranian national code checksum (same algorithm the backend validates). */
export function isValidNationalCode(value: string): boolean {
  if (!/^\d{10}$/.test(value) || /^(\d)\1{9}$/.test(value)) {
    return false;
  }
  const digits = value.split('').map(Number);
  const check = digits[9]!;
  const sum = digits.slice(0, 9).reduce((total, digit, index) => total + digit * (10 - index), 0);
  const remainder = sum % 11;
  return remainder < 2 ? check === remainder : check === 11 - remainder;
}

/** Sheba (IBAN) format + ISO 13616 mod-97 check. */
export function isValidSheba(value: string): boolean {
  const iban = value.replace(/\s+/g, '').toUpperCase();
  if (!/^IR\d{24}$/.test(iban)) {
    return false;
  }
  const rearranged = `${iban.slice(4)}${iban.slice(0, 4)}`.replace(/[A-Z]/g, (letter) => String(letter.charCodeAt(0) - 55));
  let remainder = 0;
  for (const char of rearranged) {
    remainder = (remainder * 10 + Number(char)) % 97;
  }
  return remainder === 1;
}
