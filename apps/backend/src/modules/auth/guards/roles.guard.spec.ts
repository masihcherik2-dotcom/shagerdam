import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { IS_PUBLIC_KEY } from '../../../common/decorators/public.decorator';
import { ROLES_KEY } from '../../../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user';
import { RolesGuard } from './roles.guard';

/**
 * Pure authorization logic, tested without HTTP: the guard only reads metadata
 * and the identity the authentication guard already resolved.
 */
const contextFor = (user?: AuthenticatedUser): ExecutionContext =>
  ({
    getType: () => 'http',
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  }) as unknown as ExecutionContext;

const actor = (role: UserRole): AuthenticatedUser => ({
  id: '11111111-1111-1111-1111-111111111111',
  mobile: '+989120000001',
  role,
  sessionId: '22222222-2222-2222-2222-222222222222',
});

/** Reflector stub that answers exactly the keys the guard asks for. */
const reflectorWith = (metadata: Record<string, unknown>): Reflector =>
  ({ getAllAndOverride: (key: string) => metadata[key] }) as unknown as Reflector;

describe('RolesGuard', () => {
  it('allows a route with no @Roles decorator for any authenticated user', () => {
    const guard = new RolesGuard(reflectorWith({}));

    for (const role of Object.values(UserRole)) {
      expect(guard.canActivate(contextFor(actor(role)))).toBe(true);
    }
  });

  it('allows a route when the actor holds one of the required roles', () => {
    const guard = new RolesGuard(reflectorWith({ [ROLES_KEY]: [UserRole.SUPER_ADMIN, UserRole.ADMIN] }));

    expect(guard.canActivate(contextFor(actor(UserRole.SUPER_ADMIN)))).toBe(true);
    expect(guard.canActivate(contextFor(actor(UserRole.ADMIN)))).toBe(true);
  });

  it('denies a route when the actor holds none of the required roles', () => {
    const guard = new RolesGuard(reflectorWith({ [ROLES_KEY]: [UserRole.SUPER_ADMIN] }));

    for (const role of [UserRole.CUSTOMER, UserRole.VENDOR, UserRole.SUPPORT, UserRole.FINANCIAL_OFFICER]) {
      expect(() => guard.canActivate(contextFor(actor(role)))).toThrow(ForbiddenException);
    }
  });

  it('denies a role-restricted route when no identity is present', () => {
    const guard = new RolesGuard(reflectorWith({ [ROLES_KEY]: [UserRole.CUSTOMER] }));

    expect(() => guard.canActivate(contextFor(undefined))).toThrow(ForbiddenException);
  });

  it('refuses a contradictory @Public + @Roles declaration instead of letting the weaker one win', () => {
    const guard = new RolesGuard(
      reflectorWith({ [ROLES_KEY]: [UserRole.CUSTOMER], [IS_PUBLIC_KEY]: true }),
    );

    expect(() => guard.canActivate(contextFor(actor(UserRole.SUPER_ADMIN)))).toThrow(ForbiddenException);
  });

  it('treats an empty role list as "no restriction"', () => {
    const guard = new RolesGuard(reflectorWith({ [ROLES_KEY]: [] }));
    expect(guard.canActivate(contextFor(actor(UserRole.CUSTOMER)))).toBe(true);
  });

  it('does not interfere with non-HTTP contexts', () => {
    const guard = new RolesGuard(reflectorWith({ [ROLES_KEY]: [UserRole.SUPER_ADMIN] }));
    const rpcContext = { getType: () => 'rpc' } as unknown as ExecutionContext;

    expect(guard.canActivate(rpcContext)).toBe(true);
  });
});
