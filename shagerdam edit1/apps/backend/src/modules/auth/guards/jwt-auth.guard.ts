import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../../../common/decorators/public.decorator';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { TokenService } from '../token.service';

interface GuardedRequest {
  headers?: Record<string, string | string[] | undefined>;
  user?: AuthenticatedUser;
  method?: string;
  url?: string;
}

/**
 * Global authentication guard.
 *
 * Registered as an `APP_GUARD`, so **every** route requires a valid access token
 * unless it is explicitly marked `@Public()`. That default is the important part:
 * a new endpoint is protected the moment it is written, and forgetting a
 * decorator fails closed.
 *
 * The token is verified cryptographically by `TokenService`, and then the user is
 * re-read from PostgreSQL on every request. That one indexed lookup buys two
 * properties worth far more than the query costs:
 *
 *  - deactivating an account (`isActive = false`) takes effect immediately rather
 *    than after the access token expires;
 *  - a role change is honoured at once — an access token issued while the user was
 *    an ADMIN cannot be used to act as an ADMIN after the role was downgraded.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') {
      return true;
    }

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const request = context.switchToHttp().getRequest<GuardedRequest>();
    const token = extractBearerToken(request.headers?.authorization);

    if (isPublic === true) {
      // A public route may still carry a token (e.g. an authenticated client
      // hitting a shared endpoint); it is decoded but never required.
      if (token !== null) {
        const payload = await this.tryVerify(token);
        if (payload !== null) {
          request.user = await this.loadIdentity(payload.sub, payload.sid);
        }
      }
      return true;
    }

    if (token === null) {
      throw new UnauthorizedException('Missing bearer token');
    }

    const payload = await this.tokens.verifyAccessToken(token);
    request.user = await this.loadIdentity(payload.sub, payload.sid);
    return true;
  }

  private async tryVerify(token: string): Promise<{ sub: string; sid: string } | null> {
    try {
      const payload = await this.tokens.verifyAccessToken(token);
      return { sub: payload.sub, sid: payload.sid };
    } catch {
      return null;
    }
  }

  private async loadIdentity(userId: string, sessionId: string): Promise<AuthenticatedUser> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, mobile: true, role: true, isActive: true },
    });

    if (user === null) {
      throw new UnauthorizedException('Account no longer exists');
    }
    if (!user.isActive) {
      throw new ForbiddenException('This account is deactivated');
    }

    return { id: user.id, mobile: user.mobile, role: user.role, sessionId };
  }
}

/** Reads the bearer token from the `Authorization` header, if present. */
export function extractBearerToken(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== 'string') {
    return null;
  }
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match?.[1]?.trim() ?? null;
}
