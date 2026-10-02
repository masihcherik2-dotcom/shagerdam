import type { NextRequest } from 'next/server';

import { CROSS_SITE_BODY, callBackendJson, completeLogin, isSameOrigin, jsonResponse } from '@/lib/auth/bff';
import { EMAIL_SIGNUP_EXPIRED, EMAIL_SIGNUP_TICKET_HEADER, isSignupTicket } from '@/lib/auth/email-session';
import { EMAIL_SIGNUP_COOKIE, clearedEmailSignupCookie, isAuthTokens, shouldUseSecureCookies } from '@/lib/auth/session-core';

export const dynamic = 'force-dynamic';

/**
 * Mobile step: POST { mobile, code } → the backend attaches the proven e-mail
 * to the account of that number (or creates a customer account) → httpOnly
 * session cookies; the ticket cookie is cleared.
 */
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) {
    return jsonResponse(403, CROSS_SITE_BODY);
  }
  const ticket = request.cookies.get(EMAIL_SIGNUP_COOKIE)?.value;
  if (!isSignupTicket(ticket)) return jsonResponse(401, EMAIL_SIGNUP_EXPIRED);
  const body: unknown = await request.json().catch(() => null);
  const { mobile, code } = (body ?? {}) as { mobile?: unknown; code?: unknown };
  const result = await callBackendJson(request, 'auth/email-otp/signup/verify', { method: 'POST', body: { mobile, code }, headers: { [EMAIL_SIGNUP_TICKET_HEADER]: ticket } });
  if (result.status >= 300 || !isAuthTokens(result.body)) {
    return jsonResponse(result.status >= 300 ? result.status : 502, result.body);
  }
  return completeLogin(request, result.body, { cookies: [clearedEmailSignupCookie(shouldUseSecureCookies(request.headers, request.url))] });
}
