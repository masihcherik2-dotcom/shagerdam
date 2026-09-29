import type { NextRequest } from 'next/server';

import { CROSS_SITE_BODY, callBackendJson, completeLogin, isSameOrigin, jsonResponse } from '@/lib/auth/bff';
import { isAuthTokens } from '@/lib/auth/session-core';

export const dynamic = 'force-dynamic';

/** OTP sign-in: POST { mobile, code } → backend auth/otp/verify → httpOnly cookies. */
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) {
    return jsonResponse(403, CROSS_SITE_BODY);
  }
  const body: unknown = await request.json().catch(() => null);
  const { mobile, code } = (body ?? {}) as { mobile?: unknown; code?: unknown };
  const result = await callBackendJson(request, 'auth/otp/verify', { method: 'POST', body: { mobile, code } });
  if (result.status >= 300 || !isAuthTokens(result.body)) {
    return jsonResponse(result.status >= 300 ? result.status : 502, result.body);
  }
  return completeLogin(request, result.body);
}
