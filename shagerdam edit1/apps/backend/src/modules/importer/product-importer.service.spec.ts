import { categoryMatchKey, importerRateKeys } from './product-importer.service';

describe('categoryMatchKey', () => {
  it('matches spelling variants of the same category name', () => {
    const key = categoryMatchKey('گوشی موبایل');
    for (const variant of ['گوشي موبايل', 'گوشی‌موبایل', ' گوشی  موبایل ', 'گوشی-موبایل']) {
      expect(categoryMatchKey(variant)).toBe(key);
    }
  });

  it('matches Arabic kaf/yeh, punctuation and case differences', () => {
    expect(categoryMatchKey('كيف و كاور گوشی')).toBe(categoryMatchKey('کیف و کاور گوشی'));
    expect(categoryMatchKey('Mobile Phone')).toBe(categoryMatchKey('mobile-phone'));
    expect(categoryMatchKey('لوازم جانبی (موبایل)')).toBe(categoryMatchKey('لوازم جانبی موبایل'));
  });

  it('keeps genuinely different names apart', () => {
    expect(categoryMatchKey('گوشی موبایل')).not.toBe(categoryMatchKey('لوازم جانبی گوشی موبایل'));
    expect(categoryMatchKey('تبلت')).not.toBe(categoryMatchKey('لپ تاپ'));
  });
});

describe('importerRateKeys', () => {
  it('namespaces quota counters per vendor user', () => {
    expect(importerRateKeys.extract('u1')).toBe('importer:extract:u1');
    expect(importerRateKeys.images('u1')).toBe('importer:images:u1');
  });
});
