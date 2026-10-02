import { NextResponse, type NextRequest } from 'next/server';

import { resolveSiteOrigin } from '@/lib/env';

import type { AuthTokens } from '@/lib/api/types';
import { homeForRole, safeNextPath } from '@/lib/auth/access';
import { applyCookies, callBackendJson, loginCookies } from '@/lib/auth/bff';
import { backendGoogleError, bindingPath, loginErrorPath, providerError, siteUrl, statesMatch, unpackStateCookie } from '@/lib/auth/google-session';
import { GOOGLE_STATE_COOKIE, clearedGoogleCookies, googleSignupCookie, isAuthTokens, shouldUseSecureCookies } from '@/lib/auth/session-core';

export const dynamic = 'force-dynamic';

type CallbackBody =
  | { status: 'signed_in'; next: string | null; tokens: AuthTokens }
  | { status: 'mobile_required'; next: string | null; ticket: string; expiresInSeconds: number };

/**
 * Redirect URI registered in Google Cloud Console:
 * <site origin>/api/session/google/callback.
 *
 * Checks that the returning `state` is the one this browser started with,
 * lets the backend redeem the code, then either writes the session cookies and
 * redirects to the page the user came from, or opens the mobile-binding step.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const params = request.nextUrl.searchParams;
  const secure = shouldUseSecureCookies(request.headers, request.url);
  const { state: stateCookie, next: startedFrom } = unpackStateCookie(request.cookies.get(GOOGLE_STATE_COOKIE)?.value);
  const origin = resolveSiteOrigin();
  // The state is single-use either way.
  const cleared = clearedGoogleCookies(secure);
  const fail = (code: Parameters<typeof loginErrorPath>[0], next: string | null = startedFrom): NextResponse =>
    applyCookies(NextResponse.redirect(siteUrl(loginErrorPath(code, next), origin)), cleared);

  const providerFailure = params.get('error');
  if (providerFailure) return fail(providerError(providerFailure));

  const state = params.get('state');
  const code = params.get('code');
  if (!code || !statesMatch(stateCookie, state)) return fail('GOOGLE_STATE_INVALID');

  const result = await callBackendJson(request, `auth/google/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state ?? '')}`, { method: 'GET' });
  const body = result.body as CallbackBody | null;
  if (result.status !== 200 || body === null) return fail(backendGoogleError(result.status, result.body));

  const next = safeNextPath(body.next);
  if (body.status === 'signed_in' && isAuthTokens(body.tokens)) {
    const { cookies } = await loginCookies(request, body.tokens);
    return applyCookies(NextResponse.redirect(siteUrl(next ?? homeForRole(body.tokens.user.role), origin)), [...cleared, ...cookies]);
  }
  if (body.status === 'mobile_required' && typeof body.ticket === 'string') {
    const signup = googleSignupCookie(body.ticket, body.expiresInSeconds, secure);
    // Clear only the state cookie; the signup cookie is set in the same response.
    return applyCookies(NextResponse.redirect(siteUrl(bindingPath(next), origin)), [cleared[0]!, signup]);
  }
  return fail('GOOGLE_FAILED', next);
}
