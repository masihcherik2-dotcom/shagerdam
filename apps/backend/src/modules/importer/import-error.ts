import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Failure vocabulary of the importer. Each code maps to exactly one HTTP status,
 * so a client can tell "your URL is wrong" (400) from "that site is not a
 * product page" (422) from "that site failed us" (502/504).
 */
export type ImportErrorCode =
  | 'INVALID_URL'
  | 'BLOCKED_TARGET'
  | 'TIMEOUT'
  | 'TOO_LARGE'
  | 'TOO_MANY_REDIRECTS'
  | 'NETWORK'
  | 'UPSTREAM_STATUS'
  | 'UNSUPPORTED_CONTENT'
  | 'NOT_A_PRODUCT'
  | 'NOT_FOUND';

export class ImportError extends Error {
  constructor(
    readonly code: ImportErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ImportError';
  }
}

const STATUS: Record<ImportErrorCode, HttpStatus> = {
  INVALID_URL: HttpStatus.BAD_REQUEST,
  BLOCKED_TARGET: HttpStatus.BAD_REQUEST,
  TIMEOUT: HttpStatus.GATEWAY_TIMEOUT,
  TOO_LARGE: HttpStatus.UNPROCESSABLE_ENTITY,
  UNSUPPORTED_CONTENT: HttpStatus.UNPROCESSABLE_ENTITY,
  NOT_A_PRODUCT: HttpStatus.UNPROCESSABLE_ENTITY,
  NOT_FOUND: HttpStatus.UNPROCESSABLE_ENTITY,
  TOO_MANY_REDIRECTS: HttpStatus.BAD_GATEWAY,
  NETWORK: HttpStatus.BAD_GATEWAY,
  UPSTREAM_STATUS: HttpStatus.BAD_GATEWAY,
};

const REASON: Partial<Record<HttpStatus, string>> = {
  [HttpStatus.BAD_REQUEST]: 'Bad Request',
  [HttpStatus.UNPROCESSABLE_ENTITY]: 'Unprocessable Entity',
  [HttpStatus.BAD_GATEWAY]: 'Bad Gateway',
  [HttpStatus.GATEWAY_TIMEOUT]: 'Gateway Timeout',
};

/**
 * Translates an importer failure into the HTTP exception the API answers with.
 * The body keeps Nest's standard shape (`statusCode`, `error`, `message`) and
 * adds the machine-readable `code`, namespaced as `IMPORT_<code>` because API
 * error codes share one namespace across modules (the UI translates them).
 */
export function toHttpException(error: ImportError): HttpException {
  const status = STATUS[error.code];
  return new HttpException({ statusCode: status, error: REASON[status] ?? 'Error', message: error.message, code: `IMPORT_${error.code}` }, status);
}
