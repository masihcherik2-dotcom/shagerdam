import {
  formatSheba,
  isValidSheba,
  maskSheba,
  normalizeSheba,
  shebaBankCode,
} from './iranian-sheba';

/**
 * Reference values: the valid IBANs below are published sample/test accounts whose
 * check digits satisfy MOD 97-10. Every "invalid" case is invalid for exactly one
 * documented reason, so a future refactor of the algorithm cannot pass this suite
 * by accident.
 */
const VALID_IBANS = [
  'IR820540102680020817909002',
  'IR062960000000100324200001',
  'IR580540105180021273113007',
];

describe('isValidSheba', () => {
  it.each(VALID_IBANS)('accepts %s', (iban) => {
    expect(isValidSheba(iban)).toBe(true);
  });

  it('accepts a lowercase country code and spaces', () => {
    expect(isValidSheba('ir82 0540 1026 8002 0817 9090 02')).toBe(true);
  });

  it('accepts Persian digits and normalizes them first', () => {
    const persianDigits = 'IR۸۲۰۵۴۰۱۰۲۶۸۰۰۲۰۸۱۷۹۰۹۰۰۲';
    expect(isValidSheba(persianDigits)).toBe(true);
    expect(normalizeSheba(persianDigits)).toBe('IR820540102680020817909002');
  });

  it('rejects a single altered digit (checksum catches the typo)', () => {
    // The regex-only validation would accept this: the format is perfect and the
    // checksum is the only thing that notices.
    expect(isValidSheba('IR820540102680020817909003')).toBe(false);
  });

  it('rejects a transposed pair of digits', () => {
    expect(isValidSheba('IR820540102680020817909020')).toBe(false);
  });

  it.each([
    ['empty', ''],
    ['short IBAN', 'IR820540102680020817909'],
    ['extra digit', 'IR8205401026800208179090023'],
    ['non-numeric BBAN letters', 'IR82054010268002081790900A'],
    ['missing country code', '82054010268002081790900200'],
    ['a Turkish IBAN, which is a different country format', 'TR330006100519786457841326'],
    ['whitespace only', '   '],
  ])('rejects %s', (_label, value) => {
    expect(isValidSheba(value)).toBe(false);
  });
});

describe('shebaBankCode', () => {
  it('returns the three-digit bank code for a valid IBAN', () => {
    expect(shebaBankCode('IR820540102680020817909002')).toBe('054');
  });

  it('returns null for a well-formed IBAN whose check digits are wrong', () => {
    // Format alone is not a bank code: this one differs from the valid IBAN above
    // by a single digit, and reporting "bank 054" for it would be a wrong answer.
    expect(shebaBankCode('IR820540102680020817909003')).toBeNull();
  });

  it('returns null for input that is not an IBAN at all', () => {
    expect(shebaBankCode('not-an-iban')).toBeNull();
  });
});

describe('formatSheba', () => {
  it('groups the canonical IBAN in blocks of four', () => {
    expect(formatSheba('ir820540102680020817909002')).toBe('IR82 0540 1026 8002 0817 9090 02');
  });
});

describe('maskSheba', () => {
  it('keeps only the last four digits', () => {
    expect(maskSheba('IR820540102680020817909002')).toBe('IR…9002');
  });

  it('degrades safely for a malformed value', () => {
    expect(maskSheba('not-an-iban')).toBe('IR…');
  });
});
