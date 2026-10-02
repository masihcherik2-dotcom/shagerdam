import type { AuthTokens } from '../api/types';
import { isAuthTokens } from './session-core';

/**
 * Pure helpers of the e-mail code BFF routes (/api/session/email-otp/*).
 * Tokens and the signup ticket stay server-side; the browser learns only
 * whether it is signed in or has to confirm a mobile number.
 */

/** Header the backend reads the signup ticket from. */
export const EMAIL_SIGNUP_TICKET_HEADER = 'X-Email-Signup-Ticket';

/** Same shape as the backend's ticket check, so garbage never leaves the BFF. */
const TICKET_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

export const EMAIL_SIGNUP_EXPIRED = {
  statusCode: 401,
  error: 'Unauthorized',
  code: 'EMAIL_OTP_SIGNUP_EXPIRED',
  message: 'This step has expired. Request a new e-mail code.',
} as const;

export type EmailVerifyOutcome =
  | { kind: 'signed_in'; tokens: AuthTokens }
  | { kind: 'mobile_required'; ticket: string; email: string; expiresInSeconds: number }
  | { kind: 'invalid' };

/** Classifies a 200 answer of backend `auth/email-otp/verify`. */
export function readEmailVerify(body: unknown): EmailVerifyOutcome {
  if (typeof body !== 'object' || body === null) return { kind: 'invalid' };
  const value = body as { status?: unknown; tokens?: unknown; ticket?: unknown; email?: unknown; expiresInSeconds?: unknown };
  if (value.status === 'signed_in' && isAuthTokens(value.tokens)) {
    return { kind: 'signed_in', tokens: value.tokens };
  }
  if (
    value.status === 'mobile_required' &&
    isSignupTicket(value.ticket) &&
    typeof value.email === 'string' &&
    typeof value.expiresInSeconds === 'number' &&
    Number.isInteger(value.expiresInSeconds) &&
    value.expiresInSeconds > 0
  ) {
    return { kind: 'mobile_required', ticket: value.ticket, email: value.email, expiresInSeconds: value.expiresInSeconds };
  }
  return { kind: 'invalid' };
}

export function isSignupTicket(value: unknown): value is string {
  return typeof value === 'string' && TICKET_PATTERN.test(value);
}
