import { SetMetadata } from '@nestjs/common';
import type { UserRole } from '@prisma/client';

export const ROLES_KEY = 'shopino:roles';

/**
 * Restricts a route to the listed roles. Enforced by `RolesGuard`, which runs
 * after `JwtAuthGuard` so the actor's role is always the one signed into a
 * verified access token — never a value taken from the request body.
 *
 * A route without this decorator is open to every authenticated user.
 */
export const Roles = (...roles: UserRole[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, roles);
