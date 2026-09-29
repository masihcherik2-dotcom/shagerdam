import { describe, expect, it } from 'vitest';

import { ApiError, toApiError, toApiErrorFromResponse } from './errors';

/** Minimal axios-like rejection, matching what axios actually produces. */
function axiosErrorWith(overrides: Record<string, unknown>): unknown {
  return {
    name: 'AxiosError',
    message: 'Request failed',
    isAxiosError: true,
    ...overrides,
  };
}

describe('toApiError', () => {
  it('maps a 4xx response to an http error and keeps the validation messages', () => {
    const error = toApiError(
      axiosErrorWith({
        code: 'ERR_BAD_REQUEST',
        response: {
          status: 400,
          data: {
            statusCode: 400,
            message: ['email must be an email', 'password is too short'],
            error: 'Bad Request',
          },
        },
      }),
    );

    expect(error).toBeInstanceOf(ApiError);
    expect(error.kind).toBe('http');
    expect(error.status).toBe(400);
    expect(error.code).toBe('Bad Request');
    expect(error.message).toBe('email must be an email، password is too short');
    expect(error.isClientError).toBe(true);
  });

  it('prefers the stable business code of actionable errors (409 INSUFFICIENT_STOCK…)', () => {
    const error = toApiError(
      axiosErrorWith({
        response: {
          status: 409,
          data: { statusCode: 409, error: 'Conflict', code: 'INSUFFICIENT_STOCK', message: 'Only 2 left', available: 2 },
        },
      }),
    );
    expect(error.code).toBe('INSUFFICIENT_STOCK');
    expect(error.details).toMatchObject({ available: 2 });
  });

  it('maps a 5xx response to a server error', () => {
    const error = toApiError(
      axiosErrorWith({
        code: 'ERR_BAD_RESPONSE',
        response: { status: 503, data: { statusCode: 503, message: 'Service Unavailable' } },
      }),
    );

    expect(error.kind).toBe('http');
    expect(error.isServerError).toBe(true);
    // English infrastructure messages are replaced by a Persian status text.
    expect(error.message).toBe('سرویس موقتاً در دسترس نیست.');
  });

  it('maps a missing response to a network error', () => {
    const error = toApiError(axiosErrorWith({ code: 'ERR_NETWORK' }));

    expect(error.kind).toBe('network');
    expect(error.message).toContain('ارتباط با سرور');
  });

  it('maps an aborted request to a timeout error', () => {
    const error = toApiError(axiosErrorWith({ code: 'ECONNABORTED' }));

    expect(error.kind).toBe('timeout');
  });

  it('returns the same instance when an ApiError is passed through', () => {
    const original = new ApiError('already mapped', { kind: 'unknown' });

    expect(toApiError(original)).toBe(original);
  });

  it('wraps an unexpected value as an unknown error', () => {
    const error = toApiError(new Error('boom'));

    expect(error.kind).toBe('unknown');
    expect(error.message).toBe('boom');
  });
});

describe('toApiErrorFromResponse', () => {
  it('uses a Persian backend message as-is and keeps the payload available as details', () => {
    const body = { statusCode: 503, message: 'پایگاه داده در دسترس نیست' };
    const error = toApiErrorFromResponse(new Response(JSON.stringify(body), { status: 503 }), body);

    expect(error.status).toBe(503);
    expect(error.message).toBe('پایگاه داده در دسترس نیست');
    expect(error.details).toEqual(body);
  });

  it('falls back to a generic message when the body carries none', () => {
    const error = toApiErrorFromResponse(new Response(null, { status: 502 }), undefined);

    expect(error.message).toBe('سرویس بیرونی پاسخ نداد؛ کمی بعد دوباره تلاش کنید.');
    expect(error.kind).toBe('http');
  });
});
