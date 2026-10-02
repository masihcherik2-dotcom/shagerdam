import type { NextRequest } from 'next/server';

import { CROSS_SITE_BODY, callBackendJson, isSameOrigin, jsonResponse } from '@/lib/auth/bff';

export const dynamic = 'force-dynamic';

/** Sends a sign-in code by e-mail: POST { email } → backend auth/email-otp/request (rate-limited there). */
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) {
    return jsonResponse(403, CROSS_SITE_BODY);
  }
  const body: unknown = await request.json().catch(() => null);
  const { email } = (body ?? {}) as { email?: unknown };
  const result = await callBackendJson(request, 'auth/email-otp/request', { method: 'POST', body: { email } });
  return jsonResponse(result.status, result.body);
}
