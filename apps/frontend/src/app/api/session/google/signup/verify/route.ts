import type { NextRequest } from 'next/server';

import { safeNextPath } from '@/lib/auth/access';
import { CROSS_SITE_BODY, callBackendJson, completeLogin, isSameOrigin, jsonResponse } from '@/lib/auth/bff';
import { GOOGLE_SIGNUP_COOKIE, clearedGoogleCookies, isAuthTokens, shouldUseSecureCookies } from '@/lib/auth/session-core';

export const dynamic = 'force-dynamic';

/**
 * Mobile-binding step: POST { mobile, code } → the backend links the Google
 * account to the account of that number (or creates it) → httpOnly session
 * cookies; the browser receives the user and the page to continue to.
 */
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) {
    return jsonResponse(403, CROSS_SITE_BODY);
  }
  const ticket = request.cookies.get(GOOGLE_SIGNUP_COOKIE)?.value;
  if (!ticket) {
    return jsonResponse(401, { statusCode: 401, error: 'Unauthorized', code: 'GOOGLE_SIGNUP_EXPIRED', message: 'The Google sign-in has expired. Start again.' });
  }
  const body: unknown = await request.json().catch(() => null);
  const { mobile, code } = (body ?? {}) as { mobile?: unknown; code?: unknown };
  const result = await callBackendJson(request, 'auth/google/signup/verify', { method: 'POST', body: { mobile, code }, headers: { 'X-Google-Signup-Ticket': ticket } });
  const verified = result.body as { next?: unknown; tokens?: unknown } | null;
  if (result.status >= 300 || !isAuthTokens(verified?.tokens)) {
    return jsonResponse(result.status >= 300 ? result.status : 502, result.body);
  }
  const next = typeof verified.next === 'string' ? safeNextPath(verified.next) : null;
  return completeLogin(request, verified.tokens, { body: { next }, cookies: clearedGoogleCookies(shouldUseSecureCookies(request.headers, request.url)) });
}
