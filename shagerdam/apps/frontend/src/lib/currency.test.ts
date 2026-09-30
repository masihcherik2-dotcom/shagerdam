import { describe, expect, it } from 'vitest';

import { formatToman, rialsToToman, tomanToRials } from './currency';

describe('formatToman', () => {
  it('converts Rials to Toman with Persian digits and ٬ separators (TM example)', () => {
    expect(formatToman(35_000_000)).toBe('۳٬۵۰۰٬۰۰۰ تومان');
    expect(formatToman('35000000.00')).toBe('۳٬۵۰۰٬۰۰۰ تومان');
    expect(formatToman(35_000_000n)).toBe('۳٬۵۰۰٬۰۰۰ تومان');
  });

  it('handles zero, small and large amounts', () => {
    expect(formatToman('0.00')).toBe('۰ تومان');
    expect(formatToman(10)).toBe('۱ تومان');
    expect(formatToman(9_990)).toBe('۹۹۹ تومان');
    expect(formatToman(10_000)).toBe('۱٬۰۰۰ تومان');
    expect(formatToman('1234567890120.00')).toBe('۱۲۳٬۴۵۶٬۷۸۹٬۰۱۲ تومان');
    // Beyond Number.MAX_SAFE_INTEGER: string and bigint stay exact.
    expect(formatToman('90071992547409930')).toBe('۹٬۰۰۷٬۱۹۹٬۲۵۴٬۷۴۰٬۹۹۳ تومان');
  });

  it('keeps fractions of a Toman instead of rounding them away', () => {
    expect(formatToman(12_345)).toBe('۱٬۲۳۴٫۵ تومان');
    expect(formatToman('5.50')).toBe('۰٫۵۵ تومان');
    expect(formatToman('0.01')).toBe('۰٫۰۰۱ تومان');
    expect(formatToman(10.5)).toBe('۱٫۰۵ تومان');
  });

  it('formats negative (debit) amounts with a minus sign', () => {
    expect(formatToman('-2590000.00')).toBe('−۲۵۹٬۰۰۰ تومان');
  });

  it('can omit the unit', () => {
    expect(formatToman('35000000.00', { unit: false })).toBe('۳٬۵۰۰٬۰۰۰');
  });

  it('rejects values that are not amounts', () => {
    expect(() => formatToman('abc')).toThrow(TypeError);
    expect(() => formatToman('1.234')).toThrow(TypeError);
    expect(() => formatToman(Number.NaN)).toThrow(TypeError);
    expect(() => formatToman(Number.POSITIVE_INFINITY)).toThrow(TypeError);
  });
});

describe('tomanToRials', () => {
  it('multiplies Toman by 10 (TM rule: send value × 10)', () => {
    expect(tomanToRials(3_500_000)).toBe(35_000_000);
    expect(tomanToRials('3500000')).toBe(35_000_000);
  });

  it('accepts Persian/Arabic digits and separators', () => {
    expect(tomanToRials('۳٬۵۰۰٬۰۰۰')).toBe(35_000_000);
    expect(tomanToRials('٣٥٠٠٠')).toBe(350_000);
    expect(tomanToRials('3,500,000')).toBe(35_000_000);
    expect(tomanToRials(' 12 500 ')).toBe(125_000);
  });

  it('accepts one fraction digit (1 Rial = 0.1 Toman)', () => {
    expect(tomanToRials('1234.5')).toBe(12_345);
    expect(tomanToRials('۱۲۳۴٫۵')).toBe(12_345);
    expect(tomanToRials(0.1)).toBe(1);
  });

  it('rejects empty, negative, malformed and oversized values', () => {
    expect(() => tomanToRials('')).toThrow(RangeError);
    expect(() => tomanToRials('-5')).toThrow(RangeError);
    expect(() => tomanToRials(-5)).toThrow(RangeError);
    expect(() => tomanToRials('12.34')).toThrow(RangeError);
    expect(() => tomanToRials('12a')).toThrow(RangeError);
    expect(() => tomanToRials(Number.NaN)).toThrow(RangeError);
    expect(() => tomanToRials('9'.repeat(20))).toThrow(RangeError);
  });

  it('round-trips with formatToman and rialsToToman', () => {
    for (const rials of [0, 10, 12_345, 35_000_000, 999_999_990]) {
      expect(tomanToRials(rialsToToman(rials))).toBe(rials);
      expect(formatToman(tomanToRials(rialsToToman(rials)))).toBe(formatToman(rials));
    }
  });
});

describe('rialsToToman', () => {
  it('produces a plain Toman string for editable inputs', () => {
    expect(rialsToToman('45000000.00')).toBe('4500000');
    expect(rialsToToman(12_345)).toBe('1234.5');
    expect(rialsToToman('-2590000.00')).toBe('-259000');
  });
});
