import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { UserRole } from '@prisma/client';
import { ROLES_KEY } from '../../../common/decorators/roles.decorator';
import { IS_PUBLIC_KEY } from '../../../common/decorators/public.decorator';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user';

interface RequestWithIdentity {
  user?: AuthenticatedUser;
}

/**
 * Role-based access control, evaluated after {@link JwtAuthGuard}.
 *
 * It reads the role from `request.user`, which the authentication guard has
 * already replaced with the *current database value* — so this guard can never be
 * fooled by a stale claim inside an older token.
 *
 * Rules:
 * - a route without `@Roles(...)` is open to every authenticated user;
 * - a route with `@Roles(...)` requires the actor to hold one of them;
 * - `@Public()` routes are skipped entirely: they have no identity by design, and
 *   combining `@Public()` with `@Roles()` would be contradictory. `RolesGuard`
 *   therefore denies anything that reaches it without an identity **unless** the
 *   route is public, in which case the decorator combination is reported as a
 *   programming error at startup-time reasoning rather than a silent bypass.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') {
      return true;
    }

    const requiredRoles = this.reflector.getAllAndOverride<UserRole[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (requiredRoles === undefined || requiredRoles.length === 0) {
      return true;
    }

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic === true) {
      // Contradictory declaration: an endpoint cannot be both anonymous and
      // role-restricted. Deny rather than let the weaker annotation win.
      throw new ForbiddenException('This endpoint has a contradictory access declaration');
    }

    const request = context.switchToHttp().getRequest<RequestWithIdentity>();
    const actor = request.user;
    if (actor === undefined) {
      throw new ForbiddenException('Authentication is required for this resource');
    }

    if (!requiredRoles.includes(actor.role)) {
      throw new ForbiddenException(
        `This action requires one of the following roles: ${requiredRoles.join(', ')}`,
      );
    }

    return true;
  }
}
