import { NextResponse, type NextRequest } from 'next/server';

import { CROSS_SITE_BODY, applyCookies, isSameOrigin, jsonResponse } from '@/lib/auth/bff';
import {
  ACCESS_COOKIE,
  CART_COOKIE,
  REFRESH_COOKIE,
  backendOrigin,
  cartCookie,
  clearedSessionCookies,
  forwardingHeaders,
  isAccessTokenFresh,
  readAccessClaims,
  refreshAtBackend,
  sessionCookies,
  shouldUseSecureCookies,
  type CookieSpec,
} from '@/lib/auth/session-core';

export const dynamic = 'force-dynamic';

/**
 * Backend-for-frontend proxy: every browser call to /api/v1/* lands here and
 * is forwarded to the backend with
 *
 * - `Authorization: Bearer <access token>` from the httpOnly cookie,
 * - `X-Cart-Token` from the guest-cart cookie,
 * - one transparent refresh + retry when the backend answers 401,
 * - request/response bodies passed through byte-for-byte (JSON, multipart
 *   uploads, document downloads, the sandbox bank page's HTML/forms) and
 *   redirects handed to the browser unchanged (payment callback → result page).
 *
 * Token-issuing endpoints are not reachable through here — they would put the
 * tokens in reach of browser JavaScript. Sign-in/out goes through /api/session.
 */

const BLOCKED_PATHS = new Set(['auth/otp/verify', 'auth/login/password', 'auth/refresh', 'auth/logout', 'health']);

/**
 * `health` (exact) is the operator readiness probe with dependency details; it
 * stays reachable inside the Docker network only. Visitors use `health/status`.
 */
const BLOCKED_MESSAGES: Record<string, string> = { health: 'Not available publicly. See /api/v1/health/status.' };

/**
 * Called by the bank, possibly as a cross-site form POST. Public at the
 * backend and verified server-to-server with the gateway, so the same-origin
 * check does not apply.
 */
const CROSS_SITE_ALLOWED = new Set(['payments/callback']);

/** Request headers worth forwarding (everything else is hop-by-hop or identity we set ourselves). */
const FORWARDED_REQUEST_HEADERS = ['accept', 'content-type', 'if-none-match', 'if-modified-since', 'range'];

/** Response headers the browser must not receive from upstream as-is. */
const DROPPED_RESPONSE_HEADERS = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'set-cookie']);

/**
 * Google sign-in endpoints issue tokens or hold the signup ticket; only the
 * BFF (/api/session/google/*) calls them. `auth/google/status` stays public.
 */
function isGoogleSessionPath(blockKey: string): boolean {
  return blockKey === 'auth/google' || (blockKey.startsWith('auth/google/') && blockKey !== 'auth/google/status');
}

type RouteContext = { params: Promise<{ path: string[] }> };

async function forward(request: NextRequest, path: string, body: ArrayBuffer | undefined, accessToken: string | undefined): Promise<Response> {
  const headers = new Headers(forwardingHeaders(request.headers));
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) {
      headers.set(name, value);
    }
  }
  if (accessToken) {
    headers.set('Authorization', `Bearer ${accessToken}`);
  }
  const cartToken = request.cookies.get(CART_COOKIE)?.value;
  if (cartToken) {
    headers.set('X-Cart-Token', cartToken);
  }
  return fetch(`${backendOrigin()}/api/v1/${path}${request.nextUrl.search}`, {
    method: request.method,
    headers,
    body,
    redirect: 'manual',
    cache: 'no-store',
  });
}

async function handle(request: NextRequest, context: RouteContext): Promise<Response> {
  const { path: segments } = await context.params;
  const path = segments.map((segment) => encodeURIComponent(segment)).join('/');

  // Compared case-insensitively and without trailing slashes so `HEALTH` or
  // `health/` cannot slip past to a router that treats them as the same route.
  const blockKey = path.toLowerCase().replace(/\/+$/, '');
  if (BLOCKED_PATHS.has(blockKey) || isGoogleSessionPath(blockKey)) {
    return jsonResponse(404, { statusCode: 404, error: 'Not Found', message: BLOCKED_MESSAGES[blockKey] ?? 'Use /api/session for sign-in, refresh and sign-out.' });
  }
  const mutating = request.method !== 'GET' && request.method !== 'HEAD';
  if (mutating && !CROSS_SITE_ALLOWED.has(path) && !isSameOrigin(request)) {
    return jsonResponse(403, CROSS_SITE_BODY);
  }

  const secure = shouldUseSecureCookies(request.headers, request.url);
  const cookies: CookieSpec[] = [];
  const refreshToken = request.cookies.get(REFRESH_COOKIE)?.value;
  let accessToken = request.cookies.get(ACCESS_COOKIE)?.value;

  const rotate = async (): Promise<boolean> => {
    if (!refreshToken) {
      return false;
    }
    const tokens = await refreshAtBackend(refreshToken, request.headers);
    if (!tokens) {
      accessToken = undefined;
      cookies.push(...clearedSessionCookies(secure));
      return false;
    }
    accessToken = tokens.accessToken;
    cookies.push(...sessionCookies(tokens, secure));
    return true;
  };

  // Refresh up front when we already know the access token is stale.
  if (!isAccessTokenFresh(readAccessClaims(accessToken))) {
    if (refreshToken) {
      await rotate();
    } else {
      accessToken = undefined;
    }
  }

  // Buffered so the request can be replayed once after a refresh.
  const body = mutating ? await request.arrayBuffer() : undefined;

  let upstream: Response;
  try {
    upstream = await forward(request, path, body, accessToken);
    if (upstream.status === 401 && refreshToken && cookies.length === 0 && (await rotate())) {
      upstream = await forward(request, path, body, accessToken);
    }
  } catch (error) {
    console.error(`[bff] upstream request failed: ${request.method} /api/v1/${path}`, error);
    return applyCookies(
      jsonResponse(502, { statusCode: 502, error: 'Bad Gateway', message: 'سرور اصلی در دسترس نیست. کمی بعد دوباره تلاش کنید.' }),
      cookies,
    );
  }

  const responseHeaders = new Headers();
  upstream.headers.forEach((value, name) => {
    if (!DROPPED_RESPONSE_HEADERS.has(name.toLowerCase())) {
      responseHeaders.set(name, value);
    }
  });

  // A guest cart is identified by the token the backend returns in the cart body.
  // Keep it in an httpOnly cookie instead of exposing it to scripts.
  const contentType = upstream.headers.get('content-type') ?? '';
  let responseBody: BodyInit | null = upstream.body;
  if (path.startsWith('cart') && upstream.ok && contentType.includes('application/json')) {
    const text = await upstream.text();
    responseBody = text;
    try {
      const parsed = JSON.parse(text) as { cartToken?: unknown; owner?: unknown };
      const current = request.cookies.get(CART_COOKIE)?.value;
      if (parsed.owner === 'guest' && typeof parsed.cartToken === 'string' && parsed.cartToken !== current) {
        cookies.push(cartCookie(parsed.cartToken, secure));
      }
    } catch {
      // Not a cart body (e.g. an empty 204): nothing to remember.
    }
  }

  const response = new NextResponse(upstream.status === 204 || upstream.status === 304 ? null : responseBody, {
    status: upstream.status,
    headers: responseHeaders,
  });
  return applyCookies(response, cookies);
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
