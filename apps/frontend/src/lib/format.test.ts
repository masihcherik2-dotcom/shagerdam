import { describe, expect, it } from 'vitest';

import { formatCount, formatDate, formatMobile, formatPercent, toLatinDigits, toPersianDigits } from './format';

describe('format helpers', () => {
  it('converts digits both ways', () => {
    expect(toPersianDigits('SHP-100000123')).toBe('SHP-۱۰۰۰۰۰۱۲۳');
    expect(toLatinDigits('۰۹۱۲۱۲۳۴۵۶۷')).toBe('09121234567');
    expect(toLatinDigits('٠٩١٢')).toBe('0912');
  });

  it('formats counts and percentages', () => {
    expect(formatCount(12_500)).toBe('۱۲٬۵۰۰');
    expect(formatPercent('9.00')).toBe('۹٪');
    expect(formatPercent('2.50')).toBe('۲٫۵٪');
    expect(formatPercent('abc')).toBe('—');
  });

  it('formats dates in the Solar Hijri calendar', () => {
    expect(formatDate('2026-09-28')).toContain('۱۴۰۵');
    expect(formatDate(null)).toBe('—');
    expect(formatDate('not a date')).toBe('—');
  });

  it('formats Iranian mobiles', () => {
    expect(formatMobile('+989121234567')).toBe('۰۹۱۲ ۱۲۳ ۴۵۶۷');
  });
});
