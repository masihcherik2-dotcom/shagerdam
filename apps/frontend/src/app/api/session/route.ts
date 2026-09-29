import type { NextRequest } from 'next/server';

import type { Me } from '@/lib/api/types';
import { CROSS_SITE_BODY, applyCookies, callBackendJson, isSameOrigin, jsonResponse } from '@/lib/auth/bff';
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
} from '@/lib/auth/session-core';

export const dynamic = 'force-dynamic';

/**
 * GET: the signed-in identity (backend auth/me) or `{ user: null }`.
 * Refreshes the session when the access token expired, and also when the
 * role stored in the token no longer matches the account (e.g. a customer
 * whose store was just approved becomes VENDOR) so routing follows at once.
 */
export async function GET(request: NextRequest) {
  const secure = shouldUseSecureCookies(request.headers, request.url);
  const refreshToken = request.cookies.get(REFRESH_COOKIE)?.value;
  let accessToken = request.cookies.get(ACCESS_COOKIE)?.value;
  const cookies: CookieSpec[] = [];

  const rotate = async (): Promise<boolean> => {
    if (!refreshToken) {
      return false;
    }
    const tokens = await refreshAtBackend(refreshToken, request.headers);
    if (!tokens) {
      cookies.push(...clearedSessionCookies(secure));
      return false;
    }
    accessToken = tokens.accessToken;
    cookies.push(...sessionCookies(tokens, secure));
    return true;
  };

  if (!isAccessTokenFresh(readAccessClaims(accessToken)) && !(await rotate())) {
    return applyCookies(jsonResponse(200, { user: null }), cookies);
  }

  let me = await callBackendJson(request, 'auth/me', { method: 'GET', accessToken });
  if (me.status === 401 && cookies.length === 0 && (await rotate())) {
    me = await callBackendJson(request, 'auth/me', { method: 'GET', accessToken });
  }
  if (me.status === 401) {
    return applyCookies(jsonResponse(200, { user: null }), [...cookies, ...clearedSessionCookies(secure)]);
  }
  if (me.status >= 300) {
    return applyCookies(jsonResponse(me.status, me.body), cookies);
  }

  const identity = me.body as Me;
  const tokenRole = readAccessClaims(accessToken)?.role;
  if (tokenRole !== undefined && tokenRole !== identity.user.role && cookies.length === 0) {
    await rotate();
  }
  return applyCookies(jsonResponse(200, identity), cookies);
}

/** DELETE: sign out — revokes the refresh session at the backend and clears the cookies. */
export async function DELETE(request: NextRequest) {
  if (!isSameOrigin(request)) {
    return jsonResponse(403, CROSS_SITE_BODY);
  }
  const secure = shouldUseSecureCookies(request.headers, request.url);
  let refreshToken = request.cookies.get(REFRESH_COOKIE)?.value;
  let accessToken = request.cookies.get(ACCESS_COOKIE)?.value;
  let revoked = false;
  // Backend logout authenticates with the access token. When it has expired,
  // rotate the refresh token first: rotation already invalidates the old
  // refresh token, and logging out with the fresh pair revokes the new session.
  // Without this, an expired access token would leave the server-side session
  // (and the refresh token) alive after "sign out".
  if (refreshToken && !isAccessTokenFresh(readAccessClaims(accessToken))) {
    const rotated = await refreshAtBackend(refreshToken, request.headers);
    if (rotated) {
      accessToken = rotated.accessToken;
      refreshToken = rotated.refreshToken;
    } else {
      // The refresh token is already unusable (expired/revoked): nothing left to revoke.
      accessToken = undefined;
      refreshToken = undefined;
      revoked = true;
    }
  }
  if (accessToken) {
    const result = await callBackendJson(request, 'auth/logout', {
      method: 'POST',
      accessToken,
      body: refreshToken ? { refreshToken } : {},
    });
    revoked = result.status < 300;
  }
  return applyCookies(jsonResponse(200, { signedOut: true, revoked }), clearedSessionCookies(secure));
}
