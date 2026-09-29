import type { NextRequest } from 'next/server';

import { CROSS_SITE_BODY, callBackendJson, isSameOrigin, jsonResponse } from '@/lib/auth/bff';

export const dynamic = 'force-dynamic';

/** Sends a sign-in code: POST { mobile } → backend auth/otp/request (rate-limited there). */
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) {
    return jsonResponse(403, CROSS_SITE_BODY);
  }
  const body: unknown = await request.json().catch(() => null);
  const { mobile } = (body ?? {}) as { mobile?: unknown };
  const result = await callBackendJson(request, 'auth/otp/request', { method: 'POST', body: { mobile } });
  return jsonResponse(result.status, result.body);
}
