import { safeNextPath } from './access';

/**
 * Pure helpers of the Google sign-in BFF routes (/api/session/google/*).
 * The routes keep every token server-side; the browser only ever sees
 * redirects, the Google profile of the binding step and the signed-in user.
 */

/** Error codes the login page knows how to explain (anything else → GOOGLE_FAILED). */
export const GOOGLE_LOGIN_ERRORS = [
  'GOOGLE_ACCOUNT_CONFLICT',
  'GOOGLE_CANCELLED',
  'GOOGLE_EXCHANGE_FAILED',
  'GOOGLE_FAILED',
  'GOOGLE_MOBILE_LINKED_ELSEWHERE',
  'GOOGLE_NOT_CONFIGURED',
  'GOOGLE_RATE_LIMITED',
  'GOOGLE_SIGNUP_EXPIRED',
  'GOOGLE_STAFF_NOT_ALLOWED',
  'GOOGLE_STATE_INVALID',
  'GOOGLE_UNAVAILABLE',
] as const;
export type GoogleLoginError = (typeof GOOGLE_LOGIN_ERRORS)[number];

export function toGoogleLoginError(code: unknown): GoogleLoginError {
  return (GOOGLE_LOGIN_ERRORS as readonly string[]).includes(code as string) ? (code as GoogleLoginError) : 'GOOGLE_FAILED';
}

/** `/login?google=<code>[&next=…]` — where a failed Google sign-in lands. */
export function loginErrorPath(code: GoogleLoginError, next: string | null): string {
  const params = new URLSearchParams({ google: code });
  const safe = safeNextPath(next);
  if (safe) params.set('next', safe);
  return `/login?${params.toString()}`;
}

/** The mobile-binding step of a new Google identity. */
export function bindingPath(next: string | null): string {
  const safe = safeNextPath(next);
  return safe ? `/login/google?next=${encodeURIComponent(safe)}` : '/login/google';
}

/** Error code of a backend answer of the start/callback endpoints. */
export function backendGoogleError(status: number, body: unknown): GoogleLoginError {
  if (status === 429) return 'GOOGLE_RATE_LIMITED';
  const code = typeof body === 'object' && body !== null ? (body as { code?: unknown }).code : undefined;
  return toGoogleLoginError(code);
}

/** Error Google reports on the redirect (`?error=access_denied` when the user cancels). */
export function providerError(error: string): GoogleLoginError {
  return error === 'access_denied' ? 'GOOGLE_CANCELLED' : 'GOOGLE_FAILED';
}

/** Same string, compared without early exit (the state is a bearer value). */
export function statesMatch(cookie: string | undefined, query: string | null): boolean {
  if (!cookie || !query || cookie.length !== query.length) return false;
  let diff = 0;
  for (let index = 0; index < cookie.length; index += 1) diff |= cookie.charCodeAt(index) ^ query.charCodeAt(index);
  return diff === 0;
}

/**
 * Value of the httpOnly state cookie: `<state>` or `<state>.<base64url(next)>`.
 * Keeping `next` beside the state lets a sign-in cancelled at Google still
 * return the user to the page they came from (the backend only reveals `next`
 * after a successful code exchange). The backend state is base64url, so it
 * never contains a dot.
 */
export function packStateCookie(state: string, next: string | null): string {
  const safe = safeNextPath(next);
  return safe ? `${state}.${Buffer.from(safe, 'utf8').toString('base64url')}` : state;
}

export function unpackStateCookie(value: string | undefined): { state: string | undefined; next: string | null } {
  if (!value) return { state: undefined, next: null };
  const dot = value.indexOf('.');
  if (dot === -1) return { state: value, next: null };
  return { state: value.slice(0, dot), next: safeNextPath(Buffer.from(value.slice(dot + 1), 'base64url').toString('utf8')) };
}

/**
 * Absolute URL on the public site for a redirect. Route handlers behind
 * `next start` see the bind address (0.0.0.0) in `request.url`, so redirects
 * are built from the configured public origin instead.
 */
export function siteUrl(path: string, origin: string): URL {
  return new URL(path, origin);
}
