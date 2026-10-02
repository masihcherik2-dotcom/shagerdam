/**
 * Session primitives shared by the middleware (Edge runtime), the BFF route
 * handlers and Server Components. No Node-only APIs here.
 *
 * Tokens never reach browser JavaScript: the BFF stores them in httpOnly
 * cookies and attaches `Authorization: Bearer …` server-side.
 */
import type { AuthTokens, UserRole } from '../api/types';

export const ACCESS_COOKIE = 'shopino_at';
export const REFRESH_COOKIE = 'shopino_rt';
/** Guest cart token (backend header X-Cart-Token), also httpOnly. */
export const CART_COOKIE = 'shopino_cart';
export const CART_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/** Refresh a little before expiry so an in-flight request never carries a dying token. */
const EXPIRY_SKEW_SECONDS = 20;

export interface AccessClaims {
  sub: string;
  role: UserRole;
  exp: number;
}

function base64UrlDecode(segment: string): string {
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(segment.length / 4) * 4, '=');
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * Reads the claims of an access token WITHOUT verifying its signature.
 *
 * Used only for routing decisions (which dashboard to show, whether to
 * refresh). Authorisation is always enforced by the backend, which verifies
 * the signature and re-reads the user on every request — a forged cookie can
 * at most render an empty shell whose every API call answers 401/403.
 */
export function readAccessClaims(token: string | undefined | null): AccessClaims | null {
  if (!token) {
    return null;
  }
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) {
    return null;
  }
  try {
    const payload = JSON.parse(base64UrlDecode(parts[1])) as Partial<AccessClaims> & { typ?: string };
    if (typeof payload.sub !== 'string' || typeof payload.role !== 'string' || typeof payload.exp !== 'number') {
      return null;
    }
    if (payload.typ !== undefined && payload.typ !== 'access') {
      return null;
    }
    return { sub: payload.sub, role: payload.role as UserRole, exp: payload.exp };
  } catch {
    return null;
  }
}

export function isAccessTokenFresh(claims: AccessClaims | null, nowSeconds = Math.floor(Date.now() / 1000)): claims is AccessClaims {
  return claims !== null && claims.exp - EXPIRY_SKEW_SECONDS > nowSeconds;
}

export interface CookieSpec {
  name: string;
  value: string;
  options: {
    httpOnly: true;
    sameSite: 'lax';
    secure: boolean;
    path: string;
    maxAge: number;
  };
}

function spec(name: string, value: string, maxAge: number, secure: boolean, path = '/'): CookieSpec {
  return { name, value, options: { httpOnly: true, sameSite: 'lax', secure, path, maxAge } };
}

/**
 * Sign-in with Google keeps two short-lived values in httpOnly cookies scoped
 * to the BFF's Google routes: the one-time OAuth `state` (bound to this
 * browser — a callback with someone else's state is refused) and the ticket of
 * the mobile-binding step. Lax: the callback is a top-level GET from Google.
 */
export const GOOGLE_STATE_COOKIE = 'shopino_google_state';
export const GOOGLE_SIGNUP_COOKIE = 'shopino_google_signup';
const GOOGLE_COOKIE_PATH = '/api/session/google';

export function googleStateCookie(state: string, maxAge: number, secure: boolean): CookieSpec {
  return spec(GOOGLE_STATE_COOKIE, state, maxAge, secure, GOOGLE_COOKIE_PATH);
}

export function googleSignupCookie(ticket: string, maxAge: number, secure: boolean): CookieSpec {
  return spec(GOOGLE_SIGNUP_COOKIE, ticket, maxAge, secure, GOOGLE_COOKIE_PATH);
}

export function clearedGoogleCookies(secure: boolean): CookieSpec[] {
  return [spec(GOOGLE_STATE_COOKIE, '', 0, secure, GOOGLE_COOKIE_PATH), spec(GOOGLE_SIGNUP_COOKIE, '', 0, secure, GOOGLE_COOKIE_PATH)];
}

/** Cookies to write after a login or a refresh. */
export function sessionCookies(tokens: Pick<AuthTokens, 'accessToken' | 'refreshToken' | 'expiresIn' | 'refreshExpiresIn'>, secure: boolean): CookieSpec[] {
  return [spec(ACCESS_COOKIE, tokens.accessToken, tokens.expiresIn, secure), spec(REFRESH_COOKIE, tokens.refreshToken, tokens.refreshExpiresIn, secure)];
}

/** Cookies that end the session (maxAge 0). */
export function clearedSessionCookies(secure: boolean): CookieSpec[] {
  return [spec(ACCESS_COOKIE, '', 0, secure), spec(REFRESH_COOKIE, '', 0, secure)];
}

export function cartCookie(token: string, secure: boolean): CookieSpec {
  return spec(CART_COOKIE, token, CART_COOKIE_MAX_AGE_SECONDS, secure);
}

export function clearedCartCookie(secure: boolean): CookieSpec {
  return spec(CART_COOKIE, '', 0, secure);
}

/**
 * `Secure` is set whenever the browser reached us over HTTPS (directly or via
 * a TLS-terminating proxy), and always in production.
 */
export function shouldUseSecureCookies(headers: Headers, url: string): boolean {
  if (process.env.NODE_ENV === 'production') {
    return true;
  }
  const forwardedProto = headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  return forwardedProto === 'https' || url.startsWith('https:');
}

/** Backend origin as seen from the Next.js server. */
export function backendOrigin(): string {
  const value = process.env.BACKEND_INTERNAL_URL?.trim();
  if (!value) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('BACKEND_INTERNAL_URL must be set for production deployments.');
    }
    return 'http://127.0.0.1:4000';
  }
  return value.replace(/\/+$/, '');
}

export function backendApiUrl(path: string): string {
  return `${backendOrigin()}/api/v1/${path.replace(/^\/+/, '')}`;
}

export function isAuthTokens(value: unknown): value is AuthTokens {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<AuthTokens>;
  return (
    typeof candidate.accessToken === 'string' &&
    typeof candidate.refreshToken === 'string' &&
    typeof candidate.expiresIn === 'number' &&
    typeof candidate.refreshExpiresIn === 'number' &&
    typeof candidate.user === 'object'
  );
}

/**
 * Rotates the refresh token at the backend. Returns null when the session is
 * no longer valid (revoked, expired, reused) — the caller clears the cookies.
 */
export async function refreshAtBackend(refreshToken: string, forwarded: Headers): Promise<AuthTokens | null> {
  try {
    const response = await fetch(backendApiUrl('auth/refresh'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...forwardingHeaders(forwarded) },
      body: JSON.stringify({ refreshToken }),
      cache: 'no-store',
    });
    if (!response.ok) {
      return null;
    }
    const body: unknown = await response.json();
    return isAuthTokens(body) ? body : null;
  } catch {
    return null;
  }
}

/** Client identity headers the backend uses for rate limits and audit logs (trustProxy is on). */
export function forwardingHeaders(incoming: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  const forwardedFor = incoming.get('x-forwarded-for') ?? incoming.get('x-real-ip');
  if (forwardedFor) {
    result['X-Forwarded-For'] = forwardedFor;
  }
  const userAgent = incoming.get('user-agent');
  if (userAgent) {
    result['User-Agent'] = userAgent;
  }
  const language = incoming.get('accept-language');
  if (language) {
    result['Accept-Language'] = language;
  }
  return result;
}
