import { describe, expect, it } from 'vitest';

import { messageForCode } from '../api/error-messages';
import { GOOGLE_LOGIN_ERRORS, backendGoogleError, bindingPath, loginErrorPath, packStateCookie, providerError, siteUrl, statesMatch, toGoogleLoginError, unpackStateCookie } from './google-session';

describe('Google sign-in session helpers', () => {
  it('has a Persian message for every error the login page can show', () => {
    expect(GOOGLE_LOGIN_ERRORS.filter((code) => messageForCode(code) === undefined)).toEqual([]);
    expect(toGoogleLoginError('GOOGLE_STAFF_NOT_ALLOWED')).toBe('GOOGLE_STAFF_NOT_ALLOWED');
    expect(toGoogleLoginError('<script>')).toBe('GOOGLE_FAILED');
    expect(toGoogleLoginError(undefined)).toBe('GOOGLE_FAILED');
  });

  it('builds the failure and binding paths, keeping only a same-site next', () => {
    expect(loginErrorPath('GOOGLE_CANCELLED', '/cart')).toBe('/login?google=GOOGLE_CANCELLED&next=%2Fcart');
    expect(loginErrorPath('GOOGLE_FAILED', 'https://evil.example')).toBe('/login?google=GOOGLE_FAILED');
    expect(bindingPath('/checkout?step=2')).toBe('/login/google?next=%2Fcheckout%3Fstep%3D2');
    expect(bindingPath('//evil.example')).toBe('/login/google');
    expect(bindingPath(null)).toBe('/login/google');
  });

  it('maps backend and provider failures to codes', () => {
    expect(backendGoogleError(503, { code: 'GOOGLE_NOT_CONFIGURED' })).toBe('GOOGLE_NOT_CONFIGURED');
    expect(backendGoogleError(429, { code: 'ANYTHING' })).toBe('GOOGLE_RATE_LIMITED');
    expect(backendGoogleError(500, null)).toBe('GOOGLE_FAILED');
    expect(providerError('access_denied')).toBe('GOOGLE_CANCELLED');
    expect(providerError('server_error')).toBe('GOOGLE_FAILED');
  });

  it('compares the state cookie with the returned state exactly', () => {
    expect(statesMatch('abc123', 'abc123')).toBe(true);
    expect(statesMatch('abc123', 'abc124')).toBe(false);
    expect(statesMatch('abc123', 'abc1234')).toBe(false);
    expect(statesMatch(undefined, 'abc')).toBe(false);
    expect(statesMatch('abc', null)).toBe(false);
    expect(statesMatch('', '')).toBe(false);
  });

  it('keeps a safe next beside the state so a cancelled sign-in returns to it', () => {
    const packed = packStateCookie('AbC-_123', '/products/x?ref=1');
    expect(packed.startsWith('AbC-_123.')).toBe(true);
    expect(unpackStateCookie(packed)).toEqual({ state: 'AbC-_123', next: '/products/x?ref=1' });
    expect(packStateCookie('s1', '//evil.example')).toBe('s1');
    expect(unpackStateCookie('s1')).toEqual({ state: 's1', next: null });
    expect(unpackStateCookie(`s1.${Buffer.from('https://evil.example').toString('base64url')}`)).toEqual({ state: 's1', next: null });
    expect(unpackStateCookie(undefined)).toEqual({ state: undefined, next: null });
  });

  it('builds redirects on the public origin, never on the bind address', () => {
    expect(siteUrl('/login/google?next=%2Fcart', 'https://shagerdam.example').toString()).toBe('https://shagerdam.example/login/google?next=%2Fcart');
  });
});
