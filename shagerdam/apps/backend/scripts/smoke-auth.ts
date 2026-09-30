/**
 * Live smoke test of the authentication module over **real HTTP**.
 *
 * Unlike the Jest suites (which use Fastify's in-process `inject`), this script
 * talks to a running API over the network, exactly like a browser or the admin
 * panel will. It is the check to run after a deployment:
 *
 *   pnpm --filter @shopino/backend run start      # in one terminal
 *   pnpm --filter @shopino/backend run verify:auth
 *
 * It uses the seeded super-admin credentials from `.env`; nothing is hardcoded
 * and no secret is printed. Exit code is non-zero as soon as one expectation
 * fails, so it can be wired into a deployment pipeline.
 */
import { setTimeout as delay } from 'node:timers/promises';
import { config as loadDotenv } from 'dotenv';
import Redis from 'ioredis';
import { resolveEnvFilePaths } from '../src/config/env-file-paths';
import { OtpKeys } from '../src/modules/auth/otp.service';
import { loginAttemptsKey, loginLockKey } from '../src/modules/auth/token.service';
import { normalizeIdentifier } from '../src/modules/auth/auth.service';
import { toE164 } from '../src/common/validators/iranian-mobile';

for (const envFilePath of resolveEnvFilePaths()) {
  loadDotenv({ path: envFilePath, override: false, quiet: true });
}

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
  skipped?: boolean;
}

const checks: CheckResult[] = [];
let failed = 0;

function record(name: string, ok: boolean, detail: string, skipped = false): void {
  checks.push({ name, ok, detail, skipped });
  if (!ok && !skipped) {
    failed += 1;
  }
}

/**
 * Numbers reserved for this script. They are never seeded accounts.
 *
 * The OTP endpoints are rate-limited by design (cooldown per number, hourly
 * quotas per number and per IP), so a verification script that ignores its own
 * previous run would fail on the second execution. In non-production
 * environments the script therefore clears the rate-limit keys **of its own two
 * numbers only** before exercising the flow, which makes the run repeatable
 * without weakening a single production rule. In production this reset is never
 * attempted, and the OTP section is skipped entirely — see `main()`.
 */
const SMOKE_MOBILE_A = '09990000009';
const SMOKE_MOBILE_B = '09990000008';

const isProduction = (): boolean => process.env.NODE_ENV === 'production';

async function resetSmokeRateLimits(adminIdentifier: string): Promise<void> {
  if (isProduction()) {
    return;
  }
  const redis = new Redis({
    host: process.env.REDIS_HOST ?? '127.0.0.1',
    port: Number(process.env.REDIS_PORT ?? 6379),
    password: process.env.REDIS_PASSWORD,
    db: Number(process.env.REDIS_DB ?? 0),
    lazyConnect: true,
    maxRetriesPerRequest: 2,
  });

  try {
    await redis.connect();
    const keys = [SMOKE_MOBILE_A, SMOKE_MOBILE_B].flatMap((mobile) => {
      const normalized = toE164(mobile) ?? mobile;
      return [
        OtpKeys.challenge(normalized),
        OtpKeys.cooldown(normalized),
        OtpKeys.lock(normalized),
        OtpKeys.hourlyByMobile(normalized),
      ];
    });
    // One failed password login per run would otherwise accumulate towards the
    // lockout threshold of the admin account, and the fifth run of this script
    // would report 429 where it expects 401.
    for (const identifier of [adminIdentifier]) {
      keys.push(loginAttemptsKey(normalizeIdentifier(identifier)), loginLockKey(normalizeIdentifier(identifier)));
    }

    const existing = (await redis.exists(...keys)) > 0 ? keys : [];
    if (existing.length > 0) {
      await redis.del(...existing);
    }
  } finally {
    await redis.quit();
  }
}

const baseUrl = (): string => {
  const host = process.env.SMOKE_API_URL ?? `http://127.0.0.1:${process.env.PORT ?? 4000}`;
  return `${host.replace(/\/$/, '')}/api/v1`;
};

async function call(
  path: string,
  options: { method?: 'GET' | 'POST' | 'PATCH'; body?: unknown; token?: string } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl()}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      'user-agent': 'shopino-smoke-auth/1.0',
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });

  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    parsed = { raw: text.slice(0, 200) };
  }
  return { status: response.status, body: parsed };
}

async function main(): Promise<void> {
  const adminEmail = process.env.SUPER_ADMIN_EMAIL;
  const adminPassword = process.env.SUPER_ADMIN_PASSWORD;
  if (!adminEmail || !adminPassword) {
    throw new Error('SUPER_ADMIN_EMAIL / SUPER_ADMIN_PASSWORD are not set — run `pnpm db:seed` first.');
  }

  // Make the run repeatable (non-production only): the rate-limit and lockout
  // state of *this script's own* numbers and identifier is cleared, so a second
  // execution verifies the same behaviour instead of the leftovers of the first.
  await resetSmokeRateLimits(adminEmail);

  // ── 1. Health: the API and its dependencies are reachable ──────────────────
  const health = await call('/health');
  record(
    'GET /health is public and reports all dependencies up',
    health.status === 200 && health.body.status === 'ok',
    `HTTP ${health.status} · ${JSON.stringify(health.body).slice(0, 120)}`,
  );

  // ── 2. Protected route without a token ────────────────────────────────────
  const anonymous = await call('/auth/me');
  record('GET /auth/me without a token is rejected', anonymous.status === 401, `HTTP ${anonymous.status}`);

  // ── 3. Staff password login ───────────────────────────────────────────────
  const login = await call('/auth/login/password', {
    method: 'POST',
    body: { identifier: adminEmail, password: adminPassword },
  });
  const accessToken = typeof login.body.accessToken === 'string' ? login.body.accessToken : '';
  const refreshToken = typeof login.body.refreshToken === 'string' ? login.body.refreshToken : '';
  const user = login.body.user as { role?: string; mobile?: string } | undefined;

  record(
    'POST /auth/login/password authenticates the seeded super admin',
    login.status === 200 && user?.role === 'SUPER_ADMIN' && accessToken.split('.').length === 3,
    `HTTP ${login.status} · role=${user?.role ?? 'n/a'} · mobile=${user?.mobile ?? 'n/a'} · accessToken=${accessToken.slice(0, 12)}…`,
  );

  if (accessToken === '') {
    report();
    return;
  }

  // ── 4. A wrong password is refused ────────────────────────────────────────
  const wrongPassword = await call('/auth/login/password', {
    method: 'POST',
    body: { identifier: adminEmail, password: 'not-the-right-password' },
  });
  record(
    'POST /auth/login/password rejects a wrong password',
    wrongPassword.status === 401,
    `HTTP ${wrongPassword.status} · message="${String(wrongPassword.body.message)}"`,
  );

  // ── 5. Authenticated identity ─────────────────────────────────────────────
  const me = await call('/auth/me', { token: accessToken });
  record(
    'GET /auth/me returns the authenticated profile',
    me.status === 200 && (me.body.user as { role?: string } | undefined)?.role === 'SUPER_ADMIN',
    `HTTP ${me.status} · role=${String((me.body.user as { role?: string } | undefined)?.role)}`,
  );

  // ── 6. Profile update is validated and audited ────────────────────────────
  const invalidNationalCode = await call('/auth/profile', {
    method: 'PATCH',
    token: accessToken,
    body: { nationalCode: '0499370898' },
  });
  record(
    'PATCH /auth/profile rejects a national code with a bad check digit',
    invalidNationalCode.status === 400,
    `HTTP ${invalidNationalCode.status}`,
  );

  const profileUpdate = await call('/auth/profile', {
    method: 'PATCH',
    token: accessToken,
    body: { fullName: process.env.SUPER_ADMIN_FULL_NAME ?? 'مدیر ارشد پلتفرم' },
  });
  record(
    'PATCH /auth/profile updates the profile',
    profileUpdate.status === 200 && profileUpdate.body.updated === true,
    `HTTP ${profileUpdate.status} · updated=${String(profileUpdate.body.updated)}`,
  );

  // ── 7. The audit trail recorded it ────────────────────────────────────────
  await delay(150);
  const audit = await call('/admin/audit-logs?entityName=User&action=UPDATE&pageSize=1', { token: accessToken });
  const items = Array.isArray(audit.body.items) ? (audit.body.items as Array<Record<string, unknown>>) : [];
  record(
    'GET /admin/audit-logs shows the UPDATE row with before/after values',
    audit.status === 200 && items.length > 0 && items[0]?.oldValue !== null && items[0]?.newValue !== null,
    `HTTP ${audit.status} · total=${String(audit.body.total)} · entityId=${String(items[0]?.entityId)}`,
  );

  // ── 8. Refresh rotation ───────────────────────────────────────────────────
  const refreshed = await call('/auth/refresh', { method: 'POST', body: { refreshToken } });
  const rotatedRefresh =
    typeof refreshed.body.refreshToken === 'string' ? refreshed.body.refreshToken : '';
  record(
    'POST /auth/refresh rotates the refresh token',
    refreshed.status === 200 && rotatedRefresh !== '' && rotatedRefresh !== refreshToken,
    `HTTP ${refreshed.status} · rotated=${rotatedRefresh !== refreshToken}`,
  );

  const reused = await call('/auth/refresh', { method: 'POST', body: { refreshToken } });
  record(
    'a consumed refresh token is refused (replay detection)',
    reused.status === 401,
    `HTTP ${reused.status}`,
  );

  // ── 9. Logout revokes the session ─────────────────────────────────────────
  const newAccessToken = typeof refreshed.body.accessToken === 'string' ? refreshed.body.accessToken : '';
  const logout = await call('/auth/logout', {
    method: 'POST',
    token: newAccessToken,
    body: { refreshToken: rotatedRefresh },
  });
  record(
    'POST /auth/logout revokes the session',
    logout.status === 200 && logout.body.revoked === true,
    `HTTP ${logout.status} · sessionsRevoked=${String(logout.body.sessionsRevoked)}`,
  );

  const afterLogout = await call('/auth/refresh', { method: 'POST', body: { refreshToken: rotatedRefresh } });
  record(
    'the revoked session can no longer mint tokens',
    afterLogout.status === 401,
    `HTTP ${afterLogout.status}`,
  );

  // ── 10. OTP request path over HTTP ────────────────────────────────────────
  // Skipped in production on purpose: the active provider there is a real
  // gateway, and a smoke test must never send a live SMS to a fake number.
  if (isProduction()) {
    record(
      'OTP request path',
      true,
      'skipped: NODE_ENV=production and the live SMS provider is active — sending test messages would cost money and disturb real traffic',
      true,
    );
    record('OTP cooldown enforcement', true, 'skipped: see above', true);
  } else {
    await resetSmokeRateLimits(adminEmail);

    const firstOtp = await call('/auth/otp/request', { method: 'POST', body: { mobile: SMOKE_MOBILE_A } });
    record(
      'POST /auth/otp/request accepts a national mobile number',
      firstOtp.status === 200 && firstOtp.body.status === 'sent',
      `HTTP ${firstOtp.status} · status=${String(firstOtp.body.status)} · expiresInSeconds=${String(firstOtp.body.expiresInSeconds)} · trackingId=${String(firstOtp.body.trackingId)}`,
    );

    const secondOtp = await call('/auth/otp/request', { method: 'POST', body: { mobile: SMOKE_MOBILE_B } });
    const thirdOtp = await call('/auth/otp/request', { method: 'POST', body: { mobile: SMOKE_MOBILE_B } });
    record(
      'the OTP cooldown is enforced over HTTP',
      secondOtp.status === 200 && thirdOtp.status === 429 && typeof thirdOtp.body.retryAfterSeconds === 'number',
      `first=${secondOtp.status} · second=${thirdOtp.status} · retryAfterSeconds=${String(thirdOtp.body.retryAfterSeconds)}`,
    );
  }

  // ── 11. Input validation ──────────────────────────────────────────────────
  const invalidMobile = await call('/auth/otp/request', { method: 'POST', body: { mobile: '12345' } });
  record('an invalid mobile number is rejected', invalidMobile.status === 400, `HTTP ${invalidMobile.status}`);

  const provider = await call('/auth/sms-provider');
  record(
    'GET /auth/sms-provider reports the active provider honestly',
    provider.status === 200 && typeof provider.body.provider === 'string',
    `provider=${String(provider.body.provider)} · isTestProvider=${String(provider.body.isTestProvider)}`,
  );

  report();
}

function report(): void {
  const width = Math.max(...checks.map((check) => check.name.length), 10);
  console.log('\nShopino — authentication smoke test (live HTTP)\n');
  for (const check of checks) {
    const label = check.skipped === true ? 'SKIP' : check.ok ? 'PASS' : 'FAIL';
    console.log(`  ${label}  ${check.name.padEnd(width)}  ${check.detail}`);
  }
  const skipped = checks.filter((check) => check.skipped === true).length;
  const passed = checks.length - failed - skipped;
  const suffix = failed > 0 ? ` — ${failed} FAILED` : skipped > 0 ? ` — ${skipped} skipped` : '';
  console.log(`\n  ${passed}/${checks.length - skipped} checks passed${suffix}\n`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

void main().catch((error: unknown) => {
  console.error(`Smoke test aborted: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
