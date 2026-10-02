import { NextResponse, type NextRequest } from 'next/server';

import type { AuthTokens, Cart } from '../api/types';
import {
  CART_COOKIE,
  backendApiUrl,
  clearedCartCookie,
  forwardingHeaders,
  sessionCookies,
  shouldUseSecureCookies,
  type CookieSpec,
} from './session-core';

/**
 * Helpers for the BFF route handlers under /api/session: they call the
 * backend, keep the tokens server-side and answer the browser with the user
 * only.
 */

type CartMergeReport = { mergedLines: number; clampedLines: unknown[]; droppedLines: unknown[] };

export interface BackendResult {
  status: number;
  body: unknown;
}

export async function callBackendJson(
  request: NextRequest,
  path: string,
  init: { method: string; body?: unknown; accessToken?: string; cartToken?: string; headers?: Record<string, string> },
): Promise<BackendResult> {
  const headers: Record<string, string> = { Accept: 'application/json', ...forwardingHeaders(request.headers), ...init.headers };
  if (init.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  if (init.accessToken) {
    headers.Authorization = `Bearer ${init.accessToken}`;
  }
  if (init.cartToken) {
    headers['X-Cart-Token'] = init.cartToken;
  }
  try {
    const response = await fetch(backendApiUrl(path), {
      method: init.method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      cache: 'no-store',
    });
    const text = await response.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { message: text };
      }
    }
    return { status: response.status, body };
  } catch {
    return { status: 502, body: { statusCode: 502, error: 'Bad Gateway', message: 'سرور اصلی در دسترس نیست. کمی بعد دوباره تلاش کنید.' } };
  }
}

export function applyCookies(response: NextResponse, cookies: CookieSpec[]): NextResponse {
  for (const cookie of cookies) {
    response.cookies.set(cookie.name, cookie.value, cookie.options);
  }
  return response;
}

export function jsonResponse(status: number, body: unknown): NextResponse {
  return NextResponse.json(body ?? {}, { status, headers: { 'Cache-Control': 'no-store' } });
}

/**
 * Same-origin check for state-changing BFF calls (defence in depth on top of
 * SameSite=Lax cookies): a present Origin header must match the host the
 * browser used.
 */
export function isSameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get('origin');
  if (!origin) {
    return true;
  }
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  try {
    return host !== null && new URL(origin).host === host;
  } catch {
    return false;
  }
}

export const CROSS_SITE_BODY = { statusCode: 403, error: 'Forbidden', code: 'CROSS_SITE_REQUEST', message: 'درخواست از مبدأ دیگری ارسال شده است.' };

/**
 * Session cookies of a fresh login, after merging the guest cart into the
 * account (backend POST /cart/merge) and dropping the guest cart cookie.
 */
export async function loginCookies(request: NextRequest, tokens: AuthTokens): Promise<{ cookies: CookieSpec[]; merge: CartMergeReport | null }> {
  const secure = shouldUseSecureCookies(request.headers, request.url);
  const cookies: CookieSpec[] = sessionCookies(tokens, secure);
  const guestCartToken = request.cookies.get(CART_COOKIE)?.value;
  let merge: CartMergeReport | null = null;
  if (guestCartToken) {
    const merged = await callBackendJson(request, 'cart/merge', { method: 'POST', accessToken: tokens.accessToken, cartToken: guestCartToken });
    if (merged.status < 300) {
      merge = (merged.body as { report: CartMergeReport; cart: Cart }).report;
    }
    // Merged (or refused as malformed): the guest cart cookie has done its job. On a
    // backend outage (5xx) it is kept so the next login can still merge it.
    if (merged.status < 500) {
      cookies.push(clearedCartCookie(secure));
    }
  }
  return { cookies, merge };
}

/**
 * Completes a login: writes the session cookies, merges the guest cart into
 * the account and drops the guest cart cookie. The browser receives only the
 * user (plus `extra` fields such as the post-login path).
 */
export async function completeLogin(request: NextRequest, tokens: AuthTokens, extra: { body?: Record<string, unknown>; cookies?: CookieSpec[] } = {}): Promise<NextResponse> {
  const { cookies, merge } = await loginCookies(request, tokens);
  return applyCookies(jsonResponse(200, { user: tokens.user, cartMerge: merge, ...extra.body }), [...cookies, ...(extra.cookies ?? [])]);
}
