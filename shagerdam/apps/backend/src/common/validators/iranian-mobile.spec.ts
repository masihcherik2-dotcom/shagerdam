import {
  E164_LENGTH,
  IRANIAN_MOBILE_E164_PATTERN,
  IRANIAN_MOBILE_NATIONAL_PATTERN,
  NATIONAL_LENGTH,
  maskMobile,
  toAsciiDigits,
  toE164,
  toNationalFormat,
} from './iranian-mobile';

describe('toE164', () => {
  it('normalizes the national format to canonical E.164', () => {
    expect(toE164('09120000001')).toBe('+989120000001');
    expect(toE164('09990000001')).toBe('+989990000001');
  });

  it('accepts the international spellings of the same number', () => {
    const expected = '+989120000001';
    expect(toE164('+989120000001')).toBe(expected);
    expect(toE164('989120000001')).toBe(expected);
    expect(toE164('00989120000001')).toBe(expected);
  });

  it('ignores separators and converts Persian/Arabic-Indic digits', () => {
    expect(toE164('0912 000 0001')).toBe('+989120000001');
    expect(toE164('+98-912-000-0001')).toBe('+989120000001');
    expect(toE164('09120000001')).toBe('+989120000001');
    expect(toE164('۰۹۱۲۰۰۰۰۰۰۱')).toBe('+989120000001');
    expect(toE164('٠٩١٢٠٠٠٠٠٠١')).toBe('+989120000001');
  });

  it('always produces a value that satisfies the canonical pattern and length', () => {
    for (const input of ['09120000001', '989120000001', '00989120000001', '+989120000001']) {
      const normalized = toE164(input);
      expect(normalized).not.toBeNull();
      expect(normalized as string).toHaveLength(E164_LENGTH);
      expect(IRANIAN_MOBILE_E164_PATTERN.test(normalized as string)).toBe(true);
    }
  });

  it('rejects values that are not Iranian mobile numbers', () => {
    const rejected = [
      '',
      '12345',
      '0912000000', // one digit short
      '091200000012', // one digit too many
      '08120000001', // landline area code
      '02123456789', // Tehran landline
      '+98999000001', // 12 characters: country code plus nine digits — malformed
      '+981200000001', // country code with a non-mobile subscriber number
      '+1234567890',
      'mobile',
      '0912000000a',
    ];

    for (const input of rejected) {
      expect(toE164(input)).toBeNull();
    }
  });

  it('is idempotent: normalizing canonical input returns it unchanged', () => {
    const canonical = '+989120000001';
    expect(toE164(canonical)).toBe(canonical);
    expect(toE164(toE164('09120000001') as string)).toBe(canonical);
  });
});

describe('toNationalFormat', () => {
  it('round-trips with toE164', () => {
    expect(toNationalFormat('+989120000001')).toBe('09120000001');
    expect(toE164(toNationalFormat('+989120000001'))).toBe('+989120000001');
  });

  it('returns non-E.164 input untouched instead of corrupting it', () => {
    expect(toNationalFormat('09120000001')).toBe('09120000001');
  });

  it('produces the national length and pattern', () => {
    const national = toNationalFormat('+989120000001');
    expect(national).toHaveLength(NATIONAL_LENGTH);
    expect(IRANIAN_MOBILE_NATIONAL_PATTERN.test(national)).toBe(true);
  });
});

describe('maskMobile', () => {
  it('keeps the country code and last digits only', () => {
    expect(maskMobile('+989120000001')).toBe('+98912****001');
    expect(maskMobile('+989120000001')).not.toContain('000000');
  });

  it('degrades safely for short input', () => {
    expect(maskMobile('123')).toBe('***');
  });
});

describe('toAsciiDigits', () => {
  it('converts Persian and Arabic-Indic digits', () => {
    expect(toAsciiDigits('۰۱۲۳۴۵۶۷۸۹')).toBe('0123456789');
    expect(toAsciiDigits('٠١٢٣٤٥٦٧٨٩')).toBe('0123456789');
    expect(toAsciiDigits('09۱2')).toBe('0912');
  });
});
