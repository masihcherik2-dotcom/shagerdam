import { describe, expect, it } from 'vitest';

import { IRAN_MOBILE_PATTERN, IRAN_PROVINCES, POSTAL_CODE_PATTERN, isValidNationalCode, isValidSheba } from './iran';

describe('iran reference data & validators', () => {
  it('lists the 31 provinces', () => {
    expect(IRAN_PROVINCES).toHaveLength(31);
    expect(new Set(IRAN_PROVINCES).size).toBe(31);
  });

  it('validates postal codes and mobiles like the backend', () => {
    expect(POSTAL_CODE_PATTERN.test('1968913111')).toBe(true);
    expect(POSTAL_CODE_PATTERN.test('0968913111')).toBe(false);
    expect(POSTAL_CODE_PATTERN.test('196891311')).toBe(false);
    for (const mobile of ['09121234567', '+989121234567', '9121234567', '00989121234567']) {
      expect(IRAN_MOBILE_PATTERN.test(mobile)).toBe(true);
    }
    expect(IRAN_MOBILE_PATTERN.test('0812345678')).toBe(false);
  });

  it('checks national-code checksums', () => {
    expect(isValidNationalCode('0499370899')).toBe(true);
    expect(isValidNationalCode('0499370898')).toBe(false);
    expect(isValidNationalCode('1111111111')).toBe(false);
  });

  it('checks Sheba mod-97', () => {
    expect(isValidSheba('IR820540102680020817909002')).toBe(true);
    expect(isValidSheba('IR620540102680020817909001')).toBe(false);
    expect(isValidSheba('IR82054010268002081790900')).toBe(false);
  });
});
