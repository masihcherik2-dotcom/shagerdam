import { cookies, headers } from 'next/headers';

import { ACCESS_COOKIE, CART_COOKIE, backendApiUrl, forwardingHeaders } from '../auth/session-core';
import { ApiError, toApiError, toApiErrorFromResponse } from './errors';
import { toQueryString, type Query } from './client';
import type { Me } from './types';

const SERVER_FETCH_TIMEOUT_MS = 8_000;

/**
 * Server Component / Server Action access to the backend: direct (never via
 * the browser), with the session's access token from the httpOnly cookie
 * (the middleware has already refreshed it for this render).
 */
export async function serverApi<T>(path: string, options: { query?: Query; method?: string; body?: unknown } = {}): Promise<T> {
  const cookieStore = await cookies();
  const incoming = await headers();
  const requestHeaders: Record<string, string> = { Accept: 'application/json', ...forwardingHeaders(incoming) };
  const accessToken = cookieStore.get(ACCESS_COOKIE)?.value;
  if (accessToken) {
    requestHeaders.Authorization = `Bearer ${accessToken}`;
  }
  const cartToken = cookieStore.get(CART_COOKIE)?.value;
  if (cartToken) {
    requestHeaders['X-Cart-Token'] = cartToken;
  }
  if (options.body !== undefined) {
    requestHeaders['Content-Type'] = 'application/json';
  }
  try {
    const response = await fetch(`${backendApiUrl(path)}${toQueryString(options.query)}`, {
      method: options.method ?? 'GET',
      headers: requestHeaders,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      cache: 'no-store',
      signal: AbortSignal.timeout(SERVER_FETCH_TIMEOUT_MS),
    });
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      throw toApiErrorFromResponse(response, body);
    }
    return body as T;
  } catch (error) {
    throw error instanceof ApiError ? error : toApiError(error);
  }
}

/** Like {@link serverApi} but resolves to null on 404 (missing product/category). */
export async function serverApiOrNull<T>(path: string, options: { query?: Query } = {}): Promise<T | null> {
  try {
    return await serverApi<T>(path, options);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return null;
    }
    throw error;
  }
}

/** The signed-in identity for the first render, or null (anonymous / expired). */
export async function getServerSession(): Promise<Me | null> {
  const cookieStore = await cookies();
  if (!cookieStore.get(ACCESS_COOKIE)?.value) {
    return null;
  }
  try {
    return await serverApi<Me>('auth/me');
  } catch {
    return null;
  }
}
