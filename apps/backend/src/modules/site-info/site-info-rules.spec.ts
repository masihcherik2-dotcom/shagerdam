import { changedFields, EMPTY_SITE_INFO, fieldProblem, normalizeField, SITE_INFO_KEYS, toPublicSiteInfo, valuesFromRows } from './site-info-rules';

describe('site info rules', () => {
  it('normalises Persian digits and spaces in numeric fields', () => {
    expect(normalizeField('supportPhone', ' ۰۲۱-۹۱۰۰۰۰۰۰ ')).toBe('021-91000000');
    expect(normalizeField('nationalId', '۱۰۱ ۰۱۲۳ ۴۵۶۷')).toBe('10101234567');
    expect(normalizeField('supportEmail', ' Support@Shagerdam.IR ')).toBe('support@shagerdam.ir');
    expect(normalizeField('officeAddress', 'تهران،   خیابان  ولیعصر')).toBe('تهران، خیابان ولیعصر');
  });

  it.each([
    ['nationalId', '10101234567', true],
    ['nationalId', '1010123456', false],
    ['nationalId', '1010123456a', false],
    ['postalCode', '1234567890', true],
    ['postalCode', '12345', false],
    ['postalCode', '0123456789', false],
    ['registrationNumber', '123456', true],
    ['registrationNumber', '12-34', false],
    ['supportPhone', '021-91000000', true],
    ['supportPhone', '09121234567', true],
    ['supportPhone', '+98 21 9100', false],
    ['supportEmail', 'support@shagerdam.ir', true],
    ['supportEmail', 'support@', false],
    ['officeAddress', 'تهران <script>', false],
    ['legalName', 'شرکت نمونه\u0000', false],
  ] as const)('%s = %j valid: %s', (field, value, valid) => {
    expect(fieldProblem(field, value) === null).toBe(valid);
  });

  it('accepts only the seal URLs issued by enamad.ir and samandehi.ir', () => {
    expect(fieldProblem('enamadLinkUrl', 'https://trustseal.enamad.ir/?id=123456&Code=AbCdEf')).toBeNull();
    expect(fieldProblem('enamadImageUrl', 'https://trustseal.enamad.ir/logo.aspx?id=123456&Code=AbCdEf')).toBeNull();
    expect(fieldProblem('samandehiLinkUrl', 'https://logo.samandehi.ir/Verify.aspx?id=123&p=abc')).toBeNull();
    expect(fieldProblem('samandehiImageUrl', 'https://logo.samandehi.ir/logo.aspx?id=123&p=xyz')).toBeNull();

    expect(fieldProblem('enamadLinkUrl', 'http://trustseal.enamad.ir/?id=1&Code=a')).not.toBeNull();
    expect(fieldProblem('enamadImageUrl', 'https://trustseal.enamad.ir.evil.com/logo.aspx?id=1')).not.toBeNull();
    expect(fieldProblem('enamadImageUrl', 'https://evil.com/logo.aspx?id=1')).not.toBeNull();
    expect(fieldProblem('enamadImageUrl', 'https://trustseal.enamad.ir/logo.aspx')).not.toBeNull();
    expect(fieldProblem('samandehiImageUrl', 'https://user@logo.samandehi.ir/logo.aspx?id=1')).not.toBeNull();
    expect(fieldProblem('samandehiLinkUrl', 'javascript:alert(1)')).not.toBeNull();
  });

  it('reads rows, treating empty and invalid values as not set', () => {
    const invalid: string[] = [];
    const values = valuesFromRows(
      [
        { key: SITE_INFO_KEYS.supportPhone, value: '021-91000000' },
        { key: SITE_INFO_KEYS.supportEmail, value: '' },
        { key: SITE_INFO_KEYS.nationalId, value: 'not-a-number' },
        { key: 'unrelated.key', value: 'x' },
      ],
      (reason) => invalid.push(reason),
    );
    expect(values).toEqual({ ...EMPTY_SITE_INFO, supportPhone: '021-91000000' });
    expect(invalid).toHaveLength(1);
  });

  it('publishes a trust seal only as a complete pair', () => {
    const partial = { ...EMPTY_SITE_INFO, enamadLinkUrl: 'https://trustseal.enamad.ir/?id=1&Code=a', samandehiLinkUrl: 'https://logo.samandehi.ir/Verify.aspx?id=1&p=a', samandehiImageUrl: 'https://logo.samandehi.ir/logo.aspx?id=1&p=b' };
    const published = toPublicSiteInfo(partial);
    expect(published.enamadLinkUrl).toBeNull();
    expect(published.samandehiLinkUrl).toBe(partial.samandehiLinkUrl);
    expect(published.samandehiImageUrl).toBe(partial.samandehiImageUrl);
  });

  it('lists changed fields', () => {
    expect(changedFields(EMPTY_SITE_INFO, { ...EMPTY_SITE_INFO, legalName: 'x', postalCode: '1234567890' })).toEqual(['legalName', 'postalCode']);
    expect(changedFields(EMPTY_SITE_INFO, EMPTY_SITE_INFO)).toEqual([]);
  });
});
