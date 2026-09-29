import { resolveBackendInternalUrl } from '../env';
import { ApiError, toApiError, toApiErrorFromResponse } from './errors';
import type { SystemHealth } from './health';

const SERVER_FETCH_TIMEOUT_MS = 5_000;

/**
 * Server-side variant of the health call, used for the first render of the
 * status page. It reaches the backend directly (never through the browser) and
 * can run in two modes:
 *
 * - `required` (default for the status page): a failure throws an ApiError so
 *   the caller can render an explicit error state.
 * - `optional`: failures resolve to `null`, e.g. for progressive enhancement.
 */
export async function getSystemHealthServerSide(): Promise<SystemHealth> {
  const endpoint = `${resolveBackendInternalUrl()}/api/v1/health`;

  try {
    const response = await fetch(endpoint, {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(SERVER_FETCH_TIMEOUT_MS),
    });

    const body: unknown = await response.json().catch(() => undefined);

    // A 503 still carries a useful report: the API is up but a dependency is
    // down, which is exactly what the status page must display.
    if (!response.ok && body === undefined) {
      throw toApiErrorFromResponse(response, body);
    }

    return body as SystemHealth;
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    throw toApiError(error);
  }
}
