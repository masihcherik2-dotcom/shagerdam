import type { NextRequest } from 'next/server';

import { CROSS_SITE_BODY, callBackendJson, isSameOrigin, jsonResponse } from '@/lib/auth/bff';
import { GOOGLE_SIGNUP_COOKIE } from '@/lib/auth/session-core';

export const dynamic = 'force-dynamic';

/** Mobile-binding step: POST { mobile } → SMS code for the number to attach. */
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) {
    return jsonResponse(403, CROSS_SITE_BODY);
  }
  const ticket = request.cookies.get(GOOGLE_SIGNUP_COOKIE)?.value;
  if (!ticket) {
    return jsonResponse(401, { statusCode: 401, error: 'Unauthorized', code: 'GOOGLE_SIGNUP_EXPIRED', message: 'The Google sign-in has expired. Start again.' });
  }
  const body: unknown = await request.json().catch(() => null);
  const { mobile } = (body ?? {}) as { mobile?: unknown };
  const result = await callBackendJson(request, 'auth/google/signup/otp', { method: 'POST', body: { mobile }, headers: { 'X-Google-Signup-Ticket': ticket } });
  return jsonResponse(result.status, result.body);
}
