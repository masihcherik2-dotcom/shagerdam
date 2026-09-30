import type { ConfigService } from '@nestjs/config';
import { UserRole } from '@prisma/client';
import type { EnvironmentVariables } from '../../config/env.validation';
import type { RedisService } from '../../infra/redis/redis.service';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import type { RequestContext } from '../../common/types/request-context';
import type { AuditLogService } from '../audit/audit-log.service';
import type { SmsService } from '../sms/sms.service';
import type { UsersService, UserIdentity } from '../users/users.service';
import { TooManyRequestsException } from '../../common/exceptions/too-many-requests.exception';
import { hashPassword } from '../../infra/security/password';
import { AuthService, normalizeIdentifier } from './auth.service';
import { OtpVerifyResult } from './otp.service';
import type { OtpService } from './otp.service';
import type { TokenService, IssuedTokens } from './token.service';

const ENV: Partial<EnvironmentVariables> = {
  AUTH_MAX_LOGIN_ATTEMPTS: 5,
  AUTH_LOCK_SECONDS: 900,
};

/**
 * Minimal in-memory stand-in for the `ioredis` client, implementing exactly the
 * commands the auth services issue. Only the pieces the unit tests exercise are
 * modelled — the real Redis behaviour (TTLs, atomic Lua, rotation) is verified by
 * `test/auth.e2e-spec.ts` against an actual Redis instance.
 */
interface FakePipeline {
  incr: (key: string) => FakePipeline;
  expire: () => FakePipeline;
  exec: () => Promise<unknown>;
  del: () => Promise<number>;
  set: () => Promise<string>;
  hset: () => Promise<number>;
}

function fakeRedisClient(): Record<string, unknown> {
  const counters = new Map<string, number>();
  const chain: FakePipeline = {
    incr: (key: string): FakePipeline => {
      counters.set(key, (counters.get(key) ?? 0) + 1);
      return chain;
    },
    expire: (): FakePipeline => chain,
    exec: (): Promise<unknown> => Promise.resolve([[null, 1]]),
    del: (): Promise<number> => Promise.resolve(1),
    set: (): Promise<string> => Promise.resolve('OK'),
    hset: (): Promise<number> => Promise.resolve(1),
  };
  return {
    ttl: () => Promise.resolve(-2),
    del: () => Promise.resolve(1),
    get: () => Promise.resolve(null),
    set: () => Promise.resolve('OK'),
    keys: () => Promise.resolve([]),
    multi: () => chain,
  };
}

const configStub = (): ConfigService<EnvironmentVariables, true> =>
  ({ getOrThrow: (key: keyof EnvironmentVariables) => ENV[key] }) as unknown as ConfigService<EnvironmentVariables, true>;

const context: RequestContext = { ipAddress: '198.51.100.7', userAgent: 'jest-unit' };

const customerIdentity = (overrides: Partial<UserIdentity['user']> = {}): UserIdentity => ({
  user: {
    id: '11111111-1111-1111-1111-111111111111',
    mobile: '+989120000001',
    email: null,
    fullName: 'کاربر ۰۹۱۲۰۰۰۰۰۰۱',
    role: UserRole.CUSTOMER,
    isActive: true,
    nationalCode: null,
    lastLoginAt: null,
    createdAt: new Date('2026-09-26T10:00:00.000Z'),
    ...overrides,
  },
  customerProfile: { birthDate: null, gender: null, bankIban: null, defaultAddressId: null },
  vendor: null,
});

const issued: IssuedTokens = {
  accessToken: 'access.token.value',
  refreshToken: 'refresh.token.value',
  expiresIn: 900,
  refreshExpiresIn: 604_800,
  sessionId: '22222222-2222-2222-2222-222222222222',
};

interface Stubs {
  users?: Partial<UsersService>;
  otp?: Partial<OtpService>;
  tokens?: Partial<TokenService>;
  sms?: Partial<SmsService>;
  audit?: Partial<AuditLogService>;
}

const buildService = (stubs: Stubs = {}): AuthService =>
  new AuthService(
    {
      ensureCustomer: () => Promise.resolve(customerIdentity()),
      getIdentity: () => Promise.resolve(customerIdentity()),
      touchLastLogin: () => Promise.resolve(),
      findByIdentifier: () => Promise.resolve(null),
      updateProfile: () =>
        Promise.resolve({
          before: { fullName: 'old', email: null, nationalCode: null, birthDate: null },
          after: { fullName: 'new', email: null, nationalCode: null, birthDate: null },
          user: customerIdentity().user,
        }),
      ...stubs.users,
    } as unknown as UsersService,
    {
      verify: () => Promise.resolve(OtpVerifyResult.Match),
      createChallenge: () =>
        Promise.resolve({
          code: '48213',
          challenge: { mobile: '+989120000001', expiresInSeconds: 120, attemptsAllowed: 5 },
        }),
      clear: () => Promise.resolve(),
      lockRemainingSeconds: () => Promise.resolve(870),
      ...stubs.otp,
    } as unknown as OtpService,
    {
      issue: () => Promise.resolve(issued),
      rotate: () => Promise.resolve(issued),
      revoke: () => Promise.resolve(true),
      getSession: () => Promise.resolve(null),
      sessionIdOfRefreshToken: () => Promise.resolve('22222222-2222-2222-2222-222222222222'),
      ...stubs.tokens,
    } as unknown as TokenService,
    {
      sendOtp: () => Promise.resolve({ provider: 'sandbox', referenceId: 'SBX-1', segments: 1, status: 'sent' }),
      describe: () => ({ provider: 'sandbox', isTestProvider: true }),
      ...stubs.sms,
    } as unknown as SmsService,
    { record: () => Promise.resolve('audit-id'), ...stubs.audit } as unknown as AuditLogService,
    { client: fakeRedisClient() } as unknown as RedisService,
    configStub(),
  );

describe('AuthService.requestOtp', () => {
  it('returns the provider tracking id and the configured TTL', async () => {
    const service = buildService();

    await expect(service.requestOtp({ mobile: '+989120000001' }, context)).resolves.toEqual({
      status: 'sent',
      expiresInSeconds: 120,
      trackingId: 'SBX-1',
    });
  });

  it('surfaces a provider failure as a 503 and does not report success', async () => {
    const service = buildService({
      sms: {
        sendOtp: () => Promise.reject(new Error('gateway down')),
      } as unknown as Partial<SmsService>,
    });

    await expect(service.requestOtp({ mobile: '+989120000001' }, context)).rejects.toThrow('gateway down');
  });
});

describe('AuthService.verifyOtp', () => {
  it('issues tokens for a correct code and promotes an unknown number to a customer', async () => {
    const service = buildService();

    const result = await service.verifyOtp({ mobile: '+989120000001', code: '48213' }, context);

    expect(result.accessToken).toBe('access.token.value');
    expect(result.user.role).toBe(UserRole.CUSTOMER);
    expect(result.expiresIn).toBe(900);
    expect(result.sessionId).toBe(issued.sessionId);
  });

  it('maps an unknown or expired challenge to 401', async () => {
    const service = buildService({ otp: { verify: () => Promise.resolve(OtpVerifyResult.NotFound) } });

    await expect(service.verifyOtp({ mobile: '+989120000001', code: '00000' }, context)).rejects.toThrow(
      /expired or was already used/,
    );
  });

  it('maps a wrong code to 401', async () => {
    const service = buildService({ otp: { verify: () => Promise.resolve(OtpVerifyResult.Mismatch) } });

    await expect(service.verifyOtp({ mobile: '+989120000001', code: '00000' }, context)).rejects.toThrow(
      /Incorrect code/,
    );
  });

  it('maps an exhausted attempt budget to 429 with a retry hint', async () => {
    const service = buildService({ otp: { verify: () => Promise.resolve(OtpVerifyResult.Exhausted) } });

    await expect(service.verifyOtp({ mobile: '+989120000001', code: '00000' }, context)).rejects.toThrow(
      TooManyRequestsException,
    );
  });

  it('refuses a deactivated account even with a correct code', async () => {
    const service = buildService({
      users: { ensureCustomer: () => Promise.resolve(customerIdentity({ isActive: false })) },
    });

    await expect(service.verifyOtp({ mobile: '+989120000001', code: '48213' }, context)).rejects.toThrow(
      /deactivated/,
    );
  });

  it('writes a failed-login audit row for every rejected attempt', async () => {
    const record = jest.fn((): Promise<string> => Promise.resolve('audit-id'));
    const service = buildService({
      otp: { verify: () => Promise.resolve(OtpVerifyResult.Mismatch) },
      audit: { record } as unknown as Partial<AuditLogService>,
    });

    await expect(service.verifyOtp({ mobile: '+989120000001', code: '00000' }, context)).rejects.toThrow();

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'LOGIN',
        entityName: 'User',
        ipAddress: context.ipAddress,
        newValue: expect.objectContaining({ success: false, reason: 'otp_mismatch' }) as unknown,
      }),
    );
  });
});

describe('AuthService.loginWithPassword', () => {
  /** A real Argon2id hash, produced by the production helper. */
  let realHash: string;

  beforeAll(async () => {
    realHash = await hashPassword('the-correct-password-value');
  });

  it('rejects an unknown account with the same error as a wrong password', async () => {
    const service = buildService({ users: { findByIdentifier: () => Promise.resolve(null) } });

    await expect(
      service.loginWithPassword({ identifier: 'nobody@shopino.local', password: 'whatever-password' }, context),
    ).rejects.toThrow('Invalid credentials.');
  });

  it('refuses a deactivated account without revealing it in the message', async () => {
    const service = buildService({
      users: {
        findByIdentifier: () =>
          Promise.resolve({
            ...customerIdentity({ role: UserRole.ADMIN, isActive: false, email: 'admin@shopino.local' }),
            passwordHash: realHash,
          }),
      },
    });

    await expect(
      service.loginWithPassword({ identifier: 'admin@shopino.local', password: 'wrong-password-value' }, context),
    ).rejects.toThrow('Invalid credentials.');
  });
});

describe('AuthService.logout', () => {
  const actor: AuthenticatedUser = {
    id: '11111111-1111-1111-1111-111111111111',
    mobile: '+989120000001',
    role: UserRole.CUSTOMER,
    sessionId: '22222222-2222-2222-2222-222222222222',
  };

  it('revokes the current session', async () => {
    const revoke = jest.fn().mockResolvedValue(true);
    const service = buildService({ tokens: { revoke } as unknown as Partial<TokenService> });

    await expect(service.logout(actor)).resolves.toEqual({ revoked: true, sessionsRevoked: 1 });
    expect(revoke).toHaveBeenCalledWith(actor.sessionId);
  });

  it('ignores a refresh token that belongs to another user', async () => {
    const revoke = jest.fn().mockResolvedValue(true);
    const service = buildService({
      tokens: {
        revoke,
        getSession: () =>
          Promise.resolve({
            userId: '99999999-9999-9999-9999-999999999999',
            refreshTokenHash: 'x',
            createdAt: 'now',
            lastUsedAt: 'now',
            ipAddress: null,
            userAgent: null,
          }),
      } as unknown as Partial<TokenService>,
    });

    await expect(service.logout(actor, 'a.b.c')).resolves.toEqual({ revoked: true, sessionsRevoked: 1 });
    // Only the actor's own session was revoked.
    expect(revoke).toHaveBeenCalledTimes(1);
  });
});

describe('normalizeIdentifier', () => {
  it('collapses every mobile spelling to one bucket', () => {
    for (const value of ['09120000001', '+989120000001', '00989120000001', '۰۹۱۲۰۰۰۰۰۰۱']) {
      expect(normalizeIdentifier(value)).toBe('+989120000001');
    }
  });

  it('lower-cases and trims e-mail identifiers', () => {
    expect(normalizeIdentifier('  Admin@Shopino.Local ')).toBe('admin@shopino.local');
  });
});

describe('sandbox provider reporting', () => {
  it('reports the active provider honestly', () => {
    expect(buildService().smsProviderInfo()).toEqual({ provider: 'sandbox', isTestProvider: true });
  });
});
