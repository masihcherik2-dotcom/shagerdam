import { NextResponse, type NextRequest } from 'next/server';

import { applyCookies, callBackendJson } from '@/lib/auth/bff';
import { backendGoogleError, loginErrorPath, packStateCookie, siteUrl } from '@/lib/auth/google-session';
import { safeNextPath } from '@/lib/auth/access';
import { resolveSiteOrigin } from '@/lib/env';
import { googleStateCookie, shouldUseSecureCookies } from '@/lib/auth/session-core';

export const dynamic = 'force-dynamic';

/**
 * Starts "Sign in with Google": GET /api/session/google?next=/cart.
 * The backend stores state + PKCE verifier + nonce; this route keeps the state
 * in an httpOnly cookie (binding the attempt to this browser) and sends the
 * browser to Google.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const next = safeNextPath(request.nextUrl.searchParams.get('next'));
  const result = await callBackendJson(request, `auth/google${next ? `?next=${encodeURIComponent(next)}` : ''}`, { method: 'GET' });
  const body = result.body as { authorizationUrl?: unknown; state?: unknown; expiresInSeconds?: unknown } | null;
  if (result.status !== 200 || typeof body?.authorizationUrl !== 'string' || typeof body.state !== 'string') {
    return NextResponse.redirect(siteUrl(loginErrorPath(backendGoogleError(result.status, result.body), next), resolveSiteOrigin()));
  }
  const maxAge = typeof body.expiresInSeconds === 'number' ? body.expiresInSeconds : 600;
  const secure = shouldUseSecureCookies(request.headers, request.url);
  return applyCookies(NextResponse.redirect(body.authorizationUrl), [googleStateCookie(packStateCookie(body.state, next), maxAge, secure)]);
}
