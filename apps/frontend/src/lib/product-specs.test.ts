import { describe, expect, it } from 'vitest';

import type { ImportedProductDraft } from './api/types';
import {
  MAX_SPECIFICATIONS_PER_PRODUCT,
  draftSpecRows,
  emptySpecRow,
  groupSpecifications,
  imageFailureMessage,
  importStrategyLabels,
  ingestedToUploaded,
  specRowsFrom,
  specRowsToInput,
} from './product-specs';

const row = (groupTitle: string, title: string, value: string) => ({ ...emptySpecRow(), groupTitle, title, value });

describe('specRowsToInput', () => {
  it('trims, maps empty groups to null, normalises line breaks and drops untouched rows', () => {
    const result = specRowsToInput([row(' دوربین ', ' رزولوشن ', ' 200 مگاپیکسل '), emptySpecRow(), row('', 'سایر', 'خط ۱\r\nخط ۲')]);
    expect(result).toEqual({
      ok: true,
      value: [
        { groupTitle: 'دوربین', title: 'رزولوشن', value: '200 مگاپیکسل' },
        { groupTitle: null, title: 'سایر', value: 'خط ۱\nخط ۲' },
      ],
    });
  });

  it('rejects half-filled rows instead of dropping them', () => {
    expect(specRowsToInput([row('', 'وزن', '  ')])).toEqual({ ok: false, error: 'ردیف 1 مشخصات: مقدار «وزن» خالی است.' });
    expect(specRowsToInput([row('کلی', '', '5')])).toMatchObject({ ok: false });
  });

  it('enforces the backend length and count limits', () => {
    expect(specRowsToInput([row('', 'x'.repeat(151), '1')])).toMatchObject({ ok: false });
    expect(specRowsToInput([row('', 'x', 'v'.repeat(2001))])).toMatchObject({ ok: false });
    const many = Array.from({ length: MAX_SPECIFICATIONS_PER_PRODUCT + 1 }, (_, i) => row('', `t${i}`, 'v'));
    expect(specRowsToInput(many)).toMatchObject({ ok: false });
  });
});

describe('groupSpecifications', () => {
  it('groups consecutive rows by group title, keeping order', () => {
    const groups = groupSpecifications([
      { groupTitle: 'دوربین', title: 'a', value: '1' },
      { groupTitle: 'دوربین', title: 'b', value: '2' },
      { groupTitle: null, title: 'c', value: '3' },
      { groupTitle: 'دوربین', title: 'd', value: '4' },
    ]);
    expect(groups.map((group) => [group.groupTitle, group.items.map((item) => item.title)])).toEqual([
      ['دوربین', ['a', 'b']],
      [null, ['c']],
      ['دوربین', ['d']],
    ]);
  });
});

describe('import helpers', () => {
  const draft: ImportedProductDraft = {
    source: 'DIGIKALA',
    strategies: ['DIGIKALA_API'],
    sourceUrl: 'https://www.digikala.com/product/dkp-1/',
    sourceProductId: 'dkp-1',
    title: 't',
    titleEn: null,
    brand: null,
    description: null,
    suggestedCategory: null,
    suggestedCategoryId: null,
    specifications: [
      { group: 'مشخصات', title: 'جنس', value: 'پلی کربنات' },
      { group: null, title: 'وزن', value: '5 گرم' },
    ],
    imageUrls: [],
  };

  it('turns draft specifications into editable rows', () => {
    expect(draftSpecRows(draft).map(({ groupTitle, title, value }) => ({ groupTitle, title, value }))).toEqual([
      { groupTitle: 'مشخصات', title: 'جنس', value: 'پلی کربنات' },
      { groupTitle: '', title: 'وزن', value: '5 گرم' },
    ]);
  });

  it('gives each row a unique key', () => {
    const keys = specRowsFrom([{ groupTitle: null, title: 'a', value: '1' }, { groupTitle: null, title: 'b', value: '2' }]).map((r) => r.key);
    expect(new Set(keys).size).toBe(2);
  });

  it('maps an ingested image to a gallery entry named after the source file', () => {
    expect(
      ingestedToUploaded({
        sourceUrl: 'https://dkstatics-public.digikala.com/digikala-products/abc_1.jpg',
        id: 'id-1',
        url: '/media/images/x.webp',
        thumbnailUrl: '/media/images/x_thumb.webp',
        width: 800,
        height: 800,
        sizeBytes: 1000,
      }),
    ).toEqual({ id: 'id-1', url: '/media/images/x.webp', thumbnailUrl: '/media/images/x_thumb.webp', name: 'abc_1.jpg' });
  });

  it('labels strategies and image failures in Persian', () => {
    expect(importStrategyLabels(draft)).toEqual(['API دیجی‌کالا']);
    expect(imageFailureMessage('INVALID_IMAGE')).toContain('معتبر نیست');
    expect(imageFailureMessage('SOMETHING_NEW')).toBe('تصویر دریافت نشد.');
  });
});
