import { createParamDecorator, InternalServerErrorException, type ExecutionContext } from '@nestjs/common';
import type { AuthenticatedUser } from '../types/authenticated-user';
import type { RequestContext } from '../types/request-context';

interface RequestWithIdentity {
  user?: AuthenticatedUser;
  ip?: string;
  headers?: Record<string, string | string[] | undefined>;
}

/**
 * Injects the authenticated user into a handler. Only usable on routes that are
 * not `@Public()`: reaching the handler without an identity means the guard
 * chain was misconfigured, which is a programming error, not a client error.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser => {
    const request = context.switchToHttp().getRequest<RequestWithIdentity>();
    if (!request.user) {
      throw new InternalServerErrorException(
        'Authenticated user is missing: this route must not be marked @Public()',
      );
    }
    return request.user;
  },
);

/**
 * Injects the transport facts an audit row needs (client IP and user agent).
 * Named `ClientContext` rather than `RequestContext` so it never collides with
 * the `RequestContext` type it returns. Always resolves: fields are `null` when
 * the information is unavailable, and a missing header never fails a request.
 */
export const ClientContext = createParamDecorator(
  (_data: unknown, context: ExecutionContext): RequestContext => {
    const request = context.switchToHttp().getRequest<RequestWithIdentity>();
    const forwarded = request.headers?.['x-forwarded-for'];
    const forwardedValue = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const userAgentHeader = request.headers?.['user-agent'];
    const userAgent = Array.isArray(userAgentHeader) ? userAgentHeader[0] : userAgentHeader;

    return {
      ipAddress: (forwardedValue?.split(',')[0]?.trim() || request.ip || '').slice(0, 45) || null,
      userAgent: userAgent?.slice(0, 512) ?? null,
    };
  },
);

/**
 * Injects the identity on a `@Public()` route when the caller sent a valid
 * access token, and `undefined` otherwise. Used by endpoints that serve guests
 * and signed-in users alike (the cart). On public routes `JwtAuthGuard` treats a
 * missing, invalid or expired token the same way — the caller is anonymous — so
 * a client whose access token lapsed keeps working with its guest cart token
 * until it refreshes the session.
 */
export const OptionalUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser | undefined =>
    context.switchToHttp().getRequest<RequestWithIdentity>().user,
);
