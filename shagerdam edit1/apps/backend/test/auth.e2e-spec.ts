import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { UserRole } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { GLOBAL_API_PREFIX } from '../src/common/constants';
import { applyGlobalPolicies, buildOpenApiDocument } from '../src/setup/app.setup';
import { PrismaService } from '../src/infra/prisma/prisma.service';
import { RedisService } from '../src/infra/redis/redis.service';
import { SMS_PROVIDER, type SmsProvider } from '../src/modules/sms/sms-provider.interface';
import { SandboxSmsProvider } from '../src/modules/sms/providers/sandbox-sms.provider';
import { OtpKeys } from '../src/modules/auth/otp.service';
import { loginAttemptsKey, loginLockKey } from '../src/modules/auth/token.service';
import { normalizeIdentifier } from '../src/modules/auth/auth.service';

/**
 * End-to-end verification of the whole authentication surface against the **real**
 * infrastructure started by docker-compose: PostgreSQL 16, Redis 7 and the active
 * SMS provider. Nothing is mocked or stubbed — the OTP is read back from the
 * sandbox provider exactly as a user would read it from their phone, and every
 * assertion about tokens, sessions and locks is checked against Redis or
 * PostgreSQL directly.
 *
 * The suite is self-contained: it uses dedicated phone numbers, tags its requests
 * with a test user-agent, and removes every row it created in `afterAll`, so the
 * seeded master data (and the counts asserted by the other e2e suites) stay
 * untouched.
 */

const API = `/${GLOBAL_API_PREFIX}`;
const TEST_UA = 'shopino-e2e/1.0';
const env = process.env;

/** Phone numbers reserved for this suite (never part of the seed). */
const NEW_CUSTOMER = '+989990000001';
const BRUTE_FORCE_VICTIM = '+989990000002';
const NORMALIZATION_SUBJECT = '+989990000003';
const TEST_MOBILES = [NEW_CUSTOMER, BRUTE_FORCE_VICTIM, NORMALIZATION_SUBJECT];

/** Mobile of the seeded super admin, stored in canonical E.164. */
const SEEDED_ADMIN_MOBILE = '+989120000001';
const SEEDED_ADMIN_EMAIL = 'admin@shopino.local';
const SEEDED_SUPPORT_EMAIL = 'support@shopino.local';
/** Identifier that deliberately matches no account (enumeration-resistance test). */
const UNKNOWN_IDENTIFIER = 'nobody@shopino.local';

/**
 * Every identifier this suite logs in with. The per-identifier failure counter
 * lives in Redis with a 15-minute TTL, so it has to be cleared for *all* of them
 * — otherwise the fifth run of the suite would find the account already locked
 * and the assertions would fail for the wrong reason.
 */
const LOGIN_IDENTIFIERS = [
  SEEDED_ADMIN_EMAIL,
  SEEDED_ADMIN_MOBILE,
  SEEDED_SUPPORT_EMAIL,
  UNKNOWN_IDENTIFIER,
];

interface TokensBody {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  refreshExpiresIn: number;
  sessionId: string;
  user: { id: string; mobile: string; role: UserRole; fullName: string };
}

interface OtpRequestBody {
  status: string;
  expiresInSeconds: number;
  trackingId: string;
}

interface AccessTokenClaims {
  sub: string;
  mobile: string;
  role: UserRole;
  typ: string;
  sid: string;
}

describe('Authentication pipeline (e2e, real PostgreSQL + Redis + SMS provider)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let redis: RedisService;
  let jwt: JwtService;
  let smsProvider: SandboxSmsProvider;

  const request = (options: {
    method: 'GET' | 'POST' | 'PATCH';
    url: string;
    body?: unknown;
    token?: string;
    userAgent?: string;
  }): ReturnType<NestFastifyApplication['inject']> =>
    app.inject({
      method: options.method,
      url: `${API}${options.url}`,
      headers: {
        'user-agent': options.userAgent ?? TEST_UA,
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      },
      ...(options.body === undefined ? {} : { payload: options.body as Record<string, unknown> }),
    });

  /**
   * Clears every Redis key this suite can produce, so the suite is deterministic
   * on a re-run. A second run must not inherit the first run's cooldown, lock or
   * hourly quotas — and the lock that the brute-force test deliberately triggers
   * has to be gone before the profile tests run.
   *
   * Test-only housekeeping: production never deletes rate-limit state.
   */
  const resetAuthState = async (): Promise<void> => {
    const keys = [
      ...TEST_MOBILES.flatMap((mobile) => [
        OtpKeys.challenge(mobile),
        OtpKeys.lock(mobile),
        OtpKeys.cooldown(mobile),
        OtpKeys.hourlyByMobile(mobile),
        loginAttemptsKey(normalizeIdentifier(mobile)),
        loginLockKey(normalizeIdentifier(mobile)),
      ]),
      ...LOGIN_IDENTIFIERS.flatMap((identifier) => [
        loginAttemptsKey(normalizeIdentifier(identifier)),
        loginLockKey(normalizeIdentifier(identifier)),
      ]),
      // Every request in this suite shares one source IP, so the per-IP quota
      // would otherwise accumulate across runs.
      ...(await redis.client.keys('auth:otp:hourly:ip:*')),
    ];

    if (keys.length > 0) {
      await redis.client.del(...keys);
    }
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());

    const config = app.get(ConfigService);
    applyGlobalPolicies(app, config);

    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    prisma = app.get(PrismaService);
    redis = app.get(RedisService);
    jwt = app.get(JwtService);

    // The provider is resolved through the same DI token the application uses, so
    // this is the exact instance that served the requests below.
    const provider: SmsProvider = app.get<SmsProvider>(SMS_PROVIDER);
    if (!(provider instanceof SandboxSmsProvider)) {
      throw new Error(
        `This suite requires SMS_PROVIDER=sandbox (got "${provider.kind}"). ` +
          'Point the test environment at the sandbox provider before running it.',
      );
    }
    smsProvider = provider;

    await resetAuthState();
  });

  afterAll(async () => {
    // Remove everything this suite created. Production code has no such path —
    // this is test isolation so the other suites see the seeded state.
    await prisma.user.deleteMany({ where: { mobile: { in: TEST_MOBILES } } });
    await prisma.auditLog.deleteMany({ where: { userAgent: TEST_UA } });
    await resetAuthState();
    await app.close();
  });

  // ─── 1. OTP pipeline ──────────────────────────────────────────────────────

  describe('OTP pipeline: request → Redis TTL → provider dispatch → verify → JWT', () => {
    let deliveredCode: string;
    let trackingId: string;

    it('accepts the request, reports the TTL and a tracking id', async () => {
      const response = await request({
        method: 'POST',
        url: '/auth/otp/request',
        body: { mobile: NEW_CUSTOMER },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json<OtpRequestBody>();

      expect(body.status).toBe('sent');
      expect(body.expiresInSeconds).toBe(Number(env.OTP_TTL_SECONDS ?? 120));
      // The tracking id comes from the provider, proving the message really went
      // through the dispatch layer instead of being faked at the controller.
      expect(body.trackingId).toMatch(/^SBX-/);
      trackingId = body.trackingId;
    });

    it('stores the challenge in Redis with the configured TTL', async () => {
      const ttl = await redis.client.ttl(OtpKeys.challenge(NEW_CUSTOMER));
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(Number(env.OTP_TTL_SECONDS ?? 120));

      const stored = await redis.client.hgetall(OtpKeys.challenge(NEW_CUSTOMER));
      expect(stored.purpose).toBe('login');
      expect(stored.attempts).toBe('0');
      // Only a digest is stored: the code itself must never be readable in Redis.
      expect(stored.codeHash).toMatch(/^[0-9a-f]{64}$/);
      expect(Object.keys(stored)).not.toContain('code');
    });

    it('dispatches the code through the active SMS provider', () => {
      const code = smsProvider.latestOtpCode(NEW_CUSTOMER);
      expect(code).toBeDefined();
      expect(code).toMatch(/^[0-9]{5}$/);

      deliveredCode = code as string;
      expect(trackingId).toMatch(/^SBX-/);
    });

    it('rejects a wrong code with 401 and keeps the challenge alive', async () => {
      const wrong = deliveredCode === '00000' ? '11111' : '00000';
      const response = await request({
        method: 'POST',
        url: '/auth/otp/verify',
        body: { mobile: NEW_CUSTOMER, code: wrong },
      });

      expect(response.statusCode).toBe(401);
      expect(await redis.client.ttl(OtpKeys.challenge(NEW_CUSTOMER))).toBeGreaterThan(0);
    });

    it('verifies the real code and returns usable JWT tokens', async () => {
      const response = await request({
        method: 'POST',
        url: '/auth/otp/verify',
        body: { mobile: NEW_CUSTOMER, code: deliveredCode },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json<TokensBody>();

      expect(body.user.mobile).toBe(NEW_CUSTOMER);
      expect(body.user.role).toBe(UserRole.CUSTOMER);
      expect(body.accessToken.split('.')).toHaveLength(3);
      expect(body.expiresIn).toBe(900);
      expect(body.refreshExpiresIn).toBe(604_800);

      // The signature is verified with the real secret, so a token that merely
      // "looks like" a JWT would fail here.
      const claims = await jwt.verifyAsync<AccessTokenClaims>(body.accessToken, {
        secret: env.JWT_ACCESS_SECRET as string,
        issuer: 'shopino',
        audience: 'shopino-api',
      });
      expect(claims.role).toBe(UserRole.CUSTOMER);
      expect(claims.mobile).toBe(NEW_CUSTOMER);
      expect(claims.typ).toBe('access');
      expect(claims.sid).toBe(body.sessionId);

      // A refresh token must not be usable as an access token.
      await expect(
        jwt.verifyAsync(body.refreshToken, {
          secret: env.JWT_ACCESS_SECRET as string,
          issuer: 'shopino',
          audience: 'shopino-api',
        }),
      ).rejects.toThrow();
    });

    it('consumed the challenge: the same code cannot be used twice', async () => {
      expect(await redis.client.exists(OtpKeys.challenge(NEW_CUSTOMER))).toBe(0);

      const replay = await request({
        method: 'POST',
        url: '/auth/otp/verify',
        body: { mobile: NEW_CUSTOMER, code: deliveredCode },
      });
      expect(replay.statusCode).toBe(401);
    });

    it('created the customer with an empty profile in PostgreSQL', async () => {
      const user = await prisma.user.findUnique({
        where: { mobile: NEW_CUSTOMER },
        include: { customerProfile: true },
      });

      expect(user).not.toBeNull();
      expect(user?.role).toBe(UserRole.CUSTOMER);
      expect(user?.isActive).toBe(true);
      expect(user?.passwordHash).toBeNull();
      expect(user?.customerProfile).not.toBeNull();
      // No fabricated financial data: a brand-new customer owns nothing.
      expect(user?.customerProfile?.bankIban).toBeNull();
      expect(await prisma.creditAccount.count({ where: { userId: user?.id } })).toBe(0);
      expect(await prisma.parentOrder.count({ where: { userId: user?.id } })).toBe(0);
    });
  });

  // ─── 2. Rate limiting ─────────────────────────────────────────────────────

  describe('Brute-force protection', () => {
    it('enforces the cooldown between two consecutive OTP requests', async () => {
      const response = await request({
        method: 'POST',
        url: '/auth/otp/request',
        body: { mobile: NEW_CUSTOMER },
      });

      expect(response.statusCode).toBe(429);
      const body = response.json<{ message: string; retryAfterSeconds: number }>();
      expect(body.retryAfterSeconds).toBeGreaterThan(0);
      expect(body.retryAfterSeconds).toBeLessThanOrEqual(Number(env.OTP_REQUEST_COOLDOWN_SECONDS ?? 120));
      expect(response.headers['retry-after']).toBeUndefined(); // body carries the hint
    });

    it('locks the number after five wrong codes and refuses the correct one too', async () => {
      const request1 = await request({
        method: 'POST',
        url: '/auth/otp/request',
        body: { mobile: BRUTE_FORCE_VICTIM },
      });
      expect(request1.statusCode).toBe(200);

      const realCode = smsProvider.latestOtpCode(BRUTE_FORCE_VICTIM) as string;
      const wrongCode = realCode === '11111' ? '22222' : '11111';

      // Attempts 1..4 → 401 (wrong code, budget remains).
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        const response = await request({
          method: 'POST',
          url: '/auth/otp/verify',
          body: { mobile: BRUTE_FORCE_VICTIM, code: wrongCode },
        });
        expect(response.statusCode).toBe(401);
      }

      // Attempt 5 → the budget is exhausted, the number is locked.
      const fifth = await request({
        method: 'POST',
        url: '/auth/otp/verify',
        body: { mobile: BRUTE_FORCE_VICTIM, code: wrongCode },
      });
      expect(fifth.statusCode).toBe(429);
      const lockBody = fifth.json<{ retryAfterSeconds: number }>();
      expect(lockBody.retryAfterSeconds).toBeGreaterThan(0);
      expect(lockBody.retryAfterSeconds).toBeLessThanOrEqual(Number(env.OTP_LOCK_SECONDS ?? 900));

      // The lock is real: even the correct code is refused while it lasts.
      const correctWhileLocked = await request({
        method: 'POST',
        url: '/auth/otp/verify',
        body: { mobile: BRUTE_FORCE_VICTIM, code: realCode },
      });
      expect(correctWhileLocked.statusCode).toBe(429);

      // …and no account was created for the attacked number.
      expect(await prisma.user.findUnique({ where: { mobile: BRUTE_FORCE_VICTIM } })).toBeNull();
    });

    it('records failed attempts in the audit trail without leaking the code', async () => {
      const rows = await prisma.auditLog.findMany({
        where: { userAgent: TEST_UA, action: 'LOGIN', newValue: { path: ['success'], equals: false } },
        orderBy: { createdAt: 'desc' },
      });

      expect(rows.length).toBeGreaterThanOrEqual(5);
      const reasons = rows.map((row) => (row.newValue as { reason?: string }).reason);
      expect(reasons).toContain('otp_mismatch');
      expect(reasons).toContain('otp_attempts_exhausted');

      for (const row of rows) {
        const serialized = JSON.stringify(row.newValue);
        expect(serialized).not.toContain('11111');
        expect(serialized).not.toContain('22222');
      }
    });
  });

  // ─── 3. Normalization & validation ────────────────────────────────────────

  describe('Input normalization and validation', () => {
    it('accepts a national-format mobile and stores it as E.164', async () => {
      const national = '09990000003';
      const response = await request({
        method: 'POST',
        url: '/auth/otp/request',
        body: { mobile: national },
      });

      expect(response.statusCode).toBe(200);
      // The Redis key proves the mobile was normalized before use.
      expect(await redis.client.exists(OtpKeys.challenge(NORMALIZATION_SUBJECT))).toBe(1);
      expect(await redis.client.exists(OtpKeys.challenge(national))).toBe(0);
    });

    it('rejects a non-Iranian mobile number with 400', async () => {
      const response = await request({
        method: 'POST',
        url: '/auth/otp/request',
        body: { mobile: '12345' },
      });

      expect(response.statusCode).toBe(400);
    });

    it('requires a numeric code', async () => {
      const response = await request({
        method: 'POST',
        url: '/auth/otp/verify',
        body: { mobile: NEW_CUSTOMER, code: 'abcde' },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  // ─── 4. Password login ────────────────────────────────────────────────────

  describe('Password login for staff', () => {
    let adminTokens: TokensBody;

    it('authenticates the seeded super admin by e-mail', async () => {
      const response = await request({
        method: 'POST',
        url: '/auth/login/password',
        body: { identifier: SEEDED_ADMIN_EMAIL, password: env.SUPER_ADMIN_PASSWORD },
      });

      expect(response.statusCode).toBe(200);
      adminTokens = response.json<TokensBody>();

      expect(adminTokens.user.role).toBe(UserRole.SUPER_ADMIN);
      expect(adminTokens.user.mobile).toBe(SEEDED_ADMIN_MOBILE);
      expect(adminTokens.accessToken).toMatch(/^ey/);
    });

    it('authenticates the same account by mobile number', async () => {
      const response = await request({
        method: 'POST',
        url: '/auth/login/password',
        body: { identifier: SEEDED_ADMIN_MOBILE, password: env.SUPER_ADMIN_PASSWORD },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json<TokensBody>().user.role).toBe(UserRole.SUPER_ADMIN);
    });

    it('rejects a wrong password with 401 and writes a failed-login audit row', async () => {
      const response = await request({
        method: 'POST',
        url: '/auth/login/password',
        body: { identifier: SEEDED_ADMIN_EMAIL, password: 'definitely-not-the-password' },
      });

      expect(response.statusCode).toBe(401);

      const row = await prisma.auditLog.findFirst({
        where: { userAgent: TEST_UA, action: 'LOGIN', entityName: 'User' },
        orderBy: { createdAt: 'desc' },
      });
      expect(row).not.toBeNull();
      expect((row?.newValue as { reason?: string }).reason).toBe('bad_credentials');
      // The attempted password must never be stored.
      expect(JSON.stringify(row?.newValue)).not.toContain('definitely-not-the-password');
    });

    it('answers unknown accounts and wrong passwords with the same error', async () => {
      const unknown = await request({
        method: 'POST',
        url: '/auth/login/password',
        body: { identifier: UNKNOWN_IDENTIFIER, password: 'definitely-not-the-password' },
      });
      const wrongPassword = await request({
        method: 'POST',
        url: '/auth/login/password',
        body: { identifier: SEEDED_ADMIN_EMAIL, password: 'yet-another-wrong-password' },
      });

      expect(unknown.statusCode).toBe(wrongPassword.statusCode);
      expect(unknown.json<{ message: string }>().message).toBe(
        wrongPassword.json<{ message: string }>().message,
      );
    });

    it('serves the authenticated profile with the access token', async () => {
      const response = await request({ method: 'GET', url: '/auth/me', token: adminTokens.accessToken });

      expect(response.statusCode).toBe(200);
      const body = response.json<{ user: { id: string; role: UserRole }; customerProfile: unknown }>();
      expect(body.user.role).toBe(UserRole.SUPER_ADMIN);
      expect(body).toHaveProperty('customerProfile');
    });

    it('rejects a request without a token with 401', async () => {
      const response = await request({ method: 'GET', url: '/auth/me' });
      expect(response.statusCode).toBe(401);
    });

    it('rejects a tampered token with 401', async () => {
      const [header, payload, signature] = adminTokens.accessToken.split('.');
      const tampered = `${header}.${payload}.${(signature ?? '').slice(0, -2)}xx`;

      const response = await request({ method: 'GET', url: '/auth/me', token: tampered });
      expect(response.statusCode).toBe(401);
    });
  });

  // ─── 5. RBAC ──────────────────────────────────────────────────────────────

  describe('Role-based access control', () => {
    const login = async (identifier: string, passwordEnvKey: string): Promise<string> => {
      const response = await request({
        method: 'POST',
        url: '/auth/login/password',
        body: { identifier, password: env[passwordEnvKey] },
      });
      expect(response.statusCode).toBe(200);
      return response.json<TokensBody>().accessToken;
    };

    it('gives a CUSTOMER 403 on a SUPER_ADMIN-only route', async () => {
      // A genuinely unprivileged token, issued by the OTP flow for a fresh number.
      await redis.client.del(OtpKeys.cooldown(NORMALIZATION_SUBJECT));
      const otpRequest = await request({
        method: 'POST',
        url: '/auth/otp/request',
        body: { mobile: NORMALIZATION_SUBJECT },
      });
      expect(otpRequest.statusCode).toBe(200);

      const code = smsProvider.latestOtpCode(NORMALIZATION_SUBJECT) as string;
      const verified = await request({
        method: 'POST',
        url: '/auth/otp/verify',
        body: { mobile: NORMALIZATION_SUBJECT, code },
      });
      expect(verified.statusCode).toBe(200);

      const customerAccessToken = verified.json<TokensBody>().accessToken;
      const claims = await jwt.verifyAsync<AccessTokenClaims>(customerAccessToken, {
        secret: env.JWT_ACCESS_SECRET as string,
        issuer: 'shopino',
        audience: 'shopino-api',
      });
      expect(claims.role).toBe('CUSTOMER');

      const forbidden = await request({
        method: 'GET',
        url: '/admin/users',
        token: customerAccessToken,
      });
      expect(forbidden.statusCode).toBe(403);

      // The same route with a real SUPER_ADMIN token returns data, so the 403
      // above is authorization, not a broken endpoint.
      const adminToken = await login(SEEDED_ADMIN_EMAIL, 'SUPER_ADMIN_PASSWORD');
      const allowed = await request({ method: 'GET', url: '/admin/users', token: adminToken });
      expect(allowed.statusCode).toBe(200);
      expect(allowed.json<{ total: number }>().total).toBeGreaterThanOrEqual(4);
    });

    it('lets SUPPORT read a single user but not enumerate them', async () => {
      const supportToken = await login(SEEDED_SUPPORT_EMAIL, 'SEED_STAFF_PASSWORD');

      const list = await request({ method: 'GET', url: '/admin/users', token: supportToken });
      expect(list.statusCode).toBe(403);

      const adminToken = await login(SEEDED_ADMIN_EMAIL, 'SUPER_ADMIN_PASSWORD');
      const adminId = (await request({ method: 'GET', url: '/auth/me', token: adminToken }).then((r) =>
        r.json<{ user: { id: string } }>(),
      )).user.id;

      const detail = await request({ method: 'GET', url: `/admin/users/${adminId}`, token: supportToken });
      expect(detail.statusCode).toBe(200);
      expect(detail.json<{ role: UserRole }>().role).toBe(UserRole.SUPER_ADMIN);
    });

    it('rejects the audit-log route for a SUPPORT token with 403', async () => {
      const supportToken = await login(SEEDED_SUPPORT_EMAIL, 'SEED_STAFF_PASSWORD');
      const response = await request({ method: 'GET', url: '/admin/audit-logs', token: supportToken });

      expect(response.statusCode).toBe(403);
    });
  });

  // ─── 6. Refresh rotation & logout ─────────────────────────────────────────

  describe('Refresh rotation, replay detection and logout', () => {
    let tokens: TokensBody;

    beforeAll(async () => {
      const response = await request({
        method: 'POST',
        url: '/auth/login/password',
        body: { identifier: SEEDED_ADMIN_EMAIL, password: env.SUPER_ADMIN_PASSWORD },
      });
      tokens = response.json<TokensBody>();
    });

    it('rotates the refresh token and issues a new pair', async () => {
      const response = await request({
        method: 'POST',
        url: '/auth/refresh',
        body: { refreshToken: tokens.refreshToken },
      });

      expect(response.statusCode).toBe(200);
      const rotated = response.json<TokensBody>();

      expect(rotated.refreshToken).not.toBe(tokens.refreshToken);
      expect(rotated.sessionId).not.toBe(tokens.sessionId);

      // The new access token works.
      const me = await request({ method: 'GET', url: '/auth/me', token: rotated.accessToken });
      expect(me.statusCode).toBe(200);

      tokens = rotated;
    });

    it('rejects the previously used refresh token (replay detection)', async () => {
      const first = await request({
        method: 'POST',
        url: '/auth/refresh',
        body: { refreshToken: tokens.refreshToken },
      });
      expect(first.statusCode).toBe(200);
      const second = first.json<TokensBody>();

      const replay = await request({
        method: 'POST',
        url: '/auth/refresh',
        body: { refreshToken: tokens.refreshToken },
      });
      expect(replay.statusCode).toBe(401);

      tokens = second;
    });

    it('revokes the session on logout', async () => {
      const response = await request({
        method: 'POST',
        url: '/auth/logout',
        token: tokens.accessToken,
        body: { refreshToken: tokens.refreshToken },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json<{ revoked: boolean; sessionsRevoked: number }>().revoked).toBe(true);

      // The session is gone from Redis…
      expect(await redis.client.exists(`auth:session:${tokens.sessionId}`)).toBe(0);

      // …so the refresh token cannot mint new access tokens any more.
      const refreshAfterLogout = await request({
        method: 'POST',
        url: '/auth/refresh',
        body: { refreshToken: tokens.refreshToken },
      });
      expect(refreshAfterLogout.statusCode).toBe(401);
    });
  });

  // ─── 7. Profile update + audit trail ──────────────────────────────────────

  describe('Profile management and the audit trail', () => {
    let customerToken: string;
    let customerId: string;

    beforeAll(async () => {
      await redis.client.del(OtpKeys.cooldown(NEW_CUSTOMER));
      const otp = await request({ method: 'POST', url: '/auth/otp/request', body: { mobile: NEW_CUSTOMER } });
      expect(otp.statusCode).toBe(200);

      const code = smsProvider.latestOtpCode(NEW_CUSTOMER) as string;
      const verified = await request({
        method: 'POST',
        url: '/auth/otp/verify',
        body: { mobile: NEW_CUSTOMER, code },
      });
      expect(verified.statusCode).toBe(200);

      const body = verified.json<TokensBody>();
      customerToken = body.accessToken;
      customerId = body.user.id;
    });

    it('rejects a national code with an invalid check digit', async () => {
      const response = await request({
        method: 'PATCH',
        url: '/auth/profile',
        token: customerToken,
        body: { nationalCode: '0499370898' },
      });

      expect(response.statusCode).toBe(400);
      expect(await prisma.user.findUnique({ where: { id: customerId } })).toMatchObject({
        nationalCode: null,
      });
    });

    it('updates the profile and records a before/after audit row', async () => {
      const payload = {
        fullName: 'سارا محمدی',
        email: 'sara.e2e@example.com',
        nationalCode: '0499370899',
        birthDate: '1994-05-17',
      };

      const response = await request({
        method: 'PATCH',
        url: '/auth/profile',
        token: customerToken,
        body: payload,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json<{ updated: boolean }>().updated).toBe(true);

      // The row is written before the response is emitted, so it must be there now.
      const row = await prisma.auditLog.findFirst({
        where: { userAgent: TEST_UA, action: 'UPDATE', entityName: 'User', entityId: customerId },
        orderBy: { createdAt: 'desc' },
      });

      expect(row).not.toBeNull();
      expect(row?.userId).toBe(customerId);
      expect(row?.ipAddress).toBeTruthy();

      const oldValue = row?.oldValue as { fullName?: string; nationalCode?: string | null };
      const newValue = row?.newValue as {
        request?: Record<string, unknown>;
        result?: Record<string, unknown>;
      };
      expect(oldValue.fullName).not.toBe(payload.fullName);
      expect(newValue.result).toMatchObject({ fullName: payload.fullName, nationalCode: payload.nationalCode });
    });

    it('persists the change in PostgreSQL', async () => {
      const user = await prisma.user.findUnique({
        where: { id: customerId },
        include: { customerProfile: true },
      });

      expect(user?.fullName).toBe('سارا محمدی');
      expect(user?.email).toBe('sara.e2e@example.com');
      expect(user?.nationalCode).toBe('0499370899');
      expect(user?.customerProfile?.birthDate?.toISOString().slice(0, 10)).toBe('1994-05-17');
    });

    it('exposes the trail through the admin endpoint, and only to admins', async () => {
      const admin = await request({
        method: 'POST',
        url: '/auth/login/password',
        body: { identifier: SEEDED_ADMIN_EMAIL, password: env.SUPER_ADMIN_PASSWORD },
      });
      const adminToken = admin.json<TokensBody>().accessToken;

      const response = await request({
        method: 'GET',
        url: `/admin/audit-logs?entityName=User&entityId=${customerId}&action=UPDATE`,
        token: adminToken,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json<{ items: Array<{ entityId: string; oldValue: unknown }>; total: number }>();
      expect(body.total).toBeGreaterThanOrEqual(1);
      expect(body.items[0]?.entityId).toBe(customerId);
      expect(body.items[0]?.oldValue).toBeTruthy();

      const asCustomer = await request({
        method: 'GET',
        url: '/admin/audit-logs',
        token: customerToken,
      });
      expect(asCustomer.statusCode).toBe(403);
    });
  });

  // ─── 8. API contract ──────────────────────────────────────────────────────

  describe('OpenAPI contract', () => {
    it('documents every auth endpoint with its bearer requirement', () => {
      const document = buildOpenApiDocument(app);

      const expectedPaths = [
        `${API}/auth/otp/request`,
        `${API}/auth/otp/verify`,
        `${API}/auth/login/password`,
        `${API}/auth/refresh`,
        `${API}/auth/logout`,
        `${API}/auth/me`,
        `${API}/auth/profile`,
        `${API}/admin/audit-logs`,
        `${API}/admin/users`,
      ];
      for (const path of expectedPaths) {
        expect(Object.keys(document.paths)).toContain(path);
      }

      expect(document.paths[`${API}/auth/otp/request`]?.post?.summary).toBeTruthy();
      expect(document.paths[`${API}/auth/otp/request`]?.post?.responses['200']).toBeDefined();
      expect(document.paths[`${API}/auth/otp/request`]?.post?.responses['429']).toBeDefined();
      expect(document.paths[`${API}/auth/logout`]?.post?.security).toBeDefined();
      expect(document.components?.securitySchemes).toHaveProperty('access-token');
    });
  });
});
