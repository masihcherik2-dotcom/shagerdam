import { GoogleIdTokenError, parseGoogleIdToken } from './google-id-token';

const CLIENT_ID = '1234-abc.apps.googleusercontent.com';
const NOW = 1_800_000_000;

function token(claims: Record<string, unknown>): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'RS256', kid: 'k1' })}.${encode(claims)}.c2lnbmF0dXJl`;
}

const VALID = {
  iss: 'https://accounts.google.com',
  aud: CLIENT_ID,
  azp: CLIENT_ID,
  sub: '110169484474386276334',
  email: 'Sara.Ahmadi@Gmail.com',
  email_verified: true,
  name: '  سارا   احمدی ',
  picture: 'https://lh3.googleusercontent.com/a/photo',
  nonce: 'n-0S6_WzA2Mj',
  iat: NOW - 10,
  exp: NOW + 3590,
};
const EXPECT = { clientId: CLIENT_ID, issuers: ['https://accounts.google.com', 'accounts.google.com'], nonce: 'n-0S6_WzA2Mj', nowSeconds: NOW };

function reason(claims: Record<string, unknown> | string): string {
  try {
    parseGoogleIdToken(typeof claims === 'string' ? claims : token(claims), EXPECT);
  } catch (error) {
    if (error instanceof GoogleIdTokenError) return error.reason;
    throw error;
  }
  return 'accepted';
}

describe('parseGoogleIdToken', () => {
  it('extracts a normalised profile from valid claims', () => {
    expect(parseGoogleIdToken(token(VALID), EXPECT)).toEqual({
      subject: '110169484474386276334',
      email: 'sara.ahmadi@gmail.com',
      emailVerified: true,
      name: 'سارا احمدی',
      picture: 'https://lh3.googleusercontent.com/a/photo',
    });
    expect(parseGoogleIdToken(token({ ...VALID, iss: 'accounts.google.com', email_verified: 'true' }), EXPECT).emailVerified).toBe(true);
  });

  it('rejects the wrong issuer, audience, expiry, issue time, nonce and subject', () => {
    expect(reason({ ...VALID, iss: 'https://evil.example' })).toBe('issuer');
    expect(reason({ ...VALID, aud: 'other.apps.googleusercontent.com' })).toBe('audience');
    expect(reason({ ...VALID, aud: [CLIENT_ID, 'other'], azp: 'other' })).toBe('authorized party');
    expect(reason({ ...VALID, aud: [CLIENT_ID, 'other'] })).toBe('accepted');
    expect(reason({ ...VALID, exp: NOW - 301 })).toBe('expired');
    expect(reason({ ...VALID, exp: NOW - 100 })).toBe('accepted'); // within the clock skew
    expect(reason({ ...VALID, iat: NOW + 301 })).toBe('issued in the future');
    expect(reason({ ...VALID, nonce: 'replayed' })).toBe('nonce');
    expect(reason({ ...VALID, nonce: undefined })).toBe('nonce');
    expect(reason({ ...VALID, sub: '' })).toBe('subject');
    expect(reason({ ...VALID, sub: 42 })).toBe('subject');
  });

  it('rejects malformed tokens', () => {
    expect(reason('')).toBe('malformed');
    expect(reason('a.b')).toBe('malformed');
    expect(reason('a.%%%.c')).toBe('malformed');
    expect(reason(`x.${Buffer.from('[1,2]').toString('base64url')}.y`)).toBe('malformed');
    expect(reason(`x.${'a'.repeat(20_000)}.y`)).toBe('malformed');
  });

  it('treats an unverified or missing e-mail as unverified and drops unsafe name/picture values', () => {
    expect(parseGoogleIdToken(token({ ...VALID, email_verified: false }), EXPECT)).toMatchObject({ email: 'sara.ahmadi@gmail.com', emailVerified: false });
    expect(parseGoogleIdToken(token({ ...VALID, email: undefined }), EXPECT)).toMatchObject({ email: null, emailVerified: false });
    expect(parseGoogleIdToken(token({ ...VALID, email: 'not an email' }), EXPECT)).toMatchObject({ email: null, emailVerified: false });
    const profile = parseGoogleIdToken(token({ ...VALID, name: '<b>x</b>', picture: 'http://insecure.example/p.jpg' }), EXPECT);
    expect(profile.name).toBe('b x /b');
    expect(profile.picture).toBeNull();
    expect(parseGoogleIdToken(token({ ...VALID, name: 'a' }), EXPECT).name).toBeNull();
    expect(parseGoogleIdToken(token({ ...VALID, name: 'x'.repeat(300) }), EXPECT).name).toHaveLength(120);
  });
});
