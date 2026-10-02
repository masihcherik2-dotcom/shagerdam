import type { NextRequest } from 'next/server';

import { callBackendJson, jsonResponse } from '@/lib/auth/bff';
import { GOOGLE_SIGNUP_COOKIE } from '@/lib/auth/session-core';

export const dynamic = 'force-dynamic';

const SIGNUP_EXPIRED = { statusCode: 401, error: 'Unauthorized', code: 'GOOGLE_SIGNUP_EXPIRED', message: 'The Google sign-in has expired. Start again.' };

/** Mobile-binding step: the Google name, e-mail and picture behind the httpOnly ticket cookie. */
export async function GET(request: NextRequest) {
  const ticket = request.cookies.get(GOOGLE_SIGNUP_COOKIE)?.value;
  if (!ticket) return jsonResponse(401, SIGNUP_EXPIRED);
  const result = await callBackendJson(request, 'auth/google/signup', { method: 'GET', headers: { 'X-Google-Signup-Ticket': ticket } });
  return jsonResponse(result.status, result.body);
}
