import { ForbiddenException, UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { IS_PUBLIC_KEY } from '../../../common/decorators/public.decorator';
import type { PrismaService } from '../../../infra/prisma/prisma.service';
import { extractBearerToken, JwtAuthGuard } from './jwt-auth.guard';
import type { AccessTokenPayload, TokenService } from '../token.service';

interface FakeRequest {
  headers: Record<string, string | undefined>;
  user?: unknown;
}

const contextFor = (request: FakeRequest): ExecutionContext =>
  ({
    getType: () => 'http',
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => request }),
  }) as unknown as ExecutionContext;

const reflectorWith = (metadata: Record<string, unknown>): Reflector =>
  ({ getAllAndOverride: (key: string) => metadata[key] }) as unknown as Reflector;

const tokensWith = (payload: AccessTokenPayload | Error): TokenService =>
  ({
    verifyAccessToken: (): Promise<AccessTokenPayload> =>
      payload instanceof Error ? Promise.reject(payload) : Promise.resolve(payload),
  }) as unknown as TokenService;

const prismaWith = (user: { id: string; mobile: string; role: UserRole; isActive: boolean } | null): PrismaService =>
  ({ user: { findUnique: () => Promise.resolve(user) } }) as unknown as PrismaService;

const payload: AccessTokenPayload = {
  sub: '11111111-1111-1111-1111-111111111111',
  mobile: '+989120000001',
  role: UserRole.SUPER_ADMIN,
  typ: 'access',
  sid: '22222222-2222-2222-2222-222222222222',
  jti: '33333333-3333-3333-3333-333333333333',
};

describe('extractBearerToken', () => {
  it('reads a well-formed Authorization header case-insensitively', () => {
    expect(extractBearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(extractBearerToken('bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(extractBearerToken(['Bearer abc.def.ghi'])).toBe('abc.def.ghi');
  });

  it('returns null when the header is absent or not a bearer scheme', () => {
    expect(extractBearerToken(undefined)).toBeNull();
    expect(extractBearerToken('Basic dXNlcjpwYXNz')).toBeNull();
    expect(extractBearerToken('Bearer ')).toBeNull();
    expect(extractBearerToken('abc.def.ghi')).toBeNull();
  });
});

describe('JwtAuthGuard', () => {
  it('rejects a protected route without a token', async () => {
    const guard = new JwtAuthGuard(reflectorWith({}), tokensWith(payload), prismaWith(null));

    await expect(guard.canActivate(contextFor({ headers: {} }))).rejects.toThrow(UnauthorizedException);
  });

  it('rejects an invalid or expired token', async () => {
    const guard = new JwtAuthGuard(
      reflectorWith({}),
      tokensWith(new UnauthorizedException('Invalid or expired access token')),
      prismaWith(null),
    );

    await expect(
      guard.canActivate(contextFor({ headers: { authorization: 'Bearer broken.token.value' } })),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('attaches the identity read from the database, not the token claims', async () => {
    // The token says SUPER_ADMIN; the database says the role was downgraded.
    const guard = new JwtAuthGuard(
      reflectorWith({}),
      tokensWith(payload),
      prismaWith({ id: payload.sub, mobile: payload.mobile, role: UserRole.SUPPORT, isActive: true }),
    );
    const request: FakeRequest = { headers: { authorization: 'Bearer valid.token.value' } };

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    expect(request.user).toMatchObject({ role: UserRole.SUPPORT, sessionId: payload.sid });
  });

  it('refuses a deactivated account even with a valid token', async () => {
    const guard = new JwtAuthGuard(
      reflectorWith({}),
      tokensWith(payload),
      prismaWith({ id: payload.sub, mobile: payload.mobile, role: UserRole.SUPER_ADMIN, isActive: false }),
    );

    await expect(
      guard.canActivate(contextFor({ headers: { authorization: 'Bearer valid.token.value' } })),
    ).rejects.toThrow(ForbiddenException);
  });

  it('refuses a token whose account no longer exists', async () => {
    const guard = new JwtAuthGuard(reflectorWith({}), tokensWith(payload), prismaWith(null));

    await expect(
      guard.canActivate(contextFor({ headers: { authorization: 'Bearer valid.token.value' } })),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('lets a public route through without a token', async () => {
    const guard = new JwtAuthGuard(
      reflectorWith({ [IS_PUBLIC_KEY]: true }),
      tokensWith(new UnauthorizedException()),
      prismaWith(null),
    );
    const request: FakeRequest = { headers: {} };

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    expect(request.user).toBeUndefined();
  });

  it('populates the identity on a public route when a valid token is supplied', async () => {
    const guard = new JwtAuthGuard(
      reflectorWith({ [IS_PUBLIC_KEY]: true }),
      tokensWith(payload),
      prismaWith({ id: payload.sub, mobile: payload.mobile, role: UserRole.SUPER_ADMIN, isActive: true }),
    );
    const request: FakeRequest = { headers: { authorization: 'Bearer valid.token.value' } };

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    expect(request.user).toMatchObject({ id: payload.sub });
  });
});
