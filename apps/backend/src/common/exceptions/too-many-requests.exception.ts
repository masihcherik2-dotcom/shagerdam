import { HttpException, HttpStatus } from '@nestjs/common';

export interface TooManyRequestsBody {
  statusCode: number;
  error: string;
  message: string;
  /** Seconds the client should wait before retrying. Mirrored in `Retry-After`. */
  retryAfterSeconds: number;
}

/**
 * `429 Too Many Requests` with an explicit retry hint.
 *
 * Nest ships no dedicated class for this status (it exposes `429` only through
 * the generic `HttpException`), and a rate limit without a retry window is not
 * actionable for a client. Every limiter in the platform throws this type, so
 * the response body is identical everywhere: `message` for humans,
 * `retryAfterSeconds` for code.
 */
export class TooManyRequestsException extends HttpException {
  constructor(message: string, retryAfterSeconds: number) {
    const body: TooManyRequestsBody = {
      statusCode: HttpStatus.TOO_MANY_REQUESTS,
      error: 'TooManyRequests',
      message,
      retryAfterSeconds: Math.max(1, Math.ceil(retryAfterSeconds)),
    };
    super(body, HttpStatus.TOO_MANY_REQUESTS);
  }
}
