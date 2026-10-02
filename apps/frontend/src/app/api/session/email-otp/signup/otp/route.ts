import type { NextRequest } from 'next/server';

import { CROSS_SITE_BODY, callBackendJson, isSameOrigin, jsonResponse } from '@/lib/auth/bff';
import { EMAIL_SIGNUP_EXPIRED, EMAIL_SIGNUP_TICKET_HEADER, isSignupTicket } from '@/lib/auth/email-session';
import { EMAIL_SIGNUP_COOKIE } from '@/lib/auth/session-core';

export const dynamic = 'force-dynamic';

/** Mobile step: POST { mobile } → SMS code for the number to attach the e-mail to. */
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) {
    return jsonResponse(403, CROSS_SITE_BODY);
  }
  const ticket = request.cookies.get(EMAIL_SIGNUP_COOKIE)?.value;
  if (!isSignupTicket(ticket)) return jsonResponse(401, EMAIL_SIGNUP_EXPIRED);
  const body: unknown = await request.json().catch(() => null);
  const { mobile } = (body ?? {}) as { mobile?: unknown };
  const result = await callBackendJson(request, 'auth/email-otp/signup/otp', { method: 'POST', body: { mobile }, headers: { [EMAIL_SIGNUP_TICKET_HEADER]: ticket } });
  return jsonResponse(result.status, result.body);
}
