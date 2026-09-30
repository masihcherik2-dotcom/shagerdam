import { describe, expect, it } from 'vitest';

import { localizeErrorMessage } from './error-messages';

describe('localizeErrorMessage', () => {
  it('translates known business codes', () => {
    expect(localizeErrorMessage(409, 'IBAN_MISMATCH', 'Target IBAN differs', {})).toBe('شبای مقصد باید همان شبای ثبت‌شده در پروفایل فروشگاه باشد.');
  });

  it('formats money details in Toman', () => {
    expect(localizeErrorMessage(400, 'AMOUNT_BELOW_MINIMUM', 'The minimum settlement amount is 1000000.00 IRR', { minimumAmount: '1000000.00' })).toBe('حداقل مبلغ تسویه ۱۰۰٬۰۰۰ تومان است.');
  });

  it('keeps Persian backend messages', () => {
    expect(localizeErrorMessage(400, undefined, 'ایمیل معتبر نیست', {})).toBe('ایمیل معتبر نیست');
  });

  it('keeps English validation details next to a Persian sentence', () => {
    expect(localizeErrorMessage(400, undefined, 'trackingCode must be longer than 4', {})).toBe('اطلاعات ارسالی معتبر نیست. (trackingCode must be longer than 4)');
  });

  it('replaces other English messages with a status text', () => {
    expect(localizeErrorMessage(403, undefined, 'Forbidden resource', {})).toBe('اجازهٔ انجام این کار را ندارید.');
    expect(localizeErrorMessage(418, undefined, undefined, {})).toBe('درخواست با خطای 418 رد شد.');
  });
});
