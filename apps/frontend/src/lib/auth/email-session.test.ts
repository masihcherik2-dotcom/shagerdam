import { describe, expect, it } from 'vitest';

import { isSignupTicket, readEmailVerify } from './email-session';

const TOKENS = {
  accessToken: 'a.b.c',
  refreshToken: 'r',
  tokenType: 'Bearer',
  expiresIn: 900,
  refreshExpiresIn: 2592000,
  user: { id: 'u1', mobile: '+989120000001', email: 'sara@gmail.com', fullName: 'سارا', role: 'CUSTOMER', isActive: true },
};
const TICKET = 'A'.repeat(43);

describe('readEmailVerify', () => {
  it('recognises a direct sign-in', () => {
    const outcome = readEmailVerify({ status: 'signed_in', tokens: TOKENS });
    expect(outcome.kind).toBe('signed_in');
  });

  it('recognises the mobile step and keeps the ticket for the cookie', () => {
    expect(readEmailVerify({ status: 'mobile_required', ticket: TICKET, email: 'sara@gmail.com', expiresInSeconds: 900 })).toEqual({
      kind: 'mobile_required',
      ticket: TICKET,
      email: 'sara@gmail.com',
      expiresInSeconds: 900,
    });
  });

  it('refuses anything malformed', () => {
    expect(readEmailVerify(null).kind).toBe('invalid');
    expect(readEmailVerify({ status: 'signed_in' }).kind).toBe('invalid');
    expect(readEmailVerify({ status: 'mobile_required', ticket: 'short', email: 'a@b.ir', expiresInSeconds: 900 }).kind).toBe('invalid');
    expect(readEmailVerify({ status: 'mobile_required', ticket: TICKET, email: 'a@b.ir', expiresInSeconds: 0 }).kind).toBe('invalid');
    expect(readEmailVerify({ status: 'mobile_required', ticket: TICKET, expiresInSeconds: 900 }).kind).toBe('invalid');
  });
});

describe('isSignupTicket', () => {
  it('accepts base64url tickets only', () => {
    expect(isSignupTicket(TICKET)).toBe(true);
    expect(isSignupTicket(`${'a'.repeat(40)}/..`)).toBe(false);
    expect(isSignupTicket('a\r\nX-Injected: 1'.padEnd(40, 'a'))).toBe(false);
    expect(isSignupTicket(undefined)).toBe(false);
  });
});
