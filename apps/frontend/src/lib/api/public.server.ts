import { backendApiUrl } from '../auth/session-core';
import { toQueryString, type Query } from './client';
import { ApiError, toApiError, toApiErrorFromResponse } from './errors';

const PUBLIC_FETCH_TIMEOUT_MS = 8_000;

/** Revalidation windows (seconds) of the public catalogue data — ISR at the data layer. */
export const REVALIDATE = {
  home: 60,
  category: 120,
  product: 120,
  search: 60,
} as const;

/**
 * Anonymous, cacheable access to the public catalogue endpoints (products,
 * categories, credit plans): no cookies, no Authorization, no per-visitor
 * forwarding headers — so the response is identical for every visitor and is
 * kept in the Next.js Data Cache for `revalidate` seconds (stale-while-
 * revalidate), shared by all requests of the server.
 *
 * The HTML itself is still rendered per request, because the root layout reads
 * the session cookie (header / account menu); what ISR saves here is the
 * backend round-trip and database work, which is the expensive part.
 * Never use this for anything that depends on who is asking.
 */
export async function publicApi<T>(path: string, options: { query?: Query; revalidate: number; tags?: string[] }): Promise<T> {
  try {
    const response = await fetch(`${backendApiUrl(path)}${toQueryString(options.query)}`, {
      headers: { Accept: 'application/json' },
      next: { revalidate: options.revalidate, ...(options.tags ? { tags: options.tags } : {}) },
      signal: AbortSignal.timeout(PUBLIC_FETCH_TIMEOUT_MS),
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

/** Like {@link publicApi} but resolves to null on 404. */
export async function publicApiOrNull<T>(path: string, options: { query?: Query; revalidate: number; tags?: string[] }): Promise<T | null> {
  try {
    return await publicApi<T>(path, options);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return null;
    }
    throw error;
  }
}
