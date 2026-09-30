import axios from 'axios';

import { localizeErrorMessage } from './error-messages';

/** Classification of everything that can go wrong on an API call. */
export type ApiErrorKind = 'http' | 'network' | 'timeout' | 'parse' | 'unknown';

export interface ApiErrorOptions {
  kind: ApiErrorKind;
  status?: number;
  code?: string;
  details?: unknown;
  cause?: unknown;
}

/**
 * Single error type surfaced to the UI. Callers can branch on `kind`/`status`
 * without knowing whether the failure came from axios, fetch or JSON parsing.
 */
export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status?: number;
  readonly code?: string;
  readonly details?: unknown;

  constructor(message: string, options: ApiErrorOptions) {
    super(message, { cause: options.cause });
    this.name = 'ApiError';
    this.kind = options.kind;
    if (options.status !== undefined) {
      this.status = options.status;
    }
    if (options.code !== undefined) {
      this.code = options.code;
    }
    if (options.details !== undefined) {
      this.details = options.details;
    }
  }

  /** True for 4xx responses, where retrying the same request cannot help. */
  get isClientError(): boolean {
    return this.status !== undefined && this.status >= 400 && this.status < 500;
  }

  /** True when the backend is reachable but reports a failure (5xx). */
  get isServerError(): boolean {
    return this.status !== undefined && this.status >= 500;
  }
}

interface NestErrorBody {
  statusCode?: number;
  message?: string | string[];
  error?: string;
  /** Stable machine code of actionable errors (e.g. INSUFFICIENT_STOCK). */
  code?: string;
}

function readNestErrorBody(data: unknown): NestErrorBody | undefined {
  return typeof data === 'object' && data !== null ? (data as NestErrorBody) : undefined;
}

function messageFromBody(data: unknown): string | undefined {
  const body = readNestErrorBody(data);
  if (body?.message === undefined) {
    return undefined;
  }
  return Array.isArray(body.message) ? body.message.join('، ') : body.message;
}

/** Normalises any thrown value into an {@link ApiError}. */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) {
    return error;
  }

  if (axios.isAxiosError(error)) {
    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
      return new ApiError('پاسخی از سرور دریافت نشد؛ زمان درخواست به پایان رسید.', {
        kind: 'timeout',
        code: error.code,
        cause: error,
      });
    }

    if (error.response === undefined) {
      return new ApiError('ارتباط با سرور برقرار نشد. اتصال شبکه را بررسی کنید.', {
        kind: 'network',
        code: error.code,
        cause: error,
      });
    }

    const { status, data } = error.response;
    const code = readNestErrorBody(data)?.code;
    return new ApiError(localizeErrorMessage(status, code, messageFromBody(data), data), {
      kind: 'http',
      status,
      code: code ?? readNestErrorBody(data)?.error,
      details: data,
      cause: error,
    });
  }

  if (error instanceof Error) {
    return new ApiError(error.message, { kind: 'unknown', cause: error });
  }

  return new ApiError('خطای ناشناخته در ارتباط با سرور.', { kind: 'unknown', cause: error });
}

/** Builds an {@link ApiError} for a failed `fetch` response. */
export function toApiErrorFromResponse(response: Response, details: unknown): ApiError {
  return new ApiError(localizeErrorMessage(response.status, readNestErrorBody(details)?.code, messageFromBody(details), details), {
    kind: 'http',
    status: response.status,
    code: readNestErrorBody(details)?.code ?? readNestErrorBody(details)?.error,
    details,
  });
}
