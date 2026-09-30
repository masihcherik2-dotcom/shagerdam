import { NextResponse, type NextRequest } from 'next/server';

import { homeForRole, ruleFor } from './lib/auth/access';
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  clearedSessionCookies,
  isAccessTokenFresh,
  readAccessClaims,
  refreshAtBackend,
  sessionCookies,
  shouldUseSecureCookies,
  type CookieSpec,
} from './lib/auth/session-core';

/**
 * Runs before every page render:
 *
 * 1. **Silent refresh.** When the access cookie is missing/expiring but a
 *    refresh cookie exists, the refresh token is rotated at the backend and
 *    the new cookies are written to the response AND injected into the
 *    current request, so Server Components of this very render already see a
 *    valid token.
 * 2. **Route protection.** `/customer/*`, `/checkout`, `/vendor/*` and
 *    `/admin/*` require a session with an allowed role (see lib/auth/access):
 *    anonymous → /login?next=…, wrong role → /forbidden.
 *
 * The role is read from the access token's claims for routing only; the
 * backend verifies the signature and the role again on every API call.
 */
export async function middleware(request: NextRequest): Promise<NextResponse> {
  const { pathname, search } = request.nextUrl;
  const secure = shouldUseSecureCookies(request.headers, request.url);

  let claims = readAccessClaims(request.cookies.get(ACCESS_COOKIE)?.value);
  const refreshToken = request.cookies.get(REFRESH_COOKIE)?.value;
  let cookiesToWrite: CookieSpec[] = [];

  if (!isAccessTokenFresh(claims)) {
    claims = null;
    if (refreshToken) {
      const tokens = await refreshAtBackend(refreshToken, request.headers);
      if (tokens) {
        claims = readAccessClaims(tokens.accessToken);
        cookiesToWrite = sessionCookies(tokens, secure);
        request.cookies.set(ACCESS_COOKIE, tokens.accessToken);
        request.cookies.set(REFRESH_COOKIE, tokens.refreshToken);
      } else {
        cookiesToWrite = clearedSessionCookies(secure);
        request.cookies.delete(ACCESS_COOKIE);
        request.cookies.delete(REFRESH_COOKIE);
      }
    }
  }

  const rule = ruleFor(pathname);
  let response: NextResponse;

  if (rule && !claims) {
    const login = new URL('/login', request.url);
    login.searchParams.set('next', `${pathname}${search}`);
    response = NextResponse.redirect(login);
  } else if (rule && claims && !rule.roles.includes(claims.role)) {
    const forbidden = new URL('/forbidden', request.url);
    forbidden.searchParams.set('from', pathname);
    forbidden.searchParams.set('home', homeForRole(claims.role));
    response = NextResponse.redirect(forbidden);
  } else if (pathname === '/login' && claims) {
    // Already signed in: go to the requested page or the role's own area.
    const next = request.nextUrl.searchParams.get('next');
    const target = next && next.startsWith('/') && !next.startsWith('//') ? next : homeForRole(claims.role);
    response = NextResponse.redirect(new URL(target, request.url));
  } else {
    response = NextResponse.next({ request: { headers: request.headers } });
  }

  for (const cookie of cookiesToWrite) {
    response.cookies.set(cookie.name, cookie.value, cookie.options);
  }
  // Pages that depend on the session must never be served from a shared cache.
  if (rule) {
    response.headers.set('Cache-Control', 'private, no-store');
  }
  return response;
}

export const config = {
  // Pages only: the BFF (/api/*) refreshes on its own, static assets need no session.
  matcher: ['/((?!api/|_next/static|_next/image|favicon.ico|fonts/|.*\\.(?:png|jpg|jpeg|svg|webp|ico|woff2?)$).*)'],
};
