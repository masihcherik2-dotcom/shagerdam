# Phase 11 — Verification (production hardening)

Everything below was executed in the development sandbox (2 vCPU, 2 GB RAM) against the files committed in this phase.

**What could not be tested:** anything that needs real external accounts: live Kavenegar delivery, a real Zarinpal merchant, real S3 buckets, real Let's Encrypt issuance, a real VPS and GitHub-hosted runners. Section 9 lists exactly what those tests replaced and how.

## 1. Acceptance criteria

| # | Criterion | Result |
|---|---|---|
| 1 | Both images build with `docker build` | ✅ Backend (runner + migrator), frontend and nginx all build. Sizes in §2 |
| 2 | Backup and restore tested with zero data loss | ✅ 19/19 checks. Row-level fingerprints of every table and sequence are identical after a drill restore and after an in-place restore (§5) |
| 3 | CI YAML is valid and passes validation | ✅ `actionlint` 1.7.7: 0 issues (includes shellcheck of every `run:` block). Every job's commands were also executed in a clean copy of the repository; all pass (§7) |
| 4 | Complete deployment documentation | ✅ `docs/production-deployment-guide.md`: provisioning, DNS, TLS, providers, first install, backups, CI/CD, operations |

## 2. Images

| Image | Build | Size | User | Notes |
|---|---|---|---|---|
| `shopino/backend` (target `runner`) | `docker build -f apps/backend/Dockerfile .` | **328 MB** (482 MB before pruning) | `node` (uid 1000) | `node:22-alpine`; dumb-init as PID 1; production dependencies only (`pnpm deploy --prod`); Prisma client for linux-musl/OpenSSL 3; health check `GET /api/v1/health` |
| `shopino/migrator` (target `migrator`) | `… --target migrator` | 905 MB | `node` | Operations image (Prisma CLI + ts-node) for `migrate deploy` and the seed. Binaries are called directly, with no pnpm/corepack download at runtime (a real finding: corepack tried to fetch pnpm from the registry) |
| `shopino/frontend` | `docker build -f apps/frontend/Dockerfile .` | **251 MB** (application payload 85 MB) | `node` (uid 1000) | Next.js `output: 'standalone'` (only when `NEXT_OUTPUT=standalone`, so development is unchanged); health check `GET /api/session` |
| `shopino/nginx` | `docker build deploy/nginx` | **17 MB** | master root → workers `nginx` | Alpine nginx + `nginx-mod-http-brotli`; tini |

Backend pruning:
- **Removed:**
  - the Prisma CLI and engines, `effect` and `typescript` (all build-time only);
  - the Prisma runtimes for MySQL, SQLite, SQL Server and CockroachDB;
  - glibc `sharp` builds.
- **Verified in the pruned image:**
  - `@node-rs/argon2` verifies a stored hash;
  - `sharp` 8.18.6 encodes WebP;
  - the database and Redis health checks are up;
  - `/api/v1/products` answers;
  - the container reports `healthy`, with no "Cannot find module" error.
- **Real finding:** BusyBox `find` does not support `-xtype`, which made the first pruning attempt fail; that step was removed.

## 3. Full stack (`docker-compose.prod.yml`)

**Topology check:**
- all five services became `healthy` (≈180 MB of RAM in total);
- only nginx publishes ports (0.0.0.0:80/443);
- backend 4000 and frontend 3000 are container-internal only.

| Hardening check | Result |
|---|---|
| backend / frontend uid | 1000 / 1000 |
| Effective capabilities (backend, frontend) | `0000000000000000` |
| Root filesystem write (backend, frontend, redis) | `Read-only file system` |
| Backend upload volume writable | yes |
| frontend → postgres / redis | blocked (the name does not resolve: different network) |
| nginx → backend | blocked |
| backend → postgres | reachable |
| postgres → internet (`data` is `internal`) | blocked |
| backend → internet (SMS / bank / S3) | reachable (TCP 443) |
| `/api/docs` through nginx | 404 (the API is not public) |
| Frontend gets no secrets | no `env_file`; only `BACKEND_INTERNAL_URL` |

### 3.1 End-to-end journey through HTTPS → nginx → BFF → API (verify override: sandbox providers)

`tmpdoc/p11verify/journey.sh`: **18/18 passed**, also re-run twice more inside the backup test (on new data, and on the restored database).

1. OTP sign-in (code taken from the sandbox SMS log).
   - `shopino_at` is **Secure**; `shopino_rt` is **HttpOnly**.
   - The session identity is CUSTOMER.
2. Address → cart → checkout (`SHP-100000002`).
3. Payment:
   - the initiation redirect stays on the public origin;
   - the bank page is served through nginx;
   - the bank's decision redirects to the callback;
   - the callback redirects to `/payment/result?…outcome=PAID`;
   - the order is **PAID**.
4. Vendor password sign-in, then a **4.2 MB** PNG upload through `/api/v1/media/upload/image` (above the 1 MB default, accepted on the 15 MB route); the stored image is served.
5. Logout clears the session.

### 3.2 True production mode (`deploy.sh`, no override file)

The backend runs with `NODE_ENV=production`, `SMS_PROVIDER=kavenegar` and `PAYMENT_GATEWAY_PROVIDER=zarinpal`. The logs show `SMS provider: kavenegar (live gateway)` and the expected warning for `STORAGE_PROVIDER=local`.

Provider values were syntactically valid but **not credentials**:
- `LOCAL-VERIFY-NOT-A-CREDENTIAL`;
- the all-zero merchant ID.

Results:
- `GET /api/v1/auth/sms-provider` → `{"provider":"kavenegar","isTestProvider":false}`.
- Super-admin password sign-in → 200. The session role is SUPER_ADMIN, and `GET /api/v1/admin/orders` → 200.
- An OTP request answers a clean **503**, because Kavenegar rejects the non-credential key; there is no crash.
- **Guard:** `NODE_ENV=production` with `SMS_PROVIDER=sandbox` refuses to boot ("SMS_PROVIDER=sandbox cannot be used in production"). This is tested on the image, and also runs in CI.
- **Credit in production, activated with the SQL from the guide:**
  - `/api/v1/credit/plans` returns `items: []`, flagged `isSandbox: true`, so no purchase can start.
  - Resetting the settings returns `creditEnabled: false`.
  - New unit test `credit-provider.registry.spec.ts` (7 tests):
    - `CREDIT_PROVIDER_NOT_ALLOWED` for SANDBOX_BANK in production;
    - `CREDIT_PROVIDER_NOT_IMPLEMENTED` for SAMAN_BANK, BLUBANK and DIGIPAY;
    - `CREDIT_PROVIDER_MISCONFIGURED` when the sandbox rules are missing.

## 4. nginx

| Check | Result |
|---|---|
| `nginx -t` on the rendered configuration | OK |
| HTTP → HTTPS | `301 https://shop.test/x?y=1` (query string kept) |
| `www` → canonical | 301 |
| Unknown SNI | handshake rejected (`ssl_reject_handshake`) |
| TLS 1.1 | refused; TLS 1.2 and 1.3 accepted |
| Headers | HSTS `max-age=63072000; includeSubDomains`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`, `Content-Security-Policy`, `X-Request-ID`; `Server: nginx` (no version) |
| Compression | pages `content-encoding: br`; `/_next/static` gzip with `cache-control: public, max-age=31536000, immutable` (upstream header replaced, not duplicated) |
| Forwarded headers (echo upstream, spoofed `X-Forwarded-For: 6.6.6.6` sent) | Upstream received `x-forwarded-for: 127.0.0.1`, `x-real-ip: 127.0.0.1`, `x-forwarded-proto: https`, `host` / `x-forwarded-host: shop.test`, an `x-request-id`, and **no** `accept-encoding` → the spoofed value is overwritten, never appended |
| `TRUSTED_PROXY_CIDRS="10.0.0.0/8, 172.16.0.0/12"` | Renders `set_real_ip_from` for each CIDR + `real_ip_recursive on` |
| Body limits | `/api/v1/cart/items` 3 MB → 413; `/api/v1/media/upload/*` 3 MB → 200, 14.3 MiB → 200, 16 MB → 413 |
| API burst (120 parallel requests) | 64 × 200 and 56 × 429 (15 r/s, burst 60) |
| Sign-in limiter | 11 × passed, then 429 with the JSON body `{"statusCode":429,…}` in Persian; `/api/session/verify` and `/api/v1/auth/otp/request` share the budget; `GET /api/session` is unaffected |
| Dotfiles (`/.env`) | 403 |
| ACME webroot | a token written by the certbot container is served at `http://…/.well-known/acme-challenge/t1` |
| Certificate switch | the self-signed 7-day placeholder is replaced by a certificate in the Let's Encrypt layout (`live/<domain>/`) after `docker-entrypoint.sh reload`; the served certificate changed |

**Real finding 1:** the first version of the sign-in limiter used a regex `location`, which the `^~ /api/` prefix location shadows. It never fired. It was replaced by exact-match locations, and the limiter was re-tested.

**Real finding 2:** after the first `certbot certonly`, a plain `nginx -s reload` would not have switched away from the placeholder certificate. The `reload` subcommand was added and is used in the guide and in the systemd renewal unit.

## 5. Backup and restore (`tmpdoc/p11verify/backup-test.sh`, 19/19)

**Method:**
- A fingerprint is taken for every table in `public`: `count(*)` + `md5` over the sorted `md5(row::text)` of all rows.
- Every sequence's `last_value` is recorded as well: 33 objects, 134 rows.

| # | Check | Result |
|---|---|---|
| 1 | Plain backup: `pg_dump -Fc -Z6`, 281 archive entries, read back with `pg_restore --list` | ✅ |
| 2 | Encrypted backup (GnuPG AES-256); the file contains no `PGDMP` plaintext header | ✅ |
| 3 | File modes 600, directory 700; `.sha256` + `.meta` (server version, Prisma migration head, plaintext checksum) | ✅ |
| 4 | `--check-only` on both backups | ✅ |
| 5 | Tampered file (one byte changed) → `checksum MISMATCH` | ✅ |
| 6 | Missing `.sha256` → refused | ✅ |
| 7 | Wrong passphrase → `decryption failed` | ✅ |
| 8 | `--target-db` equal to the live DB → refused | ✅ |
| 9 | Wrong confirmation → aborted, "nothing was changed" | ✅ |
| 10 | Aborted runs leave no scratch database | ✅ |
| 11 | **Drill:** the encrypted backup restored into `shopino_drill` has the **identical** fingerprint to the live DB | ✅ |
| 12 | Live data changed after the backup (a new order through the full journey) | ✅ |
| 13 | **In-place restore:** the live DB fingerprint is **identical** to the backup-time state (zero data loss) | ✅ |
| 14 | The previous data is preserved as `shopino_prerestore_<ts>`, identical to the pre-restore state | ✅ |
| 15 | Backend + frontend are `healthy` after the restore; the full journey passes 18/18 on the restored DB | ✅ |
| 16 | Retention: dumps aged 45 and 31 days are pruned together with their sidecars | ✅ |
| 17 | Dumps aged 29 and 2 days are kept | ✅ |
| 18 | A concurrent second run is refused (`flock`) | ✅ |
| 19 | shellcheck clean | ✅ |

**Real finding:** `docker compose exec -T` forwards stdin, and the `psql` calls before the confirmation prompt consumed it, so the prompt read EOF. It aborted safely, but for the wrong reason. Non-interactive calls now read `/dev/null`, and the prompt was re-tested.

## 6. Deploy script (`deploy/scripts/deploy.sh`)

**Rejection paths (each verified):**
- env file mode 644;
- empty Kavenegar/Zarinpal keys;
- `SMS_PROVIDER=sandbox`;
- `PUBLIC_API_ORIGIN` ≠ `https://SHOPINO_DOMAIN`.

**Upgrade path over an existing database:**
1. pre-deploy backup;
2. `migrate deploy` (nothing pending);
3. seed (1 missing admin created);
4. rolling start and smoke test `/`, `/api/session`, `/api/v1/products` → 200.

**First install from empty volumes** (`down -v` first): `--build --seed` completed in **1 min 10 s**, using migrations and the production-profile seed, followed by the smoke test.

## 7. Seed production profile

| Check | Result |
|---|---|
| Unit tests `src/seed-profile.spec.ts` | 13/13 |
| Fresh DB via the migrator image: migrations, then the seed | 1 user (+989121234567, SUPER_ADMIN, active, Argon2id); 0 vendors, 0 products, 0 orders; 19 categories; 4 credit providers **all inactive**; `credit.enabled=false`; `credits.activeProvider=''` |
| Edited between runs: commission setting 12.00 → 9.50, a root category's name and commission 7.25, SANDBOX_BANK activated | All preserved by the second run |
| Second run with a different `SUPER_ADMIN_PASSWORD` and the `0098…` mobile format | Still exactly 1 user; the hash still verifies the **first** password and rejects the second |
| Development profile in CI | `verify:seed` → "deterministic and idempotent" |

## 8. CI

`actionlint` 1.7.7 → 0 issues (`ci.yml`, `deploy.yml`).

**Simulation of every CI job:**
- a clean copy without `node_modules`, `.env` or build outputs;
- `pnpm install --frozen-lockfile`;
- `scripts/ci/prepare-env.sh`;
- a fresh PostgreSQL/Redis from `docker-compose.yml`.

| Job | Steps | Result |
|---|---|---|
| quality | lint, typecheck | ✅ 2/2 tasks each |
| | backend unit | ✅ 335/335 (342/342 after the registry spec was added) |
| | frontend unit | ✅ 60/60 |
| backend-e2e | `db:generate`, `db:deploy`, `db:seed`, `verify:seed` | ✅ |
| | `test:e2e` | ✅ **274/274** (10 suites, 1 min 49 s) |
| build | `pnpm build` (includes `next build`) | ✅ |
| docker | four images, non-root checks | ✅ (the same builds as §2) |
| | sandbox refusal step | ✅ (run locally with the exact arguments; it first exposed two missing `REDIS_*` variables in the step, since fixed) |
| | nginx boot + HSTS | ✅ |
| infra-lint | shellcheck, prod-compose validation against the template, base-compose validation | ✅ |

**Real finding:** `prepare-env.sh` first used `sed`, whose replacement syntax treats `&` specially. That corrupted `DATABASE_URL` (`…&connection_limit…`), and the seed failed. It was rewritten as a literal line-by-line bash substitution and re-tested.

**Sandbox-only deviations:** turbo ran with `--concurrency=1`, and the copy lived on disk instead of `/tmp`, because this 2 GB sandbox's `/tmp` is RAM-backed. GitHub `ubuntu-24.04` runners have 16 GB and need neither change.

## 9. Not verifiable here, and how it was replaced

| Item | Replacement in this verification | What remains for the real server |
|---|---|---|
| Kavenegar delivery | Provider selection, the boot guard and a clean 503 with a non-credential key; `api.kavenegar.com` is not reachable from this sandbox | A real API key + approved template; sign in with a real mobile number |
| Zarinpal | The full payment state machine through nginx with the sandbox gateway; Zarinpal request/verify are covered by the Phase 7 unit tests | Merchant ID + registered domain; a small real payment |
| S3 (ArvanCloud/Liara) | Local storage through the same interface; S3 provider unit tests from Phase 4 | Bucket, key, bucket policy for `images/*`, CDN |
| Let's Encrypt | ACME webroot served; certificate switch in the Let's Encrypt directory layout | A real `certbot certonly` (§5 of the guide) |
| GitHub Actions / SSH deploy | actionlint + a job-by-job local simulation | Repository secrets/variables, the `production` environment, the first tagged release |
| systemd units | `systemd-analyze verify` (no errors) | `systemctl enable --now` on the server |
