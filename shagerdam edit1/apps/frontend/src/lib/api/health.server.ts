import { resolveBackendInternalUrl } from '../env';
import { ApiError, toApiError, toApiErrorFromResponse } from './errors';
import { isPublicStatusReport } from './health';
import type { PublicStatusReport } from './types';

const SERVER_FETCH_TIMEOUT_MS = 5_000;

/**
 * First render of the status page: `GET /health/status` straight from the
 * backend (never through the browser). Throws an ApiError when the API itself
 * is unreachable so the page can say so explicitly.
 */
export async function getPublicStatusServerSide(): Promise<PublicStatusReport> {
  try {
    const response = await fetch(`${resolveBackendInternalUrl()}/api/v1/health/status`, {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(SERVER_FETCH_TIMEOUT_MS),
    });
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok || !isPublicStatusReport(body)) {
      throw toApiErrorFromResponse(response, body);
    }
    return body;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw toApiError(error);
  }
}
