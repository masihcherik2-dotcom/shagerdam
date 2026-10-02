import { timingSafeEqual } from 'node:crypto';

/** The identity facts Shagerdam keeps from a Google ID token. */
export interface GoogleProfile {
  /** OpenID Connect `sub`: stable and never reused by Google. */
  subject: string;
  /** Lower-cased e-mail, or null when Google did not send one. */
  email: string | null;
  /** Google vouches that the user controls {@link email}. */
  emailVerified: boolean;
  name: string | null;
  /** https URL of the profile picture, or null. */
  picture: string | null;
}

export interface IdTokenExpectations {
  clientId: string;
  issuers: readonly string[];
  nonce: string;
  nowSeconds: number;
  /** Tolerated clock difference, seconds. */
  clockSkewSeconds?: number;
}

export class GoogleIdTokenError extends Error {
  constructor(readonly reason: string) {
    super(`Google ID token rejected: ${reason}`);
    this.name = 'GoogleIdTokenError';
  }
}

const MAX_TOKEN_LENGTH = 16_384;

/**
 * Validates the claims of an ID token and extracts the profile.
 *
 * The token handed to this function MUST come straight from Google's token
 * endpoint over TLS in exchange for an authorization code (see
 * `GoogleOAuthClient.exchangeCode`). In that case OpenID Connect Core 1.0
 * §3.1.3.7 (step 6) allows the TLS server validation of the token endpoint to
 * replace the signature check — the browser never sees or forwards the token,
 * so it cannot be substituted. Never use this for an ID token received from a
 * client.
 *
 * Checked: issuer, audience (and `azp` with several audiences), expiry, issue
 * time, the nonce bound to this sign-in attempt, and the subject.
 */
export function parseGoogleIdToken(idToken: string, expected: IdTokenExpectations): GoogleProfile {
  if (typeof idToken !== 'string' || idToken.length === 0 || idToken.length > MAX_TOKEN_LENGTH) {
    throw new GoogleIdTokenError('malformed');
  }
  const parts = idToken.split('.');
  if (parts.length !== 3 || parts[1] === undefined || parts[1].length === 0) {
    throw new GoogleIdTokenError('malformed');
  }
  let claims: Record<string, unknown>;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) throw new Error('not an object');
    claims = decoded as Record<string, unknown>;
  } catch {
    throw new GoogleIdTokenError('malformed');
  }

  const skew = expected.clockSkewSeconds ?? 300;
  if (typeof claims.iss !== 'string' || !expected.issuers.includes(claims.iss)) {
    throw new GoogleIdTokenError('issuer');
  }
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(expected.clientId)) {
    throw new GoogleIdTokenError('audience');
  }
  if (audiences.length > 1 && claims.azp !== expected.clientId) {
    throw new GoogleIdTokenError('authorized party');
  }
  if (typeof claims.exp !== 'number' || claims.exp + skew <= expected.nowSeconds) {
    throw new GoogleIdTokenError('expired');
  }
  if (typeof claims.iat !== 'number' || claims.iat - skew > expected.nowSeconds) {
    throw new GoogleIdTokenError('issued in the future');
  }
  if (typeof claims.nonce !== 'string' || !constantTimeEquals(claims.nonce, expected.nonce)) {
    throw new GoogleIdTokenError('nonce');
  }
  if (typeof claims.sub !== 'string' || !/^[\x21-\x7e]{1,255}$/.test(claims.sub)) {
    throw new GoogleIdTokenError('subject');
  }

  const email = typeof claims.email === 'string' && /^[^\s@]{1,64}@[^\s@]{1,189}$/.test(claims.email.trim()) ? claims.email.trim().toLowerCase() : null;
  const emailVerified = email !== null && (claims.email_verified === true || claims.email_verified === 'true');
  return {
    subject: claims.sub,
    email,
    emailVerified,
    name: cleanName(claims.name),
    picture: cleanPicture(claims.picture),
  };
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Display name: control characters removed, whitespace collapsed, ≤ 120 chars (the column size). */
function cleanName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120).trim();
  return cleaned.length >= 2 ? cleaned : null;
}

function cleanPicture(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}
