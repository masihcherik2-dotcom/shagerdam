import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { badRequestWith } from '../../common/http-errors';

/** Header carrying a guest cart's bearer token. */
export const CART_TOKEN_HEADER = 'x-cart-token';

/** 32 random bytes, base64url: 43 characters, 256 bits of entropy. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Guest carts are addressed by a random bearer token the server issues on the
 * first add. Only its SHA-256 digest is stored (`carts.session_token`), so a
 * database leak does not hand out usable cart tokens; knowing the digest is not
 * enough to act on the cart.
 */
export function issueCartToken(): { token: string; digest: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, digest: digestCartToken(token) };
}

export function digestCartToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Reads `X-Cart-Token`. Absent → `undefined`. Present but malformed → 400, so a
 * client bug is visible instead of silently starting a new empty cart.
 */
export const CartToken = createParamDecorator((_data: unknown, context: ExecutionContext): string | undefined => {
  const request = context.switchToHttp().getRequest<{ headers?: Record<string, string | string[] | undefined> }>();
  const raw = request.headers?.[CART_TOKEN_HEADER];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  if (value === undefined || value === '') {
    return undefined;
  }
  if (!TOKEN_PATTERN.test(value)) {
    throw badRequestWith('INVALID_CART_TOKEN', `${CART_TOKEN_HEADER} is malformed`);
  }
  return value;
});
