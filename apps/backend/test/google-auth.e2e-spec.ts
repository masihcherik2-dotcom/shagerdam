import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ConfigService } from '@nestjs/config';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { UserRole } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { GLOBAL_API_PREFIX } from '../src/common/constants';
import type { EnvironmentVariables } from '../src/config/env.validation';
import { PrismaService } from '../src/infra/prisma/prisma.service';
import { RedisService } from '../src/infra/redis/redis.service';
import { OtpKeys } from '../src/modules/auth/otp.service';
import { GOOGLE_SIGNUP_TICKET_HEADER } from '../src/modules/auth/google/dto/google-auth.dto';
import { GoogleKeys } from '../src/modules/auth/google/google-auth.service';
import { GOOGLE_OAUTH_ENDPOINTS, GoogleOAuthClient, type GoogleOAuthEndpoints } from '../src/modules/auth/google/google-oauth.client';
import { SMS_PROVIDER, type SmsProvider } from '../src/modules/sms/sms-provider.interface';
import type { SandboxSmsProvider } from '../src/modules/sms/providers/sandbox-sms.provider';
import { applyGlobalPolicies } from '../src/setup/app.setup';

/**
 * Sign-in with Google, end to end against the real stack (PostgreSQL, Redis,
 * token service, OTP, audit).
 *
 * Google itself is replaced by a local OpenID Connect token endpoint (the only
 * Google endpoint the API calls server-to-server). It behaves like Google's:
 * single-use codes bound to the client id/secret and redirect URI, PKCE S256
 * verification, and an ID token carrying the nonce of the authorization
 * request. The real `GoogleOAuthClient` talks to it over HTTP with test client
 * credentials — the endpoint override is the only test seam.
 */

const RUN = Date.now().toString(36);
const TEST_UA = `google-auth-e2e/${RUN}`;
const CLIENT_ID = 'e2e-client.apps.googleusercontent.com';
const CLIENT_SECRET = 'e2e-client-secret-value';
const REDIRECT_URI = 'http://localhost:3000/api/session/google/callback';
const ISSUER = 'https://accounts.google.com';

const MOBILES = {
  newUser: '+989127770001',
  existing: '+989127770002',
  emailOwner: '+989127770003',
  admin: '+989127770004',
  linkedOther: '+989127770005',
  unverified: '+989127770006',
};
const SUITE_MOBILES = Object.values(MOBILES);
const EMAILS = {
  newUser: `g-new-${RUN}@gmail.com`,
  emailOwner: `g-owner-${RUN}@gmail.com`,
  admin: `g-admin-${RUN}@gmail.com`,
  unverified: `g-unverified-${RUN}@gmail.com`,
};

interface PendingCode {
  claims: Record<string, unknown>;
  challenge: string;
  redirectUri: string;
}

type ErrorBody = { statusCode: number; code?: string; message: string };
type Tokens = { accessToken: string; refreshToken: string; user: { id: string; role: string; mobile: string; email: string | null; fullName: string } };
type Callback = { status: 'signed_in' | 'mobile_required'; next: string | null; tokens?: Tokens; ticket?: string; expiresInSeconds?: number; profile?: { email: string | null; name: string | null; picture: string | null } };

describe('Sign-in with Google (live stack, local OIDC token endpoint)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let redis: RedisService;
  let oidc: Server;
  let tokenEndpoint = '';
  const codes = new Map<string, PendingCode>();
  let tokenRequests = 0;

  const API = `/${GLOBAL_API_PREFIX}`;

  const request = async <T>(url: string, options: { method?: 'GET' | 'POST'; body?: unknown; ticket?: string; token?: string } = {}): Promise<{ status: number; body: T }> => {
    const headers: Record<string, string> = { 'user-agent': TEST_UA };
    if (options.ticket !== undefined) headers[GOOGLE_SIGNUP_TICKET_HEADER] = options.ticket;
    if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    const response = await app.inject({ method: options.method ?? 'GET', url: `${API}${url}`, headers, ...(options.body === undefined ? {} : { payload: JSON.stringify(options.body) }) });
    return { status: response.statusCode, body: response.body.length > 0 ? (JSON.parse(response.body) as T) : (undefined as T) };
  };

  /** What Google does between the redirect and the callback: the user picks an account, Google issues a code. */
  const authorize = (authorizationUrl: string, claims: Record<string, unknown>): { code: string; state: string } => {
    const url = new URL(authorizationUrl);
    const code = `4/${randomBytes(24).toString('base64url')}`;
    codes.set(code, {
      challenge: url.searchParams.get('code_challenge') ?? '',
      redirectUri: url.searchParams.get('redirect_uri') ?? '',
      claims: {
        iss: ISSUER,
        aud: CLIENT_ID,
        azp: CLIENT_ID,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
        nonce: url.searchParams.get('nonce'),
        ...claims,
      },
    });
    return { code, state: url.searchParams.get('state') ?? '' };
  };

  const start = async (next?: string): Promise<{ authorizationUrl: string; state: string }> => {
    const response = await request<{ authorizationUrl: string; state: string; expiresInSeconds: number }>(`/auth/google${next === undefined ? '' : `?next=${encodeURIComponent(next)}`}`);
    expect(response.status).toBe(200);
    return response.body;
  };

  const callback = (code: string, state: string): Promise<{ status: number; body: Callback & ErrorBody }> =>
    request(`/auth/google/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`);

  /** Full Google round trip for an identity. */
  const signInWithGoogle = async (claims: Record<string, unknown>, next?: string): Promise<{ status: number; body: Callback & ErrorBody }> => {
    const started = await start(next);
    const { code, state } = authorize(started.authorizationUrl, claims);
    return callback(code, state);
  };

  const latestCode = (mobile: string): string => (app.get<SmsProvider>(SMS_PROVIDER) as SandboxSmsProvider).latestOtpCode(mobile) ?? '';

  const bindMobile = async (ticket: string, mobile: string): Promise<{ status: number; body: { next: string | null; tokens: Tokens } & ErrorBody }> => {
    const sent = await request<{ status: string }>('/auth/google/signup/otp', { method: 'POST', ticket, body: { mobile } });
    expect(sent.status).toBe(200);
    return request('/auth/google/signup/verify', { method: 'POST', ticket, body: { mobile, code: latestCode(mobile) } });
  };

  const readBody = (incoming: IncomingMessage): Promise<string> =>
    new Promise((resolve) => {
      let data = '';
      incoming.on('data', (chunk: Buffer) => (data += chunk.toString('utf8')));
      incoming.on('end', () => resolve(data));
    });

  async function resetKeys(): Promise<void> {
    const keys = [
      ...(await redis.client.keys('auth:otp:hourly:ip:*')),
      ...(await redis.client.keys('auth:google:start:ip:*')),
      ...SUITE_MOBILES.flatMap((mobile) => [OtpKeys.challenge(mobile), OtpKeys.lock(mobile), OtpKeys.cooldown(mobile), OtpKeys.hourlyByMobile(mobile)]),
    ];
    if (keys.length > 0) await redis.client.del(...keys);
  }

  async function cleanup(): Promise<void> {
    const users = await prisma.user.findMany({ where: { mobile: { in: SUITE_MOBILES } }, select: { id: true } });
    const ids = users.map((user) => user.id);
    await prisma.auditLog.deleteMany({ where: { OR: [{ userId: { in: ids } }, { userAgent: TEST_UA }] } });
    await prisma.customerProfile.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }

  beforeAll(async () => {
    oidc = createServer((incoming, outgoing) => {
      void (async (): Promise<void> => {
        const send = (status: number, body: unknown): void => {
          outgoing.writeHead(status, { 'content-type': 'application/json' });
          outgoing.end(JSON.stringify(body));
        };
        if (incoming.method !== 'POST' || incoming.url !== '/token') return send(404, { error: 'not_found' });
        tokenRequests += 1;
        const form = new URLSearchParams(await readBody(incoming));
        const code = form.get('code') ?? '';
        if (code === 'google-is-down') return send(503, { error: 'backend_error' });
        const pending = codes.get(code);
        codes.delete(code); // single use, like Google
        if (form.get('client_id') !== CLIENT_ID || form.get('client_secret') !== CLIENT_SECRET) return send(401, { error: 'invalid_client' });
        if (pending === undefined || form.get('grant_type') !== 'authorization_code') return send(400, { error: 'invalid_grant' });
        if (form.get('redirect_uri') !== pending.redirectUri) return send(400, { error: 'redirect_uri_mismatch' });
        const verifier = form.get('code_verifier') ?? '';
        if (createHash('sha256').update(verifier).digest('base64url') !== pending.challenge) return send(400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
        const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
        send(200, { access_token: 'ya29.e2e', token_type: 'Bearer', expires_in: 3599, scope: 'openid email profile', id_token: `${encode({ alg: 'RS256', kid: 'e2e' })}.${encode(pending.claims)}.c2ln` });
      })();
    });
    await new Promise<void>((resolve) => oidc.listen(0, '127.0.0.1', resolve));
    tokenEndpoint = `http://127.0.0.1:${(oidc.address() as AddressInfo).port}/token`;

    const endpoints: GoogleOAuthEndpoints = { authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth', tokenEndpoint, issuers: [ISSUER, 'accounts.google.com'] };
    const googleConfig = new ConfigService<EnvironmentVariables, true>({ GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: CLIENT_SECRET, GOOGLE_REDIRECT_URI: REDIRECT_URI, PUBLIC_API_ORIGIN: 'http://localhost:4000' });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(GOOGLE_OAUTH_ENDPOINTS)
      .useValue(endpoints)
      .overrideProvider(GoogleOAuthClient)
      .useFactory({ factory: () => new GoogleOAuthClient(endpoints, googleConfig) })
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    applyGlobalPolicies(app, app.get(ConfigService));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = app.get(PrismaService);
    redis = app.get(RedisService);
    await cleanup();
    await resetKeys();

    // Accounts that exist before their owners ever use Google.
    await prisma.user.create({ data: { mobile: MOBILES.existing, fullName: 'مشتری قدیمی', role: UserRole.CUSTOMER, customerProfile: { create: {} } } });
    await prisma.user.create({ data: { mobile: MOBILES.emailOwner, email: EMAILS.emailOwner, fullName: 'صاحب ایمیل', role: UserRole.CUSTOMER, customerProfile: { create: {} } } });
    await prisma.user.create({ data: { mobile: MOBILES.admin, email: EMAILS.admin, fullName: 'ادمین آزمون', role: UserRole.ADMIN } });
    await prisma.user.create({ data: { mobile: MOBILES.linkedOther, fullName: 'متصل به گوگل دیگر', role: UserRole.CUSTOMER, googleSubject: `other-sub-${RUN}`, customerProfile: { create: {} } } });
  }, 120_000);

  afterAll(async () => {
    if (prisma !== undefined) {
      await cleanup();
      await resetKeys();
    }
    await app?.close();
    oidc?.closeAllConnections();
    await new Promise<void>((resolve) => (oidc ? oidc.close(() => resolve()) : resolve()));
  });

  describe('start', () => {
    it('reports that Google sign-in is enabled', async () => {
      expect((await request<{ enabled: boolean }>('/auth/google/status')).body).toEqual({ enabled: true });
    });

    it('builds an authorization-code request with PKCE S256, nonce and a one-time state kept in Redis', async () => {
      const started = await start('/cart?step=2');
      const url = new URL(started.authorizationUrl);
      expect(`${url.origin}${url.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth');
      expect(Object.fromEntries(url.searchParams)).toMatchObject({ client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, response_type: 'code', scope: 'openid email profile', code_challenge_method: 'S256', prompt: 'select_account', state: started.state });
      expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(url.searchParams.get('nonce')).toMatch(/^[A-Za-z0-9_-]{32}$/);
      const stored = JSON.parse((await redis.client.get(GoogleKeys.state(started.state))) ?? '{}') as { next: string; verifier: string };
      expect(stored.next).toBe('/cart?step=2');
      expect(createHash('sha256').update(stored.verifier).digest('base64url')).toBe(url.searchParams.get('code_challenge'));
      expect(await redis.client.ttl(GoogleKeys.state(started.state))).toBeGreaterThan(590);
    });

    it('drops an off-site "next"', async () => {
      const started = await start('https://evil.example/');
      expect(JSON.parse((await redis.client.get(GoogleKeys.state(started.state))) ?? '{}')).toMatchObject({ next: null });
    });

    it('rate-limits sign-in starts per IP', async () => {
      await redis.client.set(GoogleKeys.startByIp('127.0.0.1'), '30', 'EX', 3600);
      const limited = await request<ErrorBody>('/auth/google');
      expect(limited.status).toBe(429);
      await redis.client.del(GoogleKeys.startByIp('127.0.0.1'));
    });
  });

  describe('callback safety', () => {
    it('refuses an unknown state, and a state that was already used', async () => {
      expect((await callback('4/any', 'x'.repeat(43))).body.code).toBe('GOOGLE_STATE_INVALID');
      expect((await callback('4/any', 'short')).status).toBe(400);
      const started = await start();
      const { code, state } = authorize(started.authorizationUrl, { sub: `replay-${RUN}`, email: EMAILS.unverified, email_verified: false });
      expect((await callback(code, state)).status).toBe(200);
      const replay = await callback(code, state);
      expect(replay.status).toBe(400);
      expect(replay.body.code).toBe('GOOGLE_STATE_INVALID');
    });

    it('refuses a code Google does not honour, an ID token for another nonce or audience, and reports Google outages', async () => {
      const unknownCode = await start();
      expect((await callback('4/never-issued', unknownCode.state)).body.code).toBe('GOOGLE_EXCHANGE_FAILED');

      const wrongNonce = await signInWithGoogle({ sub: `nonce-${RUN}`, nonce: 'from-another-attempt' });
      expect(wrongNonce.status).toBe(401);
      expect(wrongNonce.body.code).toBe('GOOGLE_EXCHANGE_FAILED');

      const wrongAudience = await signInWithGoogle({ sub: `aud-${RUN}`, aud: 'other-app.apps.googleusercontent.com' });
      expect(wrongAudience.body.code).toBe('GOOGLE_EXCHANGE_FAILED');

      const down = await start();
      const outage = await callback('google-is-down', down.state);
      expect(outage.status).toBe(502);
      expect(outage.body.code).toBe('GOOGLE_UNAVAILABLE');
    });

    it('sends the PKCE verifier: a code redeemed with another attempt\'s verifier is refused by Google', async () => {
      const first = await start();
      const second = await start();
      const { code } = authorize(first.authorizationUrl, { sub: `pkce-${RUN}` });
      // The code belongs to the first attempt; presenting it with the second state uses the wrong verifier.
      const before = tokenRequests;
      const response = await callback(code, second.state);
      expect(tokenRequests).toBe(before + 1);
      expect(response.body.code).toBe('GOOGLE_EXCHANGE_FAILED');
    });
  });

  describe('new Google user → mobile binding → account', () => {
    const subject = `new-${RUN}`;
    let ticket = '';

    it('asks for a mobile number and keeps the Google profile behind a ticket', async () => {
      const response = await signInWithGoogle({ sub: subject, email: EMAILS.newUser.toUpperCase(), email_verified: true, name: 'نگار رضایی', picture: 'https://lh3.googleusercontent.com/a/negar' }, '/checkout');
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ status: 'mobile_required', next: '/checkout', expiresInSeconds: 900, profile: { email: EMAILS.newUser, name: 'نگار رضایی', picture: 'https://lh3.googleusercontent.com/a/negar' } });
      expect(response.body.tokens).toBeUndefined();
      ticket = response.body.ticket ?? '';
      expect(await redis.client.exists(GoogleKeys.signup(ticket))).toBe(1);

      const state = await request<{ name: string; email: string; mobile: string | null; next: string }>('/auth/google/signup', { ticket });
      expect(state.body).toMatchObject({ name: 'نگار رضایی', email: EMAILS.newUser, mobile: null, next: '/checkout' });
    });

    it('rejects a missing or unknown ticket, and a code for a number the code was not sent to', async () => {
      expect((await request<ErrorBody>('/auth/google/signup')).body.code).toBe('GOOGLE_SIGNUP_EXPIRED');
      expect((await request<ErrorBody>('/auth/google/signup', { ticket: 'A'.repeat(43) })).status).toBe(401);
      const premature = await request<ErrorBody>('/auth/google/signup/verify', { method: 'POST', ticket, body: { mobile: MOBILES.newUser, code: '12345' } });
      expect(premature.body.code).toBe('GOOGLE_SIGNUP_MOBILE_MISMATCH');
    });

    it('refuses a wrong code, then creates the CUSTOMER account with the Google name, verified e-mail, subject and picture', async () => {
      const sent = await request<{ status: string }>('/auth/google/signup/otp', { method: 'POST', ticket, body: { mobile: '09127770001' } });
      expect(sent.body.status).toBe('sent');
      const code = latestCode(MOBILES.newUser);
      const other = await request<ErrorBody>('/auth/google/signup/verify', { method: 'POST', ticket, body: { mobile: MOBILES.unverified, code } });
      expect(other.body.code).toBe('GOOGLE_SIGNUP_MOBILE_MISMATCH');
      const wrong = await request<ErrorBody>('/auth/google/signup/verify', { method: 'POST', ticket, body: { mobile: MOBILES.newUser, code: code === '11111' ? '22222' : '11111' } });
      expect(wrong.status).toBe(401);

      const verified = await request<{ next: string; tokens: Tokens }>('/auth/google/signup/verify', { method: 'POST', ticket, body: { mobile: MOBILES.newUser, code } });
      expect(verified.status).toBe(200);
      expect(verified.body.next).toBe('/checkout');
      expect(verified.body.tokens.user).toMatchObject({ role: 'CUSTOMER', mobile: MOBILES.newUser, email: EMAILS.newUser, fullName: 'نگار رضایی' });

      const me = await request<{ user: { id: string } }>('/auth/me', { token: verified.body.tokens.accessToken });
      expect(me.status).toBe(200);
      const row = await prisma.user.findUniqueOrThrow({ where: { mobile: MOBILES.newUser }, include: { customerProfile: true } });
      expect(row).toMatchObject({ googleSubject: subject, avatarUrl: 'https://lh3.googleusercontent.com/a/negar', role: UserRole.CUSTOMER });
      expect(row.customerProfile).not.toBeNull();
      expect(await redis.client.exists(GoogleKeys.signup(ticket))).toBe(0);
      const audit = await prisma.auditLog.findFirst({ where: { userId: row.id, action: 'LOGIN' }, orderBy: { createdAt: 'desc' } });
      expect(audit?.newValue).toMatchObject({ success: true, method: 'google', linked: 'new_account' });
    });

    it('signs the same Google account in directly next time', async () => {
      const again = await signInWithGoogle({ sub: subject, email: EMAILS.newUser, email_verified: true, name: 'نگار رضایی' }, '/customer/orders');
      expect(again.body.status).toBe('signed_in');
      expect(again.body.next).toBe('/customer/orders');
      expect(again.body.tokens?.user.mobile).toBe(MOBILES.newUser);
      expect((await request('/auth/me', { token: again.body.tokens?.accessToken })).status).toBe(200);
    });
  });

  describe('linking to existing accounts', () => {
    it('links a Google account to the existing account of the verified mobile (no duplicate account)', async () => {
      const before = await prisma.user.findUniqueOrThrow({ where: { mobile: MOBILES.existing } });
      const response = await signInWithGoogle({ sub: `existing-${RUN}`, email: `g-existing-${RUN}@gmail.com`, email_verified: true, name: 'نام گوگل' });
      expect(response.body.status).toBe('mobile_required');
      const bound = await bindMobile(response.body.ticket ?? '', MOBILES.existing);
      expect(bound.status).toBe(200);
      expect(bound.body.tokens.user.id).toBe(before.id);
      const after = await prisma.user.findUniqueOrThrow({ where: { id: before.id } });
      // Linked; the verified Google e-mail fills the empty e-mail; the name the customer chose is kept.
      expect(after).toMatchObject({ googleSubject: `existing-${RUN}`, email: `g-existing-${RUN}@gmail.com`, fullName: 'مشتری قدیمی' });
      expect(await prisma.user.count({ where: { mobile: MOBILES.existing } })).toBe(1);
    });

    it('links automatically when the verified Google e-mail belongs to an account', async () => {
      const owner = await prisma.user.findUniqueOrThrow({ where: { mobile: MOBILES.emailOwner } });
      const response = await signInWithGoogle({ sub: `owner-${RUN}`, email: EMAILS.emailOwner, email_verified: true });
      expect(response.body.status).toBe('signed_in');
      expect(response.body.tokens?.user.id).toBe(owner.id);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: owner.id } })).googleSubject).toBe(`owner-${RUN}`);
    });

    it('does not trust an unverified Google e-mail: the mobile must be verified instead', async () => {
      const response = await signInWithGoogle({ sub: `unverified-${RUN}`, email: EMAILS.emailOwner, email_verified: false });
      expect(response.body.status).toBe('mobile_required');
      // And a mobile whose account is linked to another Google account cannot be taken over.
      const bound = await bindMobile(response.body.ticket ?? '', MOBILES.linkedOther);
      expect(bound.status).toBe(409);
      expect(bound.body.code).toBe('GOOGLE_MOBILE_LINKED_ELSEWHERE');
      expect((await prisma.user.findUniqueOrThrow({ where: { mobile: MOBILES.linkedOther } })).googleSubject).toBe(`other-sub-${RUN}`);
    });

    it('refuses staff accounts, by e-mail and by mobile', async () => {
      const byEmail = await signInWithGoogle({ sub: `admin-${RUN}`, email: EMAILS.admin, email_verified: true });
      expect(byEmail.status).toBe(403);
      expect(byEmail.body.code).toBe('GOOGLE_STAFF_NOT_ALLOWED');

      const byMobile = await signInWithGoogle({ sub: `admin-m-${RUN}` });
      const bound = await bindMobile(byMobile.body.ticket ?? '', MOBILES.admin);
      expect(bound.status).toBe(403);
      expect(bound.body.code).toBe('GOOGLE_STAFF_NOT_ALLOWED');
      expect((await prisma.user.findUniqueOrThrow({ where: { mobile: MOBILES.admin } })).googleSubject).toBeNull();
      const refused = await prisma.auditLog.count({ where: { action: 'LOGIN', newValue: { path: ['reason'], equals: 'google_staff_account' } } });
      expect(refused).toBeGreaterThanOrEqual(2);
    });

    it('refuses deactivated accounts', async () => {
      await prisma.user.update({ where: { mobile: MOBILES.emailOwner }, data: { isActive: false } });
      const response = await signInWithGoogle({ sub: `owner-${RUN}`, email: EMAILS.emailOwner, email_verified: true });
      expect(response.status).toBe(403);
      await prisma.user.update({ where: { mobile: MOBILES.emailOwner }, data: { isActive: true } });
    });
  });
});
