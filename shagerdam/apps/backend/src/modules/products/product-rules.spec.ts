import {
  escapeLikePattern,
  normalizePersianParagraphs,
  normalizePersianText,
  PRODUCT_SLUG_PATTERN,
  searchTermVariants,
  slugify,
  toAsciiDigits,
  toPersianDigits,
} from './catalog-text';
import {
  discountPercent,
  duplicates,
  matrixProblems,
  normalizeSku,
  normalizeSpecifications,
  SKU_PATTERN,
  toMoney,
  variantFieldProblems,
  variantMatrixKey,
} from './product-rules';

describe('catalog text', () => {
  it('canonicalises Arabic letters, strips control characters and collapses spaces', () => {
    expect(normalizePersianText('  كتاب\u0000   علي  ')).toBe('کتاب علی');
  });

  it('keeps paragraph breaks in descriptions but trims each line', () => {
    expect(normalizePersianParagraphs('خط اول  \r\n\r\n\r\n\r\n  خط دوم ')).toBe('خط اول\n\nخط دوم');
  });

  it('converts between Persian, Arabic-Indic and ASCII digits', () => {
    expect(toAsciiDigits('۱۵ و ٢٥')).toBe('15 و 25');
    expect(toPersianDigits('256GB')).toBe('۲۵۶GB');
  });

  it('matches a search term in every digit script', () => {
    expect(searchTermVariants('آیفون ۱۵')).toEqual(['آیفون ۱۵', 'آیفون 15']);
    expect(searchTermVariants('X1 256')).toEqual(['X1 256', 'X۱ ۲۵۶']);
    expect(searchTermVariants('گوشي')).toEqual(['گوشی']);
    expect(searchTermVariants('   ')).toEqual([]);
  });

  it('escapes LIKE wildcards so input is matched literally', () => {
    expect(escapeLikePattern('100%_off\\')).toBe('100\\%\\_off\\\\');
  });

  it('slugifies Persian and Latin titles into URL-safe slugs', () => {
    expect(slugify('گوشی موبایل سامسونگ Galaxy A55 – ۲۵۶ گیگ')).toBe('گوشی-موبایل-سامسونگ-galaxy-a55-256-گیگ');
    expect(slugify('تی‌شرت نخی')).toBe('تی-شرت-نخی');
    expect(slugify('!!!')).toBe('');
    expect(PRODUCT_SLUG_PATTERN.test(slugify('کفش ورزشی Nike'))).toBe(true);
  });

  it('caps long slugs on a word boundary', () => {
    const slug = slugify(`${'کلمه '.repeat(80)}پایان`);
    expect(slug.length).toBeLessThanOrEqual(200);
    expect(slug.endsWith('-')).toBe(false);
    expect(PRODUCT_SLUG_PATTERN.test(slug)).toBe(true);
  });

  it('rejects slugs with upper case, spaces or doubled hyphens', () => {
    expect(PRODUCT_SLUG_PATTERN.test('Samsung-a55')).toBe(false);
    expect(PRODUCT_SLUG_PATTERN.test('a--b')).toBe(false);
    expect(PRODUCT_SLUG_PATTERN.test('گوشی موبایل')).toBe(false);
  });
});

describe('product rules', () => {
  it('normalises and validates SKUs', () => {
    expect(normalizeSku('  shp-x1-blk ')).toBe('SHP-X1-BLK');
    expect(SKU_PATTERN.test('SHP-X1.256_BLK')).toBe(true);
    expect(SKU_PATTERN.test('-LEADING')).toBe(false);
    expect(SKU_PATTERN.test('HAS SPACE')).toBe(false);
    expect(SKU_PATTERN.test('A'.repeat(65))).toBe(false);
  });

  it('computes the discount percent from compareAtPrice, rounded down', () => {
    expect(discountPercent('42500000', '45000000')).toBe(5); // 5.55… → 5
    expect(discountPercent(890000, 1150000)).toBe(22); // 22.6… → 22
    expect(discountPercent(100, null)).toBeNull();
    expect(discountPercent(100, 100)).toBeNull();
    expect(discountPercent(100, 90)).toBeNull();
  });

  it('converts numbers to two-decimal money without float noise', () => {
    expect(toMoney(0.1 + 0.2).toFixed(2)).toBe('0.30');
    expect(toMoney(42500000).toFixed(2)).toBe('42500000.00');
  });

  it('rejects compareAtPrice that is not strictly greater than price', () => {
    expect(variantFieldProblems({ sku: 'A', price: 100, compareAtPrice: 100 })).toEqual([
      'A: compareAtPrice (100.00) must be greater than price (100.00)',
    ]);
    expect(variantFieldProblems({ sku: 'A', price: 100, compareAtPrice: 99 })).toHaveLength(1);
    expect(variantFieldProblems({ sku: 'A', price: 100, compareAtPrice: 120 })).toEqual([]);
    expect(variantFieldProblems({ sku: 'A', price: 100, compareAtPrice: null })).toEqual([]);
  });

  it('rejects a non-positive price and a colour code without a colour name', () => {
    expect(variantFieldProblems({ sku: 'A', price: 0 })).toEqual(['A: price must be greater than 0']);
    expect(variantFieldProblems({ sku: 'A', price: 10, colorHex: '#000000' })).toEqual(['A: colorHex requires colorName']);
  });

  it('treats colour/size/guarantee cells case- and keyboard-insensitively', () => {
    expect(variantMatrixKey({ colorName: 'مشكي', size: 'xl' })).toBe(variantMatrixKey({ colorName: 'مشکی', size: 'XL' }));
    expect(variantMatrixKey({ colorName: 'مشکی', size: 'L' })).not.toBe(variantMatrixKey({ colorName: 'مشکی', size: 'XL' }));
  });

  it('reports duplicate SKUs and duplicate matrix cells in one request', () => {
    const problems = matrixProblems([
      { sku: 'A', colorName: 'سفید', size: 'L', price: 10 },
      { sku: 'A', colorName: 'سفید', size: 'XL', price: 10 },
      { sku: 'B', colorName: 'سفيد', size: 'l', price: 10 },
    ]);
    expect(problems).toEqual([
      'Duplicate SKU in request: A',
      'Two variants share the same colour/size/guarantee: سفید / l / —',
    ]);
  });

  it('lists repeated values once, in first-seen order', () => {
    expect(duplicates(['a', 'b', 'a', 'c', 'b', 'a'])).toEqual(['a', 'b']);
    expect(duplicates([])).toEqual([]);
  });
});

describe('normalizeSpecifications', () => {
  it('normalises text, keeps line breaks, numbers the order and drops blanks and exact duplicates', () => {
    expect(
      normalizeSpecifications([
        { groupTitle: ' مشخصات  كلی ', title: 'وزن', value: '188  گرم' },
        { groupTitle: null, title: 'سایر توضیحات', value: 'خط اول\r\n\r\n  خط دوم  \r\n' },
        { title: 'رنگ', value: '   ' },
        { title: '  ', value: 'x' },
        { groupTitle: 'مشخصات کلی', title: 'وزن', value: '188 گرم' },
        { groupTitle: 'مشخصات کلی', title: 'وزن', value: '190 گرم' },
      ]),
    ).toEqual([
      { groupTitle: 'مشخصات کلی', title: 'وزن', value: '188 گرم', sortOrder: 10 },
      { groupTitle: null, title: 'سایر توضیحات', value: 'خط اول\nخط دوم', sortOrder: 20 },
      { groupTitle: 'مشخصات کلی', title: 'وزن', value: '190 گرم', sortOrder: 30 },
    ]);
  });
});
