import { isValidNationalCode, normalizeNationalCode } from './iranian-national-code';

/**
 * The official algorithm is `check = f(Σ digit[i] × (10 - i))`. These cases pin
 * the implementation to known-valid codes and to the failure modes that matter:
 * a wrong check digit, the wrong length, and the all-identical codes the civil
 * registry never issues.
 */
describe('isValidNationalCode', () => {
  it('accepts codes with a correct check digit', () => {
    expect(isValidNationalCode('0499370899')).toBe(true);
    expect(isValidNationalCode('0084575948')).toBe(true);
    expect(isValidNationalCode('0938663488')).toBe(true);
  });

  it('accepts Persian and Arabic-Indic digits', () => {
    expect(isValidNationalCode('۰۴۹۹۳۷۰۸۹۹')).toBe(true);
    expect(isValidNationalCode('٠٤٩٩٣٧٠٨٩٩')).toBe(true);
  });

  it('tolerates separators', () => {
    expect(isValidNationalCode('049-937-0899')).toBe(true);
    expect(isValidNationalCode(' 0499370899 ')).toBe(true);
  });

  it('rejects a wrong check digit', () => {
    expect(isValidNationalCode('0499370898')).toBe(false);
    expect(isValidNationalCode('0938663480')).toBe(false); // checksum of 0938663488
    expect(isValidNationalCode('0499370890')).toBe(false);
  });

  it('rejects the wrong shape', () => {
    for (const value of ['', '04993708', '04993708991', 'abcdefghij', '04993708aa']) {
      expect(isValidNationalCode(value)).toBe(false);
    }
  });

  it('rejects codes made of one repeated digit', () => {
    for (const value of ['0000000000', '1111111111', '9999999999']) {
      expect(isValidNationalCode(value)).toBe(false);
    }
  });
});

describe('normalizeNationalCode', () => {
  it('strips separators and converts digits without validating', () => {
    expect(normalizeNationalCode(' 049-937-0899 ')).toBe('0499370899');
    expect(normalizeNationalCode('۰۴۹۹۳۷۰۸۹۹')).toBe('0499370899');
  });
});
