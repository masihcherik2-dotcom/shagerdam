import type { NextRequest } from 'next/server';

import { callBackendJson, jsonResponse } from '@/lib/auth/bff';
import { EMAIL_SIGNUP_EXPIRED, EMAIL_SIGNUP_TICKET_HEADER, isSignupTicket } from '@/lib/auth/email-session';
import { EMAIL_SIGNUP_COOKIE } from '@/lib/auth/session-core';

export const dynamic = 'force-dynamic';

/** Mobile step: the proven e-mail (and the number a code was sent to) behind the httpOnly ticket cookie. */
export async function GET(request: NextRequest) {
  const ticket = request.cookies.get(EMAIL_SIGNUP_COOKIE)?.value;
  if (!isSignupTicket(ticket)) return jsonResponse(401, EMAIL_SIGNUP_EXPIRED);
  const result = await callBackendJson(request, 'auth/email-otp/signup', { method: 'GET', headers: { [EMAIL_SIGNUP_TICKET_HEADER]: ticket } });
  return jsonResponse(result.status, result.body);
}
