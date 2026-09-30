import axios, { type AxiosInstance, type AxiosRequestConfig } from 'axios';

import { resolvePublicApiBaseUrl } from '../env';
import { toApiError } from './errors';

/** Upper bound for a browser request before it is reported as a timeout. */
export const REQUEST_TIMEOUT_MS = 15_000;
/** Uploads carry images/documents of several megabytes. */
export const UPLOAD_TIMEOUT_MS = 90_000;
/** Product import: the API may try Digikala's API and then the product page (10 s each). */
export const IMPORT_EXTRACT_TIMEOUT_MS = 30_000;
/** Up to 12 remote images, 3 at a time, each ≤ 10 s plus WebP processing. */
export const IMPORT_IMAGES_TIMEOUT_MS = 120_000;

/**
 * Creates an axios instance that always talks to the Shagerdam BFF (same
 * origin, `/api/v1`) and never leaks transport-specific errors to the callers:
 * every rejection is an {@link import('./errors').ApiError}.
 *
 * No token handling happens here: the BFF attaches the httpOnly session
 * cookies' access token server-side and refreshes it transparently.
 */
export function createApiClient(baseURL: string = resolvePublicApiBaseUrl()): AxiosInstance {
  const instance = axios.create({
    baseURL,
    timeout: REQUEST_TIMEOUT_MS,
    withCredentials: true,
    headers: {
      Accept: 'application/json',
    },
    // Arrays as repeated keys (colors=a&colors=b), which the backend expects.
    paramsSerializer: { indexes: null },
  });

  instance.interceptors.response.use(
    (response) => response,
    (error: unknown) => Promise.reject(toApiError(error)),
  );

  return instance;
}

/** Shared client for browser components. */
export const apiClient = createApiClient();

export type QueryValue = string | number | boolean | readonly string[] | null | undefined;
export type Query = Record<string, QueryValue>;

/** Drops empty values so optional filters never reach the API as "". */
export function cleanQuery(query: Query | undefined): Record<string, string | number | boolean | readonly string[]> {
  const result: Record<string, string | number | boolean | readonly string[]> = {};
  if (!query) {
    return result;
  }
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value) && value.length === 0) continue;
    result[key] = value as string | number | boolean | readonly string[];
  }
  return result;
}

/** Query string in the same format the axios client sends. */
export function toQueryString(query: Query | undefined): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(cleanQuery(query))) {
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, String(item));
    } else {
      params.set(key, String(value));
    }
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

export async function apiGet<TResponse>(path: string, config?: AxiosRequestConfig & { query?: Query }): Promise<TResponse> {
  const { query, ...rest } = config ?? {};
  const { data } = await apiClient.get<TResponse>(path, { ...rest, params: cleanQuery(query) });
  return data;
}

export async function apiPost<TResponse, TBody = unknown>(path: string, body?: TBody, config?: AxiosRequestConfig): Promise<TResponse> {
  const { data } = await apiClient.post<TResponse>(path, body ?? {}, config);
  return data;
}

export async function apiPatch<TResponse, TBody = unknown>(path: string, body: TBody, config?: AxiosRequestConfig): Promise<TResponse> {
  const { data } = await apiClient.patch<TResponse>(path, body, config);
  return data;
}

export async function apiDelete<TResponse>(path: string, config?: AxiosRequestConfig): Promise<TResponse> {
  const { data } = await apiClient.delete<TResponse>(path, config);
  return data;
}

/**
 * Multipart upload (media endpoints). `purpose` is written before the file:
 * the backend reads the parts in order.
 */
export async function apiUpload<TResponse>(path: string, file: File, purpose: string, onProgress?: (fraction: number) => void): Promise<TResponse> {
  return apiUploadWithFields<TResponse>(path, file, { purpose }, onProgress);
}

/** Multipart upload with arbitrary text fields, all written before the file. */
export async function apiUploadWithFields<TResponse>(
  path: string,
  file: File,
  fields: Record<string, string>,
  onProgress?: (fraction: number) => void,
): Promise<TResponse> {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.append(name, value);
  form.append('file', file, file.name);
  const { data } = await apiClient.post<TResponse>(path, form, {
    timeout: UPLOAD_TIMEOUT_MS,
    onUploadProgress: (event) => {
      if (onProgress && event.total) {
        onProgress(event.loaded / event.total);
      }
    },
  });
  return data;
}

/** Same-origin session endpoints (sign-in/out) of the BFF — not under /api/v1. */
export const sessionClient = createApiClient('/api/session');
