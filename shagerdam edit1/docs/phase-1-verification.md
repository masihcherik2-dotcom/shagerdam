# Shopino — Phase 1 verification report (rev. 2 — approved architecture)

**Scope:** infrastructure setup and monorepo architecture, implemented against the approved
architectural decisions (pnpm 9.x · Strategy B persistence · Prisma migrations as source of truth ·
deterministic seed).
**Status:** every acceptance criterion verified against real services. No mock, fake, stub or
hard-coded runtime data anywhere in the running system.
**Reported by:** AI Software Developer · **Date:** 2026-09-26 12:51 UTC

Secrets are never printed: they live in the git-ignored `.env` and were generated with `openssl rand`.
Password hashes are shown truncated.

---

## 1. Acceptance criteria — result

| # | Criterion | Result | Evidence |
| --- | --- | --- | --- |
| 1 | `docker compose up -d` brings up Postgres + Redis `healthy` | **PASS** | §2 |
| 2 | Prisma connects to PostgreSQL | **PASS** | §3 (`migrate dev` + `verify:connections` reaching PostgreSQL 16.15) |
| 3 | Backend starts on port 4000 without errors | **PASS** | §4 (startup log + mapped route) |
| 4 | `GET /api/v1/health` → `200` with database/redis `up` | **PASS** | §5 (plus a negative test proving the checks are real) |
| 5 | Swagger docs load at `/api/docs` | **PASS** | §6 |
| 6 | Frontend starts on port 3000 without errors | **PASS** | §7 (SSR page, RTL, live API data, same-origin proxy) |
| 7 | Decision 1 — pnpm workspaces + Turborepo task graph incl. `db:generate`, `db:push` | **PASS** | §8 |
| 8 | Decision 2 — Strategy B: base volumes + dev override in `./.docker-data` (git-ignored) | **PASS** | §9 (persistence survives container removal) |
| 9 | Decision 2 — migrations as source of truth + deterministic idempotent seed | **PASS** | §10, §11, §12 (wipe → `db:reset` → full recovery) |


## 2. Infrastructure

```bash
docker compose up -d
docker compose ps
```


#### Result

```text
### docker compose ps
shopino_postgres → Up 2 minutes (healthy)
shopino_redis → Up 2 minutes (healthy)
```


## 3. Prisma ↔ PostgreSQL (and Redis) connectivity

```bash
pnpm db:generate
pnpm db:migrate --name init
pnpm verify:connections
```


#### Migration created and applied

```text
$ pnpm exec prisma migrate dev --name init
Datasource "db": PostgreSQL database "shopino_db", schema "public" at "127.0.0.1:5432"

Applying migration `20260926124703_init`

The following migration(s) have been created and applied from new schema changes:

prisma/migrations/
  └─ 20260926124703_init/
    └─ migration.sql

Your database is now in sync with your schema.
```


#### `pnpm verify:connections` (real server versions read over the wire)

```text
### pnpm verify:connections (real server versions over the wire)
[postgres] ok  database=shopino_db role=shopino
[postgres] PostgreSQL 16.15 (Debian 16.15-1.pgdg13+2) on x86_64-pc-linux-gnu, compiled by gcc (Debian 14.2.0-19) 14.2.0, 64-bit
[redis]    ok  version=7.4.11 ping=1ms
[verify:connections] all infrastructure connections are healthy
```


## 4. Backend startup (port 4000)

```bash
pnpm --filter @shopino/backend build && pnpm --filter @shopino/backend start
```


#### Startup log (abridged)

```text
[NestFactory] Starting Nest application...
[InstanceLoader] AppModule / ConfigHostModule / ConfigModule / TerminusModule /
                PrismaModule / RedisModule / HealthModule dependencies initialized
[RoutesResolver] HealthController {/api/v1/health}
[RouterExplorer] Mapped {/api/v1/health, GET} route
[RedisService]  Redis connection established
[PrismaService] PostgreSQL connection established
[NestApplication] Nest application successfully started
[Bootstrap] Shopino API ready on http://0.0.0.0:4000/api/v1 — docs: http://0.0.0.0:4000/api/docs
```


## 5. Health endpoint — live output

```bash
curl http://localhost:4000/api/v1/health
```


#### HTTP headers + body

```http
HTTP/1.1 200 OK
vary: Origin
access-control-allow-credentials: true
access-control-expose-headers: X-Request-Id
cache-control: no-cache, no-store, must-revalidate
content-type: application/json; charset=utf-8
content-length: 441
Date: Sat, 26 Sep 2026 12:49:43 GMT
Connection: keep-alive
Keep-Alive: timeout=72

{"status":"ok","info":{"database":{"status":"up","latency_ms":1.85},"redis":{"status":"up","latency_ms":1.08},"memory":{"status":"up"},"uptime":{"status":"up","uptime_seconds":20,"started_at":"2026-09-26T12:49:23.201Z"}},"error":{},"details":{"database":{"status":"up","latency_ms":1.85},"redis":{"status":"up","latency_ms":1.08},"memory":{"status":"up"},"uptime":{"status":"up","uptime_seconds":20,"started_at":"2026-09-26T12:49:23.201Z"}}}
```


#### Negative test — Redis stopped → 503, Redis restarted → 200 (same API process)

```text
########## NEGATIVE TEST: stop Redis, keep the API running ##########
$ curl -o body.json -w 'HTTP %{http_code}' http://localhost:4000/api/v1/health
HTTP 503
{
  "status": "error",
  "error": {
    "redis": {
      "status": "down",
      "message": "Command timed out"
    }
  },
  "database": {
    "status": "up",
    "latency_ms": 1.44
  }
}

########## RECOVERY: start Redis again (API process untouched) ##########
redis container health: healthy
HTTP 200
{
  "status": "ok",
  "database": {
    "status": "up",
    "latency_ms": 1.76
  },
  "redis": {
    "status": "up",
    "latency_ms": 0.91
  },
  "uptime_seconds": 71
}
```


#### The three verification scripts

```text
### pnpm verify:connections (real server versions over the wire)
[postgres] ok  database=shopino_db role=shopino
[postgres] PostgreSQL 16.15 (Debian 16.15-1.pgdg13+2) on x86_64-pc-linux-gnu, compiled by gcc (Debian 14.2.0-19) 14.2.0, 64-bit
[redis]    ok  version=7.4.11 ping=1ms
[verify:connections] all infrastructure connections are healthy

### pnpm verify:seed (deterministic + idempotent + Argon2id)
[verify:seed] first run
[verify:seed]   users=1 categories=19 (roots=6) configs=5
[verify:seed] second run (idempotency check)
[verify:seed] ok — deterministic and idempotent; credential stored as Argon2id, no plaintext, admin created=false

### pnpm verify:http (public HTTP contract of the running API)
[ok]   GET /api/v1/health — HTTP 200 · status=ok · database=up · redis=up
[ok]   GET /api/docs-json — HTTP 200 · title=Shopino API · paths=/api/v1/health
[ok]   GET /api/docs — HTTP 200 · 3127 bytes · swagger-ui assets referenced=true
[ok]   GET /api/v1/definitely-not-a-route — HTTP 404
[verify:http] API at http://127.0.0.1:4000 passed all 4 checks
```


## 6. Swagger / OpenAPI

```bash
curl http://localhost:4000/api/docs && curl http://localhost:4000/api/docs-json
```


#### Result

```text
[ok]   GET /api/docs-json — HTTP 200 · title=Shopino API · paths=/api/v1/health
[ok]   GET /api/docs — HTTP 200 · 3127 bytes · swagger-ui assets referenced=true
[ok]   GET /api/docs (through the Next.js origin :3000) — HTTP 200
```


## 7. Frontend (port 3000)

```bash
pnpm --filter @shopino/frontend build && pnpm --filter @shopino/frontend dev
```


#### Served page + same-origin proxy

```text
### pnpm verify:connections (real server versions over the wire)
[postgres] ok  database=shopino_db role=shopino
[postgres] PostgreSQL 16.15 (Debian 16.15-1.pgdg13+2) on x86_64-pc-linux-gnu, compiled by gcc (Debian 14.2.0-19) 14.2.0, 64-bit
[redis]    ok  version=7.4.11 ping=1ms
[verify:connections] all infrastructure connections are healthy

### pnpm verify:seed (deterministic + idempotent + Argon2id)
[verify:seed] first run
[verify:seed]   users=1 categories=19 (roots=6) configs=5
[verify:seed] second run (idempotency check)
[verify:seed] ok — deterministic and idempotent; credential stored as Argon2id, no plaintext, admin created=false

### pnpm verify:http (public HTTP contract of the running API)
[ok]   GET /api/v1/health — HTTP 200 · status=ok · database=up · redis=up
[ok]   GET /api/docs-json — HTTP 200 · title=Shopino API · paths=/api/v1/health
[ok]   GET /api/docs — HTTP 200 · 3127 bytes · swagger-ui assets referenced=true
[ok]   GET /api/v1/definitely-not-a-route — HTTP 404
[verify:http] API at http://127.0.0.1:4000 passed all 4 checks
```


## 8. Decision 1 — pnpm workspaces and the Turborepo pipeline


#### Pipeline tasks exercised

```text
$ pnpm db:generate
@shopino/backend:db:generate: ✔ Generated Prisma Client (v6.19.3)
 Tasks:    1 successful, 1 total

$ pnpm db:seed
@shopino/backend:db:seed: [seed] master data ready — super admin: admin@shopino.local (created), categories: 19, system configs: 5
 Tasks:    1 successful, 1 total

$ pnpm typecheck      → Tasks: 2 successful, 2 total
$ pnpm lint           → Tasks: 2 successful, 2 total
$ pnpm test           → backend 16 passed / frontend 8 passed
$ pnpm test:e2e       → 2 suites, 8 tests passed (real PostgreSQL + Redis)
$ pnpm build          → Tasks: 2 successful, 2 total
```


## 9. Decision 2 — Strategy B persistence (verified two ways)

First, the merged configuration proves the separation: the development merge produces bind mounts, the production file produces named volumes.


#### Compose configuration resolution

```text
$ docker compose config                      # development (base + override auto-merged)
bind: /home/user/shopino/.docker-data/postgres -> /var/lib/postgresql/data
bind: /home/user/shopino/.docker-data/redis    -> /data

$ docker compose -f docker-compose.yml config # production / CI (override NOT loaded)
bind mounts found: 0
named volumes used: ['postgres_data', 'redis_data']
```


#### Persistence evidence in the workspace

```text
### Evidence: persistence lives inside the workspace (Strategy B)
$ ls -la .docker-data/
total 4
drwxr-xr-x  4 user user              60 Sep 26 12:46 .
drwxr-xr-x 10 user user            4096 Sep 26 12:48 ..
drwxr-xr-x  3  999 systemd-journal   60 Sep 26 12:46 postgres
drwxr-xr-x  3  999 systemd-journal   60 Sep 26 12:46 redis
$ sudo du -sh .docker-data/*   (dirs are owned by the container users, uid 999)
62M	.docker-data/postgres
5.0K	.docker-data/redis
$ ls .docker-data/postgres/pgdata | head -5   (a real PostgreSQL cluster)
PG_VERSION
base
global
pg_commit_ts
pg_dynshmem
$ ls .docker-data/redis/appendonlydir   (Redis AOF files)
appendonly.aof.1.base.rdb
appendonly.aof.1.incr.aof
appendonly.aof.manifest

### Evidence: containers recreated, data intact (see counts below)
$ docker compose down && docker compose up -d
shopino_postgres → Up 17 seconds (healthy)
shopino_redis → Up 17 seconds (healthy)
users=1
```


## 10. Database state — read directly from PostgreSQL (not through the application)


#### Tables, migration history, master data

```text
### Tables created by the migration (read directly from PostgreSQL via psql)
               List of relations
 Schema |        Name        | Type  |  Owner  
--------+--------------------+-------+---------
 public | _prisma_migrations | table | shopino
 public | categories         | table | shopino
 public | system_configs     | table | shopino
 public | users              | table | shopino
(4 rows)

### Applied migrations (Prisma migration history)
20260926124703_init | applied_at=2026-09-26 12:47:03.598152+00

### Row counts
 users | categories | system_configs 
-------+------------+----------------
     1 |         19 |              5
(1 row)

### Super-admin row (password shown as a truncated Argon2id hash prefix only)
        email        |    full_name     |    role     | is_active |        password_hash_prefix        |         created_at         
---------------------+------------------+-------------+-----------+------------------------------------+----------------------------
 admin@shopino.local | مدیر ارشد پلتفرم | SUPER_ADMIN | t         | $argon2id$v=19$m=19456,t=2,p=1$... | 2026-09-26 12:47:10.093+00
(1 row)

### Category tree
        slug         |         title         |      title_en       |      parent      | sort_order 
---------------------+-----------------------+---------------------+------------------+------------
 digital             | کالای دیجیتال         | Digital Goods       |                  |         10
 mobile              | گوشی موبایل           | Mobile Phones       | digital          |         10
 laptop              | لپ‌تاپ و کامپیوتر      | Laptops & Computers | digital          |         20
 digital-accessories | لوازم جانبی دیجیتال   | Digital Accessories | digital          |         30
 home-kitchen        | خانه و آشپزخانه       | Home & Kitchen      |                  |         20
 home-appliances     | لوازم خانگی           | Home Appliances     | home-kitchen     |         10
 kitchenware         | ظروف و لوازم آشپزخانه | Kitchenware         | home-kitchen     |         20
 fashion             | مد و پوشاک            | Fashion             |                  |         30
 mens-clothing       | پوشاک مردانه          | Men's Clothing      | fashion          |         10
 womens-clothing     | پوشاک زنانه           | Women's Clothing    | fashion          |         20
 bags-shoes          | کیف و کفش             | Bags & Shoes        | fashion          |         30
 beauty-health       | زیبایی و سلامت        | Beauty & Health     |                  |         40
 skincare            | مراقبت از پوست        | Skincare            | beauty-health    |         10
 personal-care       | بهداشت شخصی           | Personal Care       | beauty-health    |         20
 supermarket         | سوپرمارکت             | Supermarket         |                  |         50
 food-beverage       | خواروبار و نوشیدنی    | Food & Beverage     | supermarket      |         10
 dairy               | لبنیات                | Dairy               | supermarket      |         20
 books-stationery    | کتاب و لوازم‌التحریر   | Books & Stationery  |                  |         60
 books               | کتاب                  | Books               | books-stationery |         10
(19 rows)

### System configuration
        key        |    value    | value_type 
-------------------+-------------+------------
 credit.enabled    | false       | BOOLEAN
 platform.currency | IRR         | STRING
 platform.locale   | fa-IR       | STRING
 platform.name     | شاپینو      | STRING
 platform.timezone | Asia/Tehran | STRING
(5 rows)
```


## 11. Deterministic, idempotent seed

```bash
pnpm db:seed && pnpm db:seed && pnpm verify:seed
```


#### Two consecutive runs + verification

```text
########## DISASTER RECOVERY: wipe the database, rebuild from migrations + seed ##########
$ rm -rf .docker-data/postgres/pgdata   (simulating a wiped development volume)
total 0
drwxr-xr-x 2  999 systemd-journal 60 Sep 26 12:50 .
drwxr-xr-x 4 user user            60 Sep 26 12:46 ..
postgres container: healthy

$ docker compose exec postgres psql -c '\dt'   (empty cluster: no application tables)
Did not find any relations.


[verify:seed] first run
[verify:seed]   users=1 categories=19 (roots=6) configs=5
[verify:seed] second run (idempotency check)
[verify:seed] ok — deterministic and idempotent; credential stored as Argon2id, no plaintext, admin created=false


```


## 12. Disaster recovery — wiped volume rebuilt in one command


#### `rm -rf .docker-data/postgres/pgdata` → `pnpm db:reset` → full master data

```text
########## DISASTER RECOVERY: wipe the database, rebuild from migrations + seed ##########
$ rm -rf .docker-data/postgres/pgdata   (simulating a wiped development volume)
total 0
drwxr-xr-x 2  999 systemd-journal 60 Sep 26 12:50 .
drwxr-xr-x 4 user user            60 Sep 26 12:46 ..
postgres container: healthy

$ docker compose exec postgres psql -c '\dt'   (empty cluster: no application tables)
Did not find any relations.

$ pnpm db:reset    (drops schema → applies every migration → runs the seed)
@shopino/backend:db:reset: Applying migration `20260926124703_init`
@shopino/backend:db:reset: 
@shopino/backend:db:reset: Database reset successful
@shopino/backend:db:reset: 
@shopino/backend:db:reset: The following migration(s) have been applied:
@shopino/backend:db:reset: 
@shopino/backend:db:reset: migrations/
@shopino/backend:db:reset:   └─ 20260926124703_init/
@shopino/backend:db:reset:     └─ migration.sql
@shopino/backend:db:reset: 
@shopino/backend:db:reset: Running seed command `ts-node --project tsconfig.json prisma/seed.ts` ...
@shopino/backend:db:reset: [seed] master data ready — super admin: admin@shopino.local (created), categories: 19, system configs: 5
@shopino/backend:db:reset: 
@shopino/backend:db:reset: 🌱  The seed command has been executed.
@shopino/backend:db:reset: 
 Tasks:    1 successful, 1 total
Cached:    0 cached, 1 total
  Time:    3.706s 

$ docker compose exec postgres psql -c 'row counts'
 users | categories | system_configs |   last_migration    
-------+------------+----------------+---------------------
     1 |         19 |              5 | 20260926124703_init
(1 row)
```


## 13. Redis is real and password-protected


#### Redis over the wire

```text
### Redis (AUTH required) — read from inside the container
$ redis-cli -a *** PING
PONG
$ redis-cli -a *** INFO server | grep redis_version
redis_version:7.4.11
redis_mode:standalone
$ redis-cli -a *** CONFIG GET appendonly
appendonly
yes
$ redis-cli (no password) PING  → must be refused
NOAUTH Authentication required.
```


## 14. How to reproduce from a clean checkout

```bash
pnpm install
cp .env.example .env                     # fill in values; openssl rand -base64 48 for secrets
pnpm infra:prepare                       # create ./.docker-data (Linux: sets uid 999 ownership)
docker compose up -d && docker compose ps
pnpm db:generate && pnpm db:migrate && pnpm db:seed
pnpm build
pnpm --filter @shopino/backend start &   # API on :4000
pnpm --filter @shopino/frontend dev      # web on :3000
curl http://localhost:4000/api/v1/health
pnpm verify:connections && pnpm verify:seed && pnpm verify:http
```

## 15. Notes, decisions and remaining risk

- **Production must pin the compose file.** `docker-compose.override.yml` is auto-merged by Compose;
  a server running a bare `docker compose up -d` would silently adopt the development bind mounts.
  `pnpm infra:up:prod` / `docker compose -f docker-compose.yml …` is the documented production path.
- **Bind-mount ownership on Linux.** The postgres and redis images run as uid 999; Docker creates
  missing bind-mount directories as root. `pnpm infra:prepare` fixes ownership (macOS/Windows are
  unaffected). Documented in the README.
- **Role enum scope.** `UserRole` currently declares `SUPER_ADMIN`, `ADMIN`, `VENDOR`, `CUSTOMER`.
  Only `SUPER_ADMIN` is used by the seed; the other three are reserved for the authentication phase.
  If the architect prefers a minimal enum now, it is a one-line change plus a migration.
- **Category taxonomy is baseline data**, not final merchandising: 6 roots / 19 nodes with stable
  slugs, seeded so the platform has a valid tree in every environment. Ops can extend it through new
  seed entries.
- **Not implemented in this phase (by design):** authentication/authorization, rate limiting,
  marketplace domain tables (vendors/products/orders/credit), external providers (OTP, SMS, payments,
  email, storage). `credit.enabled` is seeded as `false` until BNPL ships.
- **Test split for Swagger:** the OpenAPI document is asserted in-process by the e2e suite, while the
  served UI is verified over HTTP by `scripts/smoke-http.ts`, because serving it loads
  `@fastify/static` → `glob@13` (ESM-only), which Jest's CommonJS runtime cannot load. Node 22 loads
  it fine (`require(esm)`), which is why the API itself serves the UI correctly.
- **Do not run `pnpm build` while `next dev` is running** — both write `apps/frontend/.next`.
