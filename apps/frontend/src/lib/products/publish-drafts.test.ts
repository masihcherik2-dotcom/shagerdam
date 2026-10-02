import { describe, expect, it } from 'vitest';

import { draftsLeftBehind, publishResultMessage } from './publish-drafts';

describe('draftsLeftBehind', () => {
  it('explains every reason a draft stays unpublished', () => {
    expect(draftsLeftBehind({ publishable: 5, blocked: 2, noActiveVariant: 3, storeNotApproved: 1 })).toEqual([
      '۳ محصول هیچ تنوع فعالی ندارد؛ ابتدا یک تنوع را فعال کنید.',
      '۲ محصول توسط مدیریت مسدود است و منتشر نمی‌شود.',
      '۱ محصول متعلق به فروشگاه‌های تأییدنشده یا تعلیق‌شده است.',
    ]);
    expect(draftsLeftBehind({ publishable: 5, blocked: 0, noActiveVariant: 0, storeNotApproved: 0 })).toEqual([]);
  });
});

describe('publishResultMessage', () => {
  it('reports what was published and what was left behind', () => {
    expect(publishResultMessage({ published: 12, remaining: { publishable: 0, blocked: 0, noActiveVariant: 0, storeNotApproved: 0 } })).toBe('۱۲ محصول منتشر شد.');
    expect(publishResultMessage({ published: 4, remaining: { publishable: 0, blocked: 1, noActiveVariant: 2, storeNotApproved: 0 } })).toBe(
      '۴ محصول منتشر شد. ۳ پیش‌نویس به‌دلیل نقص یا مسدودی منتشر نشد.',
    );
    expect(publishResultMessage({ published: 0, remaining: { publishable: 0, blocked: 0, noActiveVariant: 0, storeNotApproved: 0 } })).toBe('محصولی برای انتشار نبود.');
  });
});
