import type { NextRequest } from 'next/server';

import { CROSS_SITE_BODY, applyCookies, callBackendJson, completeLogin, isSameOrigin, jsonResponse } from '@/lib/auth/bff';
import { readEmailVerify } from '@/lib/auth/email-session';
import { clearedEmailSignupCookie, emailSignupCookie, shouldUseSecureCookies } from '@/lib/auth/session-core';

export const dynamic = 'force-dynamic';

/**
 * POST { email, code }. A verified address signs in (httpOnly session
 * cookies). Otherwise the signup ticket goes into an httpOnly cookie and the
 * browser is told to confirm a mobile number.
 */
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) {
    return jsonResponse(403, CROSS_SITE_BODY);
  }
  const body: unknown = await request.json().catch(() => null);
  const { email, code } = (body ?? {}) as { email?: unknown; code?: unknown };
  const result = await callBackendJson(request, 'auth/email-otp/verify', { method: 'POST', body: { email, code } });
  if (result.status >= 300) {
    return jsonResponse(result.status, result.body);
  }
  const secure = shouldUseSecureCookies(request.headers, request.url);
  const outcome = readEmailVerify(result.body);
  if (outcome.kind === 'signed_in') {
    return completeLogin(request, outcome.tokens, { body: { status: 'signed_in' }, cookies: [clearedEmailSignupCookie(secure)] });
  }
  if (outcome.kind === 'mobile_required') {
    return applyCookies(jsonResponse(200, { status: 'mobile_required', email: outcome.email, expiresInSeconds: outcome.expiresInSeconds }), [
      emailSignupCookie(outcome.ticket, outcome.expiresInSeconds, secure),
    ]);
  }
  return jsonResponse(502, { statusCode: 502, error: 'Bad Gateway', message: 'Unexpected answer from the API.' });
}
