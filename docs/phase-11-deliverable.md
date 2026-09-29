# Phase 11 — Deliverable: production hardening (infrastructure assets)

This document contains the infrastructure file tree and the **full contents** of every Dockerfile, compose file, nginx configuration, workflow and script delivered in Phase 11. Verification results are in `docs/phase-11-verification.md`; the operator runbook is `docs/production-deployment-guide.md`.

## 1. File tree

```
.
├── .dockerignore                         # build context: no secrets, no build outputs
├── .github/workflows/
│   ├── ci.yml                            # PR + main: lint, typecheck, unit, e2e, build, images, infra lint
│   └── deploy.yml                        # tag/manual: build+push images, SSH deploy (approval-gated)
├── apps/backend/
│   ├── Dockerfile                        # deps → builder → migrator | runner (node:22-alpine, non-root, dumb-init)
│   ├── prisma/seed.ts                    # + production seed profile (changed)
│   └── src/
│       ├── seed-profile.spec.ts          # 13 tests (new)
│       └── modules/credit/providers/credit-provider.registry.spec.ts   # 7 tests (new)
├── apps/frontend/
│   ├── Dockerfile                        # Next.js standalone (non-root)
│   └── next.config.ts                    # standalone output when NEXT_OUTPUT=standalone (changed)
├── deploy/
│   ├── env/production.env.example        # template of /opt/shopino/.env.production
│   ├── nginx/
│   │   ├── Dockerfile                    # alpine nginx + brotli module
│   │   ├── docker-entrypoint.sh          # render config, certificates, reload loop, `reload` subcommand
│   │   ├── nginx.conf                    # timeouts, JSON logs, rate-limit zones, gzip + brotli
│   │   ├── snippets/proxy-frontend.conf  # forwarded headers (XFF overwrite), header hygiene
│   │   ├── snippets/security-headers.conf# HSTS, nosniff, XFO, Referrer-Policy, CSP, …
│   │   └── templates/shopino.conf.template # :80 ACME+redirect, :443 TLS, locations & limits
│   ├── scripts/deploy.sh                 # validate env → images → backup → migrate → [seed] → up → smoke
│   └── systemd/
│       ├── shopino-backup.{service,timer}          # daily 03:30
│       └── shopino-certbot-renew.{service,timer}   # twice daily
├── docker-compose.prod.yml               # nginx, frontend, backend, postgres, redis (+ ops: migrate, certbot)
├── docs/
│   ├── phase-11-deliverable.md           # this file
│   ├── phase-11-verification.md
│   └── production-deployment-guide.md
├── scripts/
│   ├── backup/{lib.sh,backup-postgres.sh,restore-postgres.sh}
│   └── ci/prepare-env.sh                 # CI .env with random secrets + sandbox providers
└── .env.example                          # + SEED_PROFILE, SUPER_ADMIN_MOBILE, SEED_SUPPORT_*/SEED_FINANCE_* (changed)
```

## 2. Architecture decision announced in this phase

The brief asked nginx to proxy `/api/` to the backend on port 4000. Since Phase 10 the browser's `/api/v1/*` and `/api/session/*` are served by the **Next.js BFF**, which converts the httpOnly session cookies into Bearer tokens; proxying `/api/` straight to the API would make every authenticated call fail with 401. nginx therefore sends all public traffic (including `/api/`) to the frontend, and the API stays on the private network (the BFF is its only client). Upload size, auth and API rate limits are applied by nginx on the public paths that lead there.

## 3. File contents

### Docker

#### `apps/backend/Dockerfile`

```dockerfile
# syntax=docker/dockerfile:1.7
# =============================================================================
# Shopino API (NestJS + Fastify + Prisma) — production image
# -----------------------------------------------------------------------------
# Build from the REPOSITORY ROOT (pnpm workspace):
#   docker build -f apps/backend/Dockerfile -t shopino/backend .                 # runtime
#   docker build -f apps/backend/Dockerfile --target migrator -t shopino/migrator .
#
# Stages
#   base     node:22-alpine + pnpm (corepack) + openssl (Prisma engines)
#   deps     workspace install of the backend's dependency graph (cached layer)
#   builder  prisma generate + nest build, then `pnpm deploy --prod` into /prod
#   migrator full toolchain (Prisma CLI, ts-node): `prisma migrate deploy` and the
#            idempotent seed. Run once per release, never exposed.
#   runner   production dependencies + dist only, non-root `node`, dumb-init (PID 1)
#
# No secret is read at build time: configuration arrives as environment variables
# at run time (docker-compose.prod.yml → env_file), and the API validates it at
# boot (sandbox providers are refused under NODE_ENV=production).
# =============================================================================

ARG NODE_IMAGE=node:22-alpine

# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true \
    NEXT_TELEMETRY_DISABLED=1
# libc6-compat: prebuilt native addons (argon2, sharp) on musl; openssl: Prisma engines.
RUN apk add --no-cache libc6-compat openssl \
 && corepack enable \
 && corepack prepare pnpm@9.15.9 --activate
WORKDIR /app

# ---------------------------------------------------------------------------
FROM base AS deps
# Manifests only, so the dependency layer is reused until they change.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY packages/config/package.json packages/config/
COPY apps/backend/package.json apps/backend/
COPY apps/frontend/package.json apps/frontend/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @shopino/backend...

# ---------------------------------------------------------------------------
FROM deps AS builder
COPY turbo.json ./
COPY packages/config packages/config
COPY apps/backend apps/backend
RUN pnpm --filter @shopino/backend build
# Self-contained production tree: package.json, dist, prisma/ and prod node_modules.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter @shopino/backend deploy --prod /prod/backend \
 && rm -rf /prod/backend/dist && cp -r apps/backend/dist /prod/backend/dist \
 # The generated Prisma client lives inside node_modules; regenerate it for the
 # deployed tree with the builder's CLI (the CLI itself stays out of /prod).
 && cd /prod/backend \
 && /app/apps/backend/node_modules/.bin/prisma generate --schema=prisma/schema.prisma \
 && rm -rf /prod/backend/src /prod/backend/test /prod/backend/scripts \
            /prod/backend/Dockerfile /prod/backend/eslint.config.mjs /prod/backend/jest.config.js \
 # Size pruning, runtime-neutral (verified by booting the image against PostgreSQL):
 #  - the Prisma CLI tree pulled in as a peer of @prisma/client (CLI, schema/migration
 #    engines, effect, typescript) — migrations run from the `migrator` target;
 #  - wasm/edge query engines of databases other than PostgreSQL;
 #  - glibc builds of sharp/libvips (this image is musl).
 && cd /prod/backend/node_modules/.pnpm \
 && rm -rf prisma@* @prisma+engines@* @prisma+engines-version@* @prisma+fetch-engine@* @prisma+get-platform@* \
           effect@* typescript@* @img+sharp-linux-x64@* @img+sharp-libvips-linux-x64@* \
 && find . -path '*@prisma/client/runtime/*' \( -name '*mysql*' -o -name '*sqlite*' -o -name '*sqlserver*' -o -name '*cockroachdb*' \) -delete

# ---------------------------------------------------------------------------
FROM builder AS migrator
# Operational image: migrations + seed. Same source revision as the runner.
WORKDIR /app/apps/backend
RUN chown -R node:node /app/apps/backend
USER node
# Binaries are called directly (no pnpm/corepack at runtime): the migrator must
# work on hosts without registry access.
#   migrations : docker compose run --rm migrate                  (default CMD)
#   seed       : docker compose run --rm migrate ts-node --project tsconfig.json prisma/seed.ts
ENV NODE_ENV=production \
    PATH=/app/apps/backend/node_modules/.bin:$PATH
CMD ["prisma", "migrate", "deploy"]

# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runner
RUN apk add --no-cache dumb-init openssl libc6-compat
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4000 \
    STORAGE_LOCAL_ROOT=/app/uploads
WORKDIR /app
COPY --from=builder --chown=node:node /prod/backend ./
# Writable only where the app must write: the local storage root (a volume in
# production when STORAGE_PROVIDER=local; unused with s3).
RUN mkdir -p /app/uploads && chown node:node /app/uploads
USER node
EXPOSE 4000
# Readiness = the API can reach PostgreSQL and Redis (GET /api/v1/health).
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=5 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/api/v1/health" || exit 1
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/main.js"]
```

#### `apps/frontend/Dockerfile`

```dockerfile
# syntax=docker/dockerfile:1.7
# =============================================================================
# Shopino web (Next.js 15 App Router) — production image, standalone output
# -----------------------------------------------------------------------------
# Build from the REPOSITORY ROOT (pnpm workspace):
#   docker build -f apps/frontend/Dockerfile -t shopino/frontend .
#
# Stages
#   base     node:22-alpine + pnpm (corepack)
#   deps     workspace install of the frontend's dependency graph (cached layer)
#   builder  `next build` with NEXT_OUTPUT=standalone (self-contained server.js)
#   runner   standalone server + static assets only, non-root `node`, dumb-init
#
# Runtime configuration (read on the server, never baked in):
#   BACKEND_INTERNAL_URL   e.g. http://backend:4000 — the BFF's upstream
# Build-time (inlined into the browser bundle, not secret):
#   NEXT_PUBLIC_API_BASE_URL (default /api/v1 — the same-origin BFF)
# =============================================================================

ARG NODE_IMAGE=node:22-alpine

# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true \
    NEXT_TELEMETRY_DISABLED=1
RUN apk add --no-cache libc6-compat \
 && corepack enable \
 && corepack prepare pnpm@9.15.9 --activate
WORKDIR /app

# ---------------------------------------------------------------------------
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY packages/config/package.json packages/config/
COPY apps/backend/package.json apps/backend/
COPY apps/frontend/package.json apps/frontend/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @shopino/frontend...

# ---------------------------------------------------------------------------
FROM deps AS builder
ARG NEXT_PUBLIC_API_BASE_URL=/api/v1
ENV NEXT_PUBLIC_API_BASE_URL=${NEXT_PUBLIC_API_BASE_URL} \
    NEXT_OUTPUT=standalone \
    NODE_ENV=production
COPY turbo.json ./
COPY packages/config packages/config
COPY apps/frontend apps/frontend
RUN pnpm --filter @shopino/frontend build

# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runner
RUN apk add --no-cache dumb-init
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000
WORKDIR /app
# outputFileTracingRoot is the monorepo root, so the standalone tree mirrors it:
# /app/apps/frontend/server.js + the traced node_modules.
COPY --from=builder --chown=node:node /app/apps/frontend/.next/standalone ./
COPY --from=builder --chown=node:node /app/apps/frontend/.next/static ./apps/frontend/.next/static
USER node
EXPOSE 3000
# Liveness of the Next.js server: GET /api/session without cookies is answered
# locally ({ user: null }) and does not depend on the backend.
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/api/session" || exit 1
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "apps/frontend/server.js"]
```

#### `.dockerignore`

```
# Build context hygiene for apps/backend/Dockerfile and apps/frontend/Dockerfile.
# Both images build from the repository root (pnpm workspace), so everything that
# is not source must stay out of the context: secrets, dependencies, build output
# and local data.

# Secrets and local environment — never baked into an image.
.env
.env.*
!.env.example
**/*.pem
**/*.key
deploy/env/*.env

# Dependencies and build output (rebuilt inside the image).
**/node_modules
**/dist
**/.next
**/out
**/coverage
**/*.tsbuildinfo
**/.turbo

# Local data and uploads.
.docker-data
apps/backend/uploads
backups

# VCS, CI, docs and editor files are not needed to build.
.git
.github
docs
**/*.log
.idea
.vscode
**/.DS_Store
```

#### `docker-compose.prod.yml`

```yaml
# =============================================================================
# Shopino — PRODUCTION stack (single host)
# -----------------------------------------------------------------------------
#   nginx ──edge──► frontend (Next.js + BFF) ──app──► backend (NestJS API)
#                                                        │
#                                                 data (internal network)
#                                                        ├─► postgres
#                                                        └─► redis
#
# Only nginx publishes ports (80/443). The API, the database and Redis are
# unreachable from the internet; the `data` network has no outbound route.
#
# Usage (see docs/production-deployment-guide.md):
#   export SHOPINO_ENV_FILE=/opt/shopino/.env.production
#   docker compose -f docker-compose.prod.yml --env-file "$SHOPINO_ENV_FILE" pull   # or: build
#   docker compose -f docker-compose.prod.yml --env-file "$SHOPINO_ENV_FILE" run --rm migrate
#   docker compose -f docker-compose.prod.yml --env-file "$SHOPINO_ENV_FILE" up -d
#
# Every secret comes from the env file (template: deploy/env/production.env.example).
# Required variables fail fast with a clear message instead of defaulting.
# =============================================================================

name: shopino-prod

x-logging: &logging
  driver: json-file
  options:
    max-size: "10m"
    max-file: "5"

x-hardening: &hardening
  restart: unless-stopped
  logging: *logging
  security_opt:
    - no-new-privileges:true

# Values the API must get from compose (service discovery), overriding the file.
x-backend-env: &backend-env
  NODE_ENV: production
  HOST: 0.0.0.0
  PORT: "4000"
  REDIS_HOST: redis
  REDIS_PORT: "6379"
  STORAGE_LOCAL_ROOT: /app/uploads

services:
  # ── PostgreSQL 16 ────────────────────────────────────────────────────────
  postgres:
    <<: *hardening
    image: postgres:16
    environment:
      POSTGRES_USER: ${POSTGRES_USER:?POSTGRES_USER is required}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}
      POSTGRES_DB: ${POSTGRES_DB:?POSTGRES_DB is required}
      POSTGRES_INITDB_ARGS: "--data-checksums"
      PGDATA: /var/lib/postgresql/data/pgdata
    command:
      - postgres
      - -c
      - max_connections=${POSTGRES_MAX_CONNECTIONS:-100}
      - -c
      - shared_buffers=${POSTGRES_SHARED_BUFFERS:-256MB}
      - -c
      - log_min_duration_statement=${POSTGRES_SLOW_QUERY_MS:-1000}
      - -c
      - password_encryption=scram-sha-256
    volumes:
      - postgres_data:/var/lib/postgresql/data
    shm_size: 256mb
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -h 127.0.0.1 -U \"$$POSTGRES_USER\" -d \"$$POSTGRES_DB\""]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 30s
    networks: [data]
    stop_grace_period: 60s
    deploy:
      resources:
        limits:
          memory: ${POSTGRES_MEMORY_LIMIT:-1g}

  # ── Redis 7 (rate limits, OTP, cache, future queues) ─────────────────────
  redis:
    <<: *hardening
    image: redis:7-alpine
    environment:
      REDIS_PASSWORD: ${REDIS_PASSWORD:?REDIS_PASSWORD is required}
    command:
      - redis-server
      - --requirepass
      - ${REDIS_PASSWORD:?REDIS_PASSWORD is required}
      - --appendonly
      - "yes"
      - --appendfsync
      - everysec
      - --maxmemory
      - ${REDIS_MAXMEMORY:-256mb}
      - --maxmemory-policy
      - noeviction
      - --save
      - ""
    volumes:
      - redis_data:/data
    read_only: true
    healthcheck:
      test: ["CMD-SHELL", "redis-cli --no-auth-warning -a \"$$REDIS_PASSWORD\" ping | grep -q PONG"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 10s
    networks: [data]
    deploy:
      resources:
        limits:
          memory: ${REDIS_MEMORY_LIMIT:-320m}

  # ── NestJS API (private) ─────────────────────────────────────────────────
  backend:
    <<: *hardening
    image: ${BACKEND_IMAGE:-shopino/backend:latest}
    build:
      context: .
      dockerfile: apps/backend/Dockerfile
      target: runner
    env_file:
      - ${SHOPINO_ENV_FILE:-.env.production}
    environment:
      <<: *backend-env
    volumes:
      # Used only when STORAGE_PROVIDER=local (single node); unused with s3.
      - uploads:/app/uploads
    read_only: true
    tmpfs:
      - /tmp:size=64m
    cap_drop: [ALL]
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    # `app` gives outbound access to SMS / payment / object-storage APIs;
    # `data` reaches PostgreSQL and Redis.
    networks: [app, data]
    stop_grace_period: 30s
    deploy:
      resources:
        limits:
          memory: ${BACKEND_MEMORY_LIMIT:-768m}

  # ── Next.js storefront, panels and BFF ───────────────────────────────────
  frontend:
    <<: *hardening
    image: ${FRONTEND_IMAGE:-shopino/frontend:latest}
    build:
      context: .
      dockerfile: apps/frontend/Dockerfile
    # Deliberately NO env_file: the web tier never holds database, JWT or
    # provider secrets. It only needs the private API address.
    environment:
      NODE_ENV: production
      HOSTNAME: 0.0.0.0
      PORT: "3000"
      BACKEND_INTERNAL_URL: http://backend:4000
    read_only: true
    tmpfs:
      - /tmp:size=64m
      - /app/apps/frontend/.next/cache:size=128m,uid=1000,gid=1000
    cap_drop: [ALL]
    depends_on:
      backend:
        condition: service_healthy
    networks: [edge, app]
    deploy:
      resources:
        limits:
          memory: ${FRONTEND_MEMORY_LIMIT:-512m}

  # ── nginx edge proxy (the only published service) ────────────────────────
  nginx:
    <<: *hardening
    image: ${NGINX_IMAGE:-shopino/nginx:latest}
    build:
      context: deploy/nginx
    environment:
      SHOPINO_DOMAIN: ${SHOPINO_DOMAIN:?SHOPINO_DOMAIN is required}
      SHOPINO_EXTRA_DOMAINS: ${SHOPINO_EXTRA_DOMAINS:-}
      CSP_EXTRA_IMG_SRC: ${CSP_EXTRA_IMG_SRC:-}
      CSP_FORM_ACTION_EXTRA: ${CSP_FORM_ACTION_EXTRA:-https://payment.zarinpal.com}
      TRUSTED_PROXY_CIDRS: ${TRUSTED_PROXY_CIDRS:-}
      FRONTEND_UPSTREAM: frontend:3000
    ports:
      - "${HTTP_BIND:-0.0.0.0}:80:80"
      - "${HTTPS_BIND:-0.0.0.0}:443:443"
    volumes:
      - letsencrypt:/etc/letsencrypt:ro
      - certbot_webroot:/var/www/certbot:ro
    cap_drop: [ALL]
    cap_add: [CHOWN, SETUID, SETGID, NET_BIND_SERVICE, DAC_OVERRIDE]
    depends_on:
      frontend:
        condition: service_healthy
    networks: [edge]
    deploy:
      resources:
        limits:
          memory: ${NGINX_MEMORY_LIMIT:-256m}

  # ── One-off: database migrations and seeding (profile "ops") ─────────────
  #   docker compose ... run --rm migrate                                   # prisma migrate deploy
  #   docker compose ... run --rm migrate ts-node --project tsconfig.json prisma/seed.ts
  migrate:
    image: ${MIGRATOR_IMAGE:-shopino/migrator:latest}
    build:
      context: .
      dockerfile: apps/backend/Dockerfile
      target: migrator
    profiles: [ops]
    env_file:
      - ${SHOPINO_ENV_FILE:-.env.production}
    environment:
      <<: *backend-env
    security_opt:
      - no-new-privileges:true
    cap_drop: [ALL]
    logging: *logging
    depends_on:
      postgres:
        condition: service_healthy
    networks: [data]

  # ── One-off: Let's Encrypt (profile "ops") ───────────────────────────────
  #   docker compose ... run --rm certbot certonly --webroot -w /var/www/certbot -d example.ir ...
  #   docker compose ... run --rm certbot renew --webroot -w /var/www/certbot
  certbot:
    image: certbot/certbot:v3.1.0
    profiles: [ops]
    volumes:
      - letsencrypt:/etc/letsencrypt
      - certbot_webroot:/var/www/certbot
    logging: *logging
    networks: [edge]

volumes:
  postgres_data:
  redis_data:
  uploads:
  letsencrypt:
  certbot_webroot:

networks:
  edge:
    driver: bridge
  app:
    driver: bridge
  data:
    driver: bridge
    internal: true
```

### nginx

#### `deploy/nginx/Dockerfile`

```dockerfile
# =============================================================================
# Shopino edge proxy — nginx (Alpine package) with the Brotli module
# -----------------------------------------------------------------------------
#   docker build -t shopino/nginx deploy/nginx
#
# Alpine's nginx ships `nginx-mod-http-brotli` built for the same nginx version,
# so Brotli works without compiling third-party code. The entrypoint renders the
# site config from environment variables, picks the Let's Encrypt certificate
# (or a short-lived self-signed one until it exists), validates the config and
# reloads every 6 h so renewed certificates are picked up.
# =============================================================================
FROM alpine:3.20

RUN apk add --no-cache nginx nginx-mod-http-brotli openssl gettext tini \
 && rm -f /etc/nginx/http.d/default.conf \
 && mkdir -p /etc/nginx/certs /var/www/certbot /etc/nginx/templates \
 # Access/error logs to the container's stdout/stderr (collected by Docker).
 && ln -sf /dev/stdout /var/log/nginx/access.log \
 && ln -sf /dev/stderr /var/log/nginx/error.log

COPY nginx.conf /etc/nginx/nginx.conf
COPY snippets/ /etc/nginx/snippets/
COPY templates/ /etc/nginx/templates/
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 0755 /usr/local/bin/docker-entrypoint.sh

EXPOSE 80 443
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/nginx-health || exit 1
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
```

#### `deploy/nginx/nginx.conf`

```nginx
# =============================================================================
# Shopino — nginx main configuration (edge reverse proxy)
# Site-specific server blocks are rendered at start from
# templates/shopino.conf.template into /etc/nginx/http.d/shopino.conf.
# =============================================================================

# Dynamic modules installed by the Alpine packages (Brotli filter + static).
include /etc/nginx/modules/*.conf;

user nginx;
worker_processes auto;
worker_rlimit_nofile 65535;
pid /run/nginx/nginx.pid;
error_log /var/log/nginx/error.log warn;

events {
    worker_connections 8192;
    multi_accept on;
}

http {
    include /etc/nginx/mime.types;
    default_type application/octet-stream;

    # ── Basics & information hiding ─────────────────────────────────────────
    server_tokens off;
    sendfile on;
    tcp_nopush on;
    tcp_nodelay on;
    types_hash_max_size 4096;
    charset utf-8;

    # ── Slow-client / slowloris protection ──────────────────────────────────
    client_header_timeout 15s;
    client_body_timeout 30s;
    send_timeout 30s;
    keepalive_timeout 30s;
    keepalive_requests 1000;
    reset_timedout_connection on;
    client_header_buffer_size 4k;
    # JWT cookies make headers larger than the 8k default can hold on some paths.
    large_client_header_buffers 4 16k;
    # Default request body cap; raised to 15 MB on the upload routes only.
    client_max_body_size 1m;

    # ── Structured access log (JSON, no query strings: they may carry tokens) ─
    log_format shopino_json escape=json
        '{"time":"$time_iso8601","remote_addr":"$remote_addr","method":"$request_method",'
        '"uri":"$uri","status":$status,"bytes":$body_bytes_sent,"request_time":$request_time,'
        '"upstream_time":"$upstream_response_time","host":"$host","referer":"$http_referer",'
        '"user_agent":"$http_user_agent","request_id":"$request_id"}';
    access_log /var/log/nginx/access.log shopino_json;

    # ── Rate limiting (per client IP) ───────────────────────────────────────
    # Tune for your audience: Iranian mobile carriers put many users behind one
    # CGNAT address, so the web/API limits are deliberately generous. The
    # backend enforces its own per-mobile and per-IP OTP limits on top.
    limit_req_zone $binary_remote_addr zone=shopino_web:20m    rate=20r/s;
    limit_req_zone $binary_remote_addr zone=shopino_api:20m    rate=15r/s;
    limit_req_zone $binary_remote_addr zone=shopino_auth:10m   rate=10r/m;
    limit_req_zone $binary_remote_addr zone=shopino_upload:10m rate=2r/s;
    limit_conn_zone $binary_remote_addr zone=shopino_conn:20m;
    limit_req_status 429;
    limit_conn_status 429;
    limit_req_log_level warn;

    # ── Compression (text only; images/fonts are already compressed) ────────
    gzip on;
    gzip_vary on;
    gzip_proxied any;
    gzip_comp_level 5;
    gzip_min_length 1024;
    gzip_types text/plain text/css text/xml text/javascript application/javascript
               application/json application/xml application/rss+xml application/manifest+json
               image/svg+xml font/ttf font/otf;

    brotli on;
    brotli_comp_level 5;
    brotli_min_length 1024;
    brotli_types text/plain text/css text/xml text/javascript application/javascript
                 application/json application/xml application/rss+xml application/manifest+json
                 image/svg+xml font/ttf font/otf;

    # ── Proxy defaults ──────────────────────────────────────────────────────
    proxy_http_version 1.1;
    proxy_buffering on;
    proxy_buffers 16 16k;
    proxy_buffer_size 16k;
    proxy_connect_timeout 5s;
    proxy_send_timeout 60s;
    proxy_read_timeout 60s;

    # WebSocket/upgrade support (Next.js does not need it in production, kept
    # correct for future use without enabling it anywhere by default).
    map $http_upgrade $connection_upgrade {
        default upgrade;
        ''      '';
    }

    include /etc/nginx/http.d/*.conf;
}
```

#### `deploy/nginx/templates/shopino.conf.template`

```nginx
# =============================================================================
# Shopino site — rendered by docker-entrypoint.sh (envsubst) at container start.
# Variables: ${SHOPINO_DOMAIN} ${SHOPINO_SERVER_NAMES} ${SHOPINO_CSP}
#            ${FRONTEND_UPSTREAM}
#
# Routing (matches the Phase-10 architecture):
#   every public request → Next.js (storefront, panels, BFF /api/v1 + /api/session)
#   The NestJS API is NOT published: it listens on the private compose network
#   and is reached only by the BFF (server-to-server, Bearer tokens from the
#   httpOnly session cookies). Swagger (/api/docs) is therefore not public.
# =============================================================================

upstream shopino_frontend {
    server ${FRONTEND_UPSTREAM} max_fails=3 fail_timeout=10s;
    keepalive 32;
}

map $host $shopino_csp {
    default "${SHOPINO_CSP}";
}

# ── Port 80: ACME challenges, health probe, redirect everything else ────────
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;

    # Let's Encrypt HTTP-01 (certbot --webroot writes here).
    location ^~ /.well-known/acme-challenge/ {
        root /var/www/certbot;
        default_type text/plain;
        try_files $uri =404;
    }

    # Container health check (local only).
    location = /nginx-health {
        access_log off;
        allow 127.0.0.1;
        allow ::1;
        deny all;
        default_type text/plain;
        return 200 "ok\n";
    }

    location / {
        return 301 https://${SHOPINO_DOMAIN}$request_uri;
    }
}

# ── Port 443, unknown Host / SNI: refuse the TLS handshake ─────────────────
server {
    listen 443 ssl default_server;
    listen [::]:443 ssl default_server;
    server_name _;
    ssl_reject_handshake on;
}

# ── Port 443, the shop ──────────────────────────────────────────────────────
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name ${SHOPINO_SERVER_NAMES};

    # Certificate: Let's Encrypt when issued, otherwise a 7-day self-signed
    # placeholder (the entrypoint switches automatically on the next reload).
    ssl_certificate     /etc/nginx/certs/active/fullchain.pem;
    ssl_certificate_key /etc/nginx/certs/active/privkey.pem;

    # Mozilla "intermediate" profile (TLS 1.2 + 1.3).
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:DHE-RSA-AES128-GCM-SHA256:DHE-RSA-AES256-GCM-SHA384;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:shopino_tls:10m;
    ssl_session_timeout 1d;
    ssl_session_tickets off;

    # Connection cap per client address (DDoS / scraping guard).
    limit_conn shopino_conn 60;

    # Non-www canonical host.
    if ($host != "${SHOPINO_DOMAIN}") {
        return 301 https://${SHOPINO_DOMAIN}$request_uri;
    }

    include /etc/nginx/snippets/security-headers.conf;

    # JSON body for rate-limited API calls (the web UI localises status 429).
    error_page 429 = @rate_limited;
    location @rate_limited {
        include /etc/nginx/snippets/security-headers.conf;
        default_type application/json;
        return 429 '{"statusCode":429,"error":"Too Many Requests","message":"تعداد درخواست‌ها بیش از حد مجاز است؛ لطفاً کمی بعد دوباره تلاش کنید."}';
    }

    # Hidden files (except ACME, served on :80) are never proxied.
    location ~ /\.(?!well-known/) {
        deny all;
    }

    # Sign-in endpoints: strict per-IP budget on top of the API's own OTP
    # limits. Exact/prefix matches (not regex): the `^~ /api/` prefix below
    # would otherwise stop nginx from evaluating a regex location.
    #   /api/session/{otp,verify,password}  — BFF sign-in routes
    #   /api/v1/auth/                       — the generic BFF also forwards
    #                                         auth/otp/request; the browser never
    #                                         calls /api/v1/auth/* directly.
    location = /api/session/otp {
        limit_req zone=shopino_auth burst=10 nodelay;
        include /etc/nginx/snippets/security-headers.conf;
        include /etc/nginx/snippets/proxy-frontend.conf;
    }
    location = /api/session/verify {
        limit_req zone=shopino_auth burst=10 nodelay;
        include /etc/nginx/snippets/security-headers.conf;
        include /etc/nginx/snippets/proxy-frontend.conf;
    }
    location = /api/session/password {
        limit_req zone=shopino_auth burst=10 nodelay;
        include /etc/nginx/snippets/security-headers.conf;
        include /etc/nginx/snippets/proxy-frontend.conf;
    }
    location ^~ /api/v1/auth/ {
        limit_req zone=shopino_auth burst=10 nodelay;
        include /etc/nginx/snippets/security-headers.conf;
        include /etc/nginx/snippets/proxy-frontend.conf;
    }

    # Uploads (product images, KYC and dispute evidence): 15 MB cap here only.
    # The API still enforces MEDIA_MAX_IMAGE_BYTES / MEDIA_MAX_DOCUMENT_BYTES and
    # checks file signatures.
    location ^~ /api/v1/media/upload/ {
        client_max_body_size 15m;
        client_body_timeout 60s;
        proxy_read_timeout 120s;
        proxy_send_timeout 120s;
        limit_req zone=shopino_upload burst=10 nodelay;
        include /etc/nginx/snippets/security-headers.conf;
        include /etc/nginx/snippets/proxy-frontend.conf;
    }

    # Same-origin BFF (JSON API for the browser).
    location ^~ /api/ {
        limit_req zone=shopino_api burst=60 nodelay;
        include /etc/nginx/snippets/security-headers.conf;
        include /etc/nginx/snippets/proxy-frontend.conf;
    }

    # Content-hashed build assets: immutable, no rate limit, no access log.
    location ^~ /_next/static/ {
        access_log off;
        include /etc/nginx/snippets/security-headers.conf;
        include /etc/nginx/snippets/proxy-frontend.conf;
        proxy_hide_header Cache-Control;
        add_header Cache-Control "public, max-age=31536000, immutable" always;
    }

    # Pages (SSR/streaming).
    location / {
        limit_req zone=shopino_web burst=80 nodelay;
        include /etc/nginx/snippets/security-headers.conf;
        include /etc/nginx/snippets/proxy-frontend.conf;
    }
}
```

#### `deploy/nginx/snippets/security-headers.conf`

```nginx
# Security headers for every HTTPS response (`always` = also on 4xx/5xx).
# nginx drops inherited add_header directives in a location that declares its
# own, so locations include this file instead of adding headers inline.

# Two years, all subdomains. `preload` is intentionally NOT set: submitting a
# domain to the browser preload list is hard to undo — decide it separately.
add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;
add_header X-Content-Type-Options "nosniff" always;
add_header X-Frame-Options "DENY" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header Permissions-Policy "camera=(), microphone=(), geolocation=(), usb=(), interest-cohort=()" always;
add_header Cross-Origin-Opener-Policy "same-origin" always;
add_header X-Request-ID $request_id always;

# Content-Security-Policy (the value is rendered by the entrypoint):
#  - script-src 'unsafe-inline' is required by the Next.js App Router, which
#    streams inline bootstrap scripts; no third-party script origin is allowed.
#  - img-src adds the object-storage/CDN origin (CSP_EXTRA_IMG_SRC) where
#    product images are published when STORAGE_PROVIDER=s3.
#  - form-action allows the payment gateway origin (CSP_FORM_ACTION_EXTRA),
#    because the bank round-trip is a top-level navigation/redirect.
add_header Content-Security-Policy $shopino_csp always;
```

#### `deploy/nginx/snippets/proxy-frontend.conf`

```nginx
# Proxy to the Next.js server (storefront, panels and the same-origin BFF).
proxy_pass http://shopino_frontend;

# Host with port: the BFF's same-origin check compares Origin with this value.
proxy_set_header Host $http_host;
proxy_set_header X-Forwarded-Host $http_host;
proxy_set_header X-Forwarded-Proto $scheme;
# OVERWRITE (never append) the client address. The BFF forwards it and the API
# uses the first X-Forwarded-For entry for per-IP rate limits and audit logs, so
# a client-supplied value must never survive this hop. $remote_addr is the real
# client (or the CDN-supplied address when TRUSTED_PROXY_CIDRS is configured).
proxy_set_header X-Forwarded-For $remote_addr;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Request-ID $request_id;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection $connection_upgrade;
# Let nginx negotiate gzip/Brotli with the browser instead of Next.js gzip.
proxy_set_header Accept-Encoding "";

proxy_hide_header X-Powered-By;
# The edge owns these headers; drop any upstream copy to avoid duplicates.
proxy_hide_header Strict-Transport-Security;
proxy_hide_header X-Frame-Options;
proxy_hide_header X-Content-Type-Options;
proxy_hide_header Content-Security-Policy;
proxy_hide_header Referrer-Policy;

proxy_intercept_errors off;
```

#### `deploy/nginx/docker-entrypoint.sh`

```bash
#!/bin/sh
# =============================================================================
# Shopino edge proxy entrypoint
#   1. validates the required environment,
#   2. renders /etc/nginx/http.d/shopino.conf from the template,
#   3. optionally trusts a CDN/load balancer for the client address,
#   4. activates the Let's Encrypt certificate, or a 7-day self-signed
#      placeholder until certbot has issued one,
#   5. checks the configuration, starts nginx and reloads it every 6 hours so
#      renewed certificates are served without a restart.
#
# Environment
#   SHOPINO_DOMAIN          (required) canonical host, e.g. shopino.ir
#   SHOPINO_EXTRA_DOMAINS   space-separated aliases redirected to the canonical
#                           host, e.g. "www.shopino.ir"
#   FRONTEND_UPSTREAM       Next.js address (default frontend:3000)
#   CSP_EXTRA_IMG_SRC       extra image origins, e.g. https://cdn.shopino.ir
#   CSP_FORM_ACTION_EXTRA   extra form targets (default https://payment.zarinpal.com)
#   TRUSTED_PROXY_CIDRS     comma-separated CIDRs of a CDN in front of nginx
#                           (empty = nginx faces clients directly)
#   CERT_RELOAD_INTERVAL    seconds between certificate reloads (default 21600)
# =============================================================================
set -eu

: "${SHOPINO_DOMAIN:?SHOPINO_DOMAIN is required (e.g. shopino.ir)}"
case "$SHOPINO_DOMAIN" in
  *[!A-Za-z0-9.-]*) echo "[nginx] SHOPINO_DOMAIN contains invalid characters" >&2; exit 1 ;;
esac

# ── Certificates ────────────────────────────────────────────────────────────
LE_DIR="/etc/letsencrypt/live/$SHOPINO_DOMAIN"
SELF_DIR=/etc/nginx/certs/selfsigned
ACTIVE=/etc/nginx/certs/active

activate_certificate() {
  if [ -s "$LE_DIR/fullchain.pem" ] && [ -s "$LE_DIR/privkey.pem" ]; then
    target="$LE_DIR"
  else
    if [ ! -s "$SELF_DIR/fullchain.pem" ]; then
      mkdir -p "$SELF_DIR"
      openssl req -x509 -nodes -newkey rsa:2048 -days 7 \
        -subj "/CN=$SHOPINO_DOMAIN" -addext "subjectAltName=DNS:$SHOPINO_DOMAIN" \
        -keyout "$SELF_DIR/privkey.pem" -out "$SELF_DIR/fullchain.pem" >/dev/null 2>&1
      chmod 600 "$SELF_DIR/privkey.pem"
    fi
    target="$SELF_DIR"
  fi
  if [ "$(readlink "$ACTIVE" 2>/dev/null || true)" != "$target" ]; then
    ln -sfn "$target" "$ACTIVE"
    echo "[nginx] certificate: $target"
  fi
}

# ── Subcommand: `docker-entrypoint.sh reload` ───────────────────────────────
# Re-selects the certificate (switches from the self-signed placeholder to the
# Let's Encrypt certificate once it exists), validates and reloads nginx:
#   docker compose ... exec nginx docker-entrypoint.sh reload
if [ "${1:-}" = "reload" ]; then
  activate_certificate
  nginx -t
  nginx -s reload
  echo "[nginx] reloaded"
  exit 0
fi

SHOPINO_EXTRA_DOMAINS="${SHOPINO_EXTRA_DOMAINS:-}"
FRONTEND_UPSTREAM="${FRONTEND_UPSTREAM:-frontend:3000}"
CSP_EXTRA_IMG_SRC="${CSP_EXTRA_IMG_SRC:-}"
CSP_FORM_ACTION_EXTRA="${CSP_FORM_ACTION_EXTRA:-https://payment.zarinpal.com}"
TRUSTED_PROXY_CIDRS="${TRUSTED_PROXY_CIDRS:-}"
CERT_RELOAD_INTERVAL="${CERT_RELOAD_INTERVAL:-21600}"

for value in "$SHOPINO_EXTRA_DOMAINS" "$CSP_EXTRA_IMG_SRC" "$CSP_FORM_ACTION_EXTRA"; do
  case "$value" in
    *[\"\;\'\$\\]*) echo "[nginx] quotes, semicolons, \$ and backslashes are not allowed in domain/CSP variables" >&2; exit 1 ;;
  esac
done

SHOPINO_SERVER_NAMES="$SHOPINO_DOMAIN $SHOPINO_EXTRA_DOMAINS"
# The single quotes are literal CSP syntax ('self', 'none'), not shell quoting.
# shellcheck disable=SC2089,SC2090
SHOPINO_CSP="default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: ${CSP_EXTRA_IMG_SRC}; font-src 'self' data:; connect-src 'self'; media-src 'self'; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self' ${CSP_FORM_ACTION_EXTRA}; upgrade-insecure-requests"
# shellcheck disable=SC2090
export SHOPINO_DOMAIN SHOPINO_SERVER_NAMES SHOPINO_CSP FRONTEND_UPSTREAM

# shellcheck disable=SC2016 # the variable list is passed literally to envsubst
envsubst '${SHOPINO_DOMAIN} ${SHOPINO_SERVER_NAMES} ${SHOPINO_CSP} ${FRONTEND_UPSTREAM}' \
  < /etc/nginx/templates/shopino.conf.template > /etc/nginx/http.d/shopino.conf

# ── Client address behind a CDN ─────────────────────────────────────────────
REAL_IP_CONF=/etc/nginx/http.d/00-real-ip.conf
if [ -n "$TRUSTED_PROXY_CIDRS" ]; then
  real_ip_lines=""
  old_ifs=$IFS; IFS=','
  for cidr in $TRUSTED_PROXY_CIDRS; do
    cidr=$(echo "$cidr" | tr -d ' ')
    [ -z "$cidr" ] && continue
    case "$cidr" in
      *[!0-9a-fA-F:./]*) echo "[nginx] invalid CIDR in TRUSTED_PROXY_CIDRS: $cidr" >&2; exit 1 ;;
    esac
    real_ip_lines="${real_ip_lines}set_real_ip_from ${cidr};
"
  done
  IFS=$old_ifs
  printf '# Generated from TRUSTED_PROXY_CIDRS: only these peers may set the client address.\n%sreal_ip_header X-Forwarded-For;\nreal_ip_recursive on;\n' "$real_ip_lines" > "$REAL_IP_CONF"
else
  rm -f "$REAL_IP_CONF"
fi

activate_certificate
if [ "$(readlink "$ACTIVE")" = "$SELF_DIR" ]; then
  echo "[nginx] WARNING: no Let's Encrypt certificate for $SHOPINO_DOMAIN yet — serving a temporary self-signed one. Run the certbot step of docs/production-deployment-guide.md." >&2
fi

mkdir -p /run/nginx
nginx -t

(
  while sleep "$CERT_RELOAD_INTERVAL"; do
    activate_certificate
    nginx -t >/dev/null 2>&1 && nginx -s reload
  done
) &

exec nginx -g 'daemon off;'
```

### Environment and deploy

#### `deploy/env/production.env.example`

```dotenv
# =============================================================================
# Shopino — PRODUCTION environment template
# -----------------------------------------------------------------------------
# Copy to the server, outside the repository, and fill in every empty value:
#
#   install -m 600 -o root -g root deploy/env/production.env.example /opt/shopino/.env.production
#
# Read by docker-compose.prod.yml (interpolation + the backend/migrator
# env_file). The frontend container never receives this file.
# deploy/scripts/deploy.sh refuses to run while a REQUIRED key is empty.
#
# Secret generation:  openssl rand -base64 48 | tr -d '\n/+=' | cut -c1-48
# Quote values that contain spaces or non-ASCII text ("...").
# =============================================================================

# ─── Site & edge (nginx) ────────────────────────────────────────────────────
# REQUIRED. Canonical host name; DNS A/AAAA records must point at this server.
SHOPINO_DOMAIN=
# Aliases redirected to the canonical host (space-separated), e.g. "www.example.ir".
SHOPINO_EXTRA_DOMAINS=
# Extra CSP img-src origins: the S3/CDN origin that serves product images,
# e.g. https://cdn.example.ir  (empty when STORAGE_PROVIDER=local).
CSP_EXTRA_IMG_SRC=
# Payment gateway origin allowed as a form target.
CSP_FORM_ACTION_EXTRA=https://payment.zarinpal.com
# CIDRs of a CDN/load balancer in front of nginx (comma-separated). Leave EMPTY
# when clients connect to this server directly — a wrong value lets clients
# spoof their IP address and bypass rate limits.
TRUSTED_PROXY_CIDRS=
# Contact address for Let's Encrypt expiry notices (used by the certbot step).
LETSENCRYPT_EMAIL=

# ─── Images (deploy.sh / CI) ────────────────────────────────────────────────
# Registry images deployed by .github/workflows/deploy.yml (the tag is set per
# deploy). Leave the defaults to build on the server instead.
BACKEND_IMAGE=shopino/backend:latest
FRONTEND_IMAGE=shopino/frontend:latest
NGINX_IMAGE=shopino/nginx:latest
MIGRATOR_IMAGE=shopino/migrator:latest

# ─── Runtime ────────────────────────────────────────────────────────────────
# NODE_ENV/HOST/PORT/REDIS_HOST are forced by docker-compose.prod.yml.
LOG_LEVEL=log
# Browser origins allowed by the API's CORS policy: the public site origin.
CORS_ORIGINS=

# ─── PostgreSQL ─────────────────────────────────────────────────────────────
POSTGRES_USER=shopino
# REQUIRED. Letters and digits only keeps the URLs below valid without escaping.
POSTGRES_PASSWORD=
POSTGRES_DB=shopino
# REQUIRED. Host `postgres` is the compose service; repeat the password above.
#   postgresql://shopino:<password>@postgres:5432/shopino?schema=public&connection_limit=10&pool_timeout=20
DATABASE_URL=
#   postgresql://shopino:<password>@postgres:5432/shopino?schema=public
DIRECT_URL=
POSTGRES_MAX_CONNECTIONS=100
POSTGRES_SHARED_BUFFERS=256MB

# ─── Redis ──────────────────────────────────────────────────────────────────
# REQUIRED.
REDIS_PASSWORD=
REDIS_DB=0
REDIS_MAXMEMORY=256mb

# ─── Authentication ─────────────────────────────────────────────────────────
# REQUIRED. Two DIFFERENT random values of at least 32 characters.
JWT_ACCESS_SECRET=
JWT_REFRESH_SECRET=
JWT_ACCESS_TTL=15m
JWT_REFRESH_TTL=7d
OTP_TTL_SECONDS=120
OTP_LENGTH=5
OTP_REQUEST_COOLDOWN_SECONDS=120
OTP_MAX_VERIFY_ATTEMPTS=5
OTP_LOCK_SECONDS=900
OTP_MAX_REQUESTS_PER_HOUR=5
OTP_MAX_REQUESTS_PER_IP_PER_HOUR=20
AUTH_MAX_LOGIN_ATTEMPTS=5
AUTH_LOCK_SECONDS=900

# ─── SMS: Kavenegar (the sandbox provider is refused in production) ─────────
SMS_PROVIDER=kavenegar
SMS_SANDBOX_LOG_CODES=false
# REQUIRED. From the Kavenegar panel: API key, sender line, approved
# verify/lookup template name for login codes (one %token parameter).
SMS_KAVENEGAR_API_KEY=
SMS_KAVENEGAR_SENDER=
SMS_KAVENEGAR_OTP_TEMPLATE=

# ─── Storage: S3-compatible object storage (ArvanCloud / Liara) ─────────────
# `local` is accepted only for a single node (uploads volume) and logs a warning.
STORAGE_PROVIDER=s3
# ArvanCloud: https://s3.ir-thr-at1.arvanstorage.ir   Liara: https://storage.iran.liara.space
S3_ENDPOINT=
S3_REGION=ir-thr-at1
# REQUIRED when STORAGE_PROVIDER=s3.
S3_BUCKET=
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=
S3_FORCE_PATH_STYLE=true
# Public base URL of stored objects (CDN or bucket URL); also add its origin to
# CSP_EXTRA_IMG_SRC above.
S3_PUBLIC_BASE_URL=
MEDIA_MAX_IMAGE_BYTES=5242880
MEDIA_MAX_DOCUMENT_BYTES=10485760

# ─── Payments: Zarinpal IPG v4 (the sandbox gateway is refused in production) ─
PAYMENT_GATEWAY_PROVIDER=zarinpal
# REQUIRED. 36-character merchant id issued by Zarinpal.
ZARINPAL_MERCHANT_ID=
ZARINPAL_API_BASE_URL=https://payment.zarinpal.com
PAYMENT_GATEWAY_TIMEOUT_MS=15000
# REQUIRED. The public site origin (https://<SHOPINO_DOMAIN>, no path). The bank
# redirects to <origin>/api/v1/payments/callback, served through the BFF.
PUBLIC_API_ORIGIN=
PAYMENT_RESULT_REDIRECT_URL=/payment/result
PAYMENT_CALLBACK_GRACE_MINUTES=20

# ─── Commerce ───────────────────────────────────────────────────────────────
SHIPPING_DEFAULT_FEE_PER_VENDOR=500000
SHIPPING_FREE_THRESHOLD_PER_VENDOR=10000000
ORDER_PAYMENT_TIMEOUT_MINUTES=30
ORDER_EXPIRY_SWEEP_INTERVAL_SECONDS=60
INSTALLMENT_OVERDUE_SWEEP_INTERVAL_SECONDS=3600

# ─── First-time seed (production profile) ───────────────────────────────────
SEED_PROFILE=production
# REQUIRED. The platform owner's account.
SUPER_ADMIN_MOBILE=
SUPER_ADMIN_EMAIL=
SUPER_ADMIN_FULL_NAME=
# REQUIRED. At least 12 characters; change it after the first sign-in.
SUPER_ADMIN_PASSWORD=
SEED_RESET_ADMIN_PASSWORD=false
# Optional staff accounts (each triple all-or-nothing; password below).
SEED_SUPPORT_MOBILE=
SEED_SUPPORT_EMAIL=
SEED_SUPPORT_FULL_NAME=
SEED_FINANCE_MOBILE=
SEED_FINANCE_EMAIL=
SEED_FINANCE_FULL_NAME=
SEED_STAFF_PASSWORD=

# ─── Backups (scripts/backup) ───────────────────────────────────────────────
BACKUP_DIR=/var/backups/shopino
BACKUP_RETENTION_DAYS=30
# Optional: encrypt dumps with a passphrase file (AES-256, openssl). Keep a copy
# of this file OFF the server — without it the backups cannot be restored.
BACKUP_PASSPHRASE_FILE=
```

#### `deploy/scripts/deploy.sh`

```bash
#!/usr/bin/env bash
# =============================================================================
# Shopino — production deploy (runs ON the server; used by deploy.yml and by hand)
# -----------------------------------------------------------------------------
#   deploy/scripts/deploy.sh [--tag TAG --registry REGISTRY] [--build] [--seed]
#                            [--skip-backup] [--env-file FILE]
#
#   --tag/--registry  deploy prebuilt images REGISTRY/{backend,frontend,nginx,migrator}:TAG
#                     (CI path). Rollback = run again with the previous tag.
#   --build           build the images on this server from the checked-out source
#   --seed            run the idempotent seed after migrating (first install, or
#                     to add missing master data; it never overwrites admin edits)
#   --skip-backup     skip the pre-deploy database backup (not recommended)
#
# Steps: validate env → images → pre-deploy backup → postgres/redis →
#        prisma migrate deploy → [seed] → backend/frontend/nginx → smoke test.
# Any failure stops the deploy; the running version keeps serving until the new
# containers are started, and the pre-deploy backup allows a data rollback.
# =============================================================================
set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
ROOT="$(pwd)"
LOG_TAG=deploy
# shellcheck source=scripts/backup/lib.sh
. "$ROOT/scripts/backup/lib.sh"
trap 'die "deploy failed at line $LINENO"' ERR

TAG=""; REGISTRY=""; BUILD=0; SEED=0; SKIP_BACKUP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --tag) TAG="$2"; shift 2 ;;
    --registry) REGISTRY="$2"; shift 2 ;;
    --build) BUILD=1; shift ;;
    --seed) SEED=1; shift ;;
    --skip-backup) SKIP_BACKUP=1; shift ;;
    --env-file) SHOPINO_ENV_FILE="$2"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done
SHOPINO_ENV_FILE="${SHOPINO_ENV_FILE:-/opt/shopino/.env.production}"
ENV_FILE="$SHOPINO_ENV_FILE"
[ -r "$ENV_FILE" ] || die "env file not found: $ENV_FILE (template: deploy/env/production.env.example)"

# ── 1. Validate the production environment ──────────────────────────────────
perm=$(stat -c %a "$ENV_FILE")
case "$perm" in
  600|400) ;;
  *) die "$ENV_FILE has mode $perm; it holds secrets — chmod 600 it" ;;
esac

REQUIRED=(SHOPINO_DOMAIN CORS_ORIGINS POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB DATABASE_URL DIRECT_URL
          REDIS_PASSWORD JWT_ACCESS_SECRET JWT_REFRESH_SECRET PUBLIC_API_ORIGIN
          SMS_PROVIDER SMS_KAVENEGAR_API_KEY SMS_KAVENEGAR_SENDER SMS_KAVENEGAR_OTP_TEMPLATE
          PAYMENT_GATEWAY_PROVIDER ZARINPAL_MERCHANT_ID STORAGE_PROVIDER
          SHIPPING_DEFAULT_FEE_PER_VENDOR SHIPPING_FREE_THRESHOLD_PER_VENDOR)
[ "$SEED" -eq 1 ] && REQUIRED+=(SUPER_ADMIN_MOBILE SUPER_ADMIN_EMAIL SUPER_ADMIN_FULL_NAME SUPER_ADMIN_PASSWORD)
missing=()
for key in "${REQUIRED[@]}"; do
  [ -n "$(env_get "$ENV_FILE" "$key")" ] || missing+=("$key")
done
[ "${#missing[@]}" -eq 0 ] || die "required keys are empty in $ENV_FILE: ${missing[*]}"

v() { env_get "$ENV_FILE" "$1"; }
[ "$(v SMS_PROVIDER)" = "kavenegar" ] || die "SMS_PROVIDER must be kavenegar in production"
[ "$(v PAYMENT_GATEWAY_PROVIDER)" = "zarinpal" ] || die "PAYMENT_GATEWAY_PROVIDER must be zarinpal in production"
[ "$(v SMS_SANDBOX_LOG_CODES)" != "true" ] || die "SMS_SANDBOX_LOG_CODES must be false in production"
[ "$(v PUBLIC_API_ORIGIN)" = "https://$(v SHOPINO_DOMAIN)" ] \
  || die "PUBLIC_API_ORIGIN must be https://$(v SHOPINO_DOMAIN) (the bank callback goes through the public site)"
[ "$(v JWT_ACCESS_SECRET)" != "$(v JWT_REFRESH_SECRET)" ] || die "JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must differ"
for key in JWT_ACCESS_SECRET JWT_REFRESH_SECRET; do
  [ "$(v "$key" | wc -c)" -gt 32 ] || die "$key must be at least 32 characters"
done
case "$(v DATABASE_URL)" in *@postgres:5432/*) ;; *) die "DATABASE_URL must point at the compose service (…@postgres:5432/…)" ;; esac
if [ "$(v STORAGE_PROVIDER)" = "s3" ]; then
  for key in S3_BUCKET S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY; do
    [ -n "$(v "$key")" ] || die "STORAGE_PROVIDER=s3 requires $key"
  done
else
  warn "STORAGE_PROVIDER=$(v STORAGE_PROVIDER): uploads stay on this host (uploads volume) — single-node only"
fi
log "environment OK ($ENV_FILE)"

# ── 2. Images ───────────────────────────────────────────────────────────────
if [ -n "$TAG" ]; then
  [ -n "$REGISTRY" ] || die "--tag requires --registry"
  export BACKEND_IMAGE="$REGISTRY/backend:$TAG" FRONTEND_IMAGE="$REGISTRY/frontend:$TAG" \
         NGINX_IMAGE="$REGISTRY/nginx:$TAG" MIGRATOR_IMAGE="$REGISTRY/migrator:$TAG"
fi
export SHOPINO_ENV_FILE
COMPOSE_FILE="$ROOT/docker-compose.prod.yml"
load_config

if [ "$BUILD" -eq 1 ]; then
  log "building images on this host"
  "${COMPOSE[@]}" --profile ops build backend frontend nginx migrate
elif [ -n "$TAG" ]; then
  log "pulling $REGISTRY/*:$TAG"
  "${COMPOSE[@]}" --profile ops pull backend frontend nginx migrate
else
  die "choose --tag/--registry (prebuilt images) or --build"
fi

# ── 3. Pre-deploy backup ────────────────────────────────────────────────────
if [ "$SKIP_BACKUP" -eq 0 ] && "${COMPOSE[@]}" ps --status running --services 2>/dev/null | grep -qx postgres; then
  log "pre-deploy backup"
  "$ROOT/scripts/backup/backup-postgres.sh" --env-file "$ENV_FILE"
fi

# ── 4. Data services, migrations, seed ──────────────────────────────────────
"${COMPOSE[@]}" up -d --wait postgres redis
log "applying database migrations"
"${COMPOSE[@]}" run --rm migrate
if [ "$SEED" -eq 1 ]; then
  log "seeding (production profile, idempotent)"
  "${COMPOSE[@]}" run --rm migrate ts-node --project tsconfig.json prisma/seed.ts
fi

# ── 5. Application ──────────────────────────────────────────────────────────
log "starting backend, frontend and nginx"
"${COMPOSE[@]}" up -d --wait --remove-orphans backend frontend nginx

# ── 6. Smoke test through nginx ─────────────────────────────────────────────
DOMAIN="$(v SHOPINO_DOMAIN)"
probe() { curl -fsS -o /dev/null -w '%{http_code}' --max-time 15 -k --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN$1"; }
for path in / /api/session "/api/v1/products?pageSize=1"; do
  code=$(probe "$path") || die "smoke test failed: https://$DOMAIN$path"
  log "smoke $path → $code"
done

mkdir -p /opt/shopino 2>/dev/null || true
if [ -w /opt/shopino ]; then
  printf '%s tag=%s registry=%s build=%s commit=%s\n' "$(date -u +%FT%TZ)" "${TAG:-local}" "${REGISTRY:-local}" "$BUILD" \
    "$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)" >> /opt/shopino/deployments.log
fi
docker image prune -f --filter "until=168h" >/dev/null 2>&1 || true
log "deploy complete (${TAG:-local build})"
```

### Backups and systemd

#### `scripts/backup/lib.sh`

```bash
#!/usr/bin/env bash
# =============================================================================
# Shared helpers for backup-postgres.sh / restore-postgres.sh (sourced, not run).
# =============================================================================

# Resolve the repository root (…/scripts/backup/../..).
SHOPINO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

log()  { printf '%s [%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${LOG_TAG:-backup}" "$*"; }
warn() { log "WARNING: $*" >&2; }
die()  { log "ERROR: $*" >&2; exit 1; }

# env_get FILE KEY — value of KEY from a dotenv file, without executing it.
# (The env file holds secrets and non-ASCII values; `source`-ing it would run
# arbitrary shell and break on unquoted spaces.) Surrounding quotes are removed.
env_get() {
  local file="$1" key="$2" line value
  line="$(grep -E "^[[:space:]]*(export[[:space:]]+)?${key}[[:space:]]*=" "$file" | tail -n 1 || true)"
  [ -n "$line" ] || return 0
  value="${line#*=}"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  if [ "${#value}" -ge 2 ]; then
    case "$value" in
      \"*\") value="${value:1:${#value}-2}" ;;
      \'*\') value="${value:1:${#value}-2}" ;;
    esac
  fi
  printf '%s' "$value"
}

# load_config — sets POSTGRES_USER/DB, BACKUP_DIR, retention, passphrase file
# and the compose command from $SHOPINO_ENV_FILE (process env wins).
load_config() {
  SHOPINO_ENV_FILE="${SHOPINO_ENV_FILE:-/opt/shopino/.env.production}"
  [ -r "$SHOPINO_ENV_FILE" ] || die "env file not readable: $SHOPINO_ENV_FILE (set SHOPINO_ENV_FILE or pass --env-file)"

  POSTGRES_USER="${POSTGRES_USER:-$(env_get "$SHOPINO_ENV_FILE" POSTGRES_USER)}"
  POSTGRES_DB="${POSTGRES_DB:-$(env_get "$SHOPINO_ENV_FILE" POSTGRES_DB)}"
  BACKUP_DIR="${BACKUP_DIR:-$(env_get "$SHOPINO_ENV_FILE" BACKUP_DIR)}"
  BACKUP_DIR="${BACKUP_DIR:-/var/backups/shopino}"
  BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-$(env_get "$SHOPINO_ENV_FILE" BACKUP_RETENTION_DAYS)}"
  BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
  BACKUP_PASSPHRASE_FILE="${BACKUP_PASSPHRASE_FILE:-$(env_get "$SHOPINO_ENV_FILE" BACKUP_PASSPHRASE_FILE)}"
  COMPOSE_FILE="${COMPOSE_FILE:-$SHOPINO_ROOT/docker-compose.prod.yml}"

  [ -n "$POSTGRES_USER" ] || die "POSTGRES_USER is not set in $SHOPINO_ENV_FILE"
  [ -n "$POSTGRES_DB" ] || die "POSTGRES_DB is not set in $SHOPINO_ENV_FILE"
  case "$BACKUP_RETENTION_DAYS" in
    ''|*[!0-9]*) die "BACKUP_RETENTION_DAYS must be a whole number of days" ;;
  esac
  [ "$BACKUP_RETENTION_DAYS" -ge 1 ] || die "BACKUP_RETENTION_DAYS must be at least 1"
  if [ -n "$BACKUP_PASSPHRASE_FILE" ]; then
    [ -r "$BACKUP_PASSPHRASE_FILE" ] || die "BACKUP_PASSPHRASE_FILE is not readable: $BACKUP_PASSPHRASE_FILE"
    [ -s "$BACKUP_PASSPHRASE_FILE" ] || die "BACKUP_PASSPHRASE_FILE is empty"
  fi
  # COMPOSE_FILE may list several files separated by ':' (Docker convention).
  COMPOSE=(docker compose)
  local compose_files file
  IFS=':' read -r -a compose_files <<< "$COMPOSE_FILE"
  for file in "${compose_files[@]}"; do
    [ -r "$file" ] || die "compose file not readable: $file"
    COMPOSE+=(-f "$file")
  done
  COMPOSE+=(--env-file "$SHOPINO_ENV_FILE")
  export SHOPINO_ENV_FILE
}

# pg_exec ARGS… — run a command inside the postgres service (stdin forwarded).
pg_exec() {
  "${COMPOSE[@]}" exec -T postgres "$@"
}

# psql_value SQL [DB] — single scalar result.
psql_value() {
  # </dev/null: `docker compose exec` forwards stdin and would otherwise swallow
  # input meant for the caller (e.g. the restore confirmation prompt).
  pg_exec psql -X -q -t -A -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "${2:-$POSTGRES_DB}" -c "$1" < /dev/null
}

require_postgres() {
  command -v docker >/dev/null || die "docker is not installed"
  pg_exec pg_isready -q -U "$POSTGRES_USER" -d "$POSTGRES_DB" < /dev/null \
    || die "the postgres service is not running/ready (compose file: $COMPOSE_FILE)"
}

valid_identifier() {
  case "$1" in
    ''|[0-9]*|*[!a-z0-9_]*) return 1 ;;
  esac
  [ "${#1}" -le 50 ]
}
```

#### `scripts/backup/backup-postgres.sh`

```bash
#!/usr/bin/env bash
# =============================================================================
# Shopino — PostgreSQL backup
# -----------------------------------------------------------------------------
# Creates a consistent, compressed, timestamped dump of the production database
# and prunes dumps older than BACKUP_RETENTION_DAYS.
#
#   scripts/backup/backup-postgres.sh [--env-file FILE] [--output-dir DIR]
#
# Output (BACKUP_DIR, mode 0600, directory 0700):
#   shopino_<db>_<UTC timestamp>.dump[.gpg]         pg_dump custom format (-Fc, zlib -Z6)
#   shopino_<db>_<UTC timestamp>.dump[.gpg].sha256  checksum of the file above
#   shopino_<db>_<UTC timestamp>.dump[.gpg].meta    provenance (server version,
#                                                   migration head, plaintext sha256)
#
# - pg_dump runs INSIDE the postgres container: client and server versions
#   always match, and one MVCC snapshot makes the dump consistent while the
#   shop keeps serving traffic.
# - Every dump is read back with `pg_restore --list` before it is kept.
# - Encryption (optional): BACKUP_PASSPHRASE_FILE → GnuPG symmetric AES-256,
#   which carries its own integrity check (MDC).
# - A dump is written under a temporary name and renamed only when complete;
#   pruning runs only after a successful backup, so a failing job never deletes
#   the last good copies. Concurrent runs are prevented with flock.
#
# Configuration: /opt/shopino/.env.production (or --env-file / SHOPINO_ENV_FILE):
#   POSTGRES_USER, POSTGRES_DB, BACKUP_DIR, BACKUP_RETENTION_DAYS, BACKUP_PASSPHRASE_FILE
# Exit status: 0 on success, non-zero on any failure (systemd marks the unit failed).
# =============================================================================
set -Eeuo pipefail
umask 077
LOG_TAG=backup
# shellcheck source=scripts/backup/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

while [ $# -gt 0 ]; do
  case "$1" in
    --env-file) SHOPINO_ENV_FILE="$2"; shift 2 ;;
    --output-dir) BACKUP_DIR="$2"; shift 2 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done

load_config
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

exec 9>"$BACKUP_DIR/.backup.lock"
flock -n 9 || die "another backup is already running (lock: $BACKUP_DIR/.backup.lock)"

require_postgres

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BASE="shopino_${POSTGRES_DB}_${STAMP}.dump"
TMP="$BACKUP_DIR/.${BASE}.partial"
TMP_ENC="$BACKUP_DIR/.${BASE}.gpg.partial"
cleanup() { rm -f "$TMP" "$TMP_ENC"; }
trap cleanup EXIT
trap 'die "backup failed at line $LINENO"' ERR

log "dumping database '$POSTGRES_DB' → $BACKUP_DIR/$BASE"
started=$(date +%s)
pg_exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  --format=custom --compress=6 --no-owner --no-privileges > "$TMP"
[ -s "$TMP" ] || die "pg_dump produced an empty file"

# Read the archive back: a truncated or corrupt dump fails here, not at restore time.
entries=$(pg_exec pg_restore --list < "$TMP" | grep -cv '^;' || true)
[ "${entries:-0}" -gt 0 ] || die "dump validation failed: pg_restore --list found no entries"

plain_sha=$(sha256sum "$TMP" | awk '{print $1}')
server_version=$(psql_value "SHOW server_version")
migration_head=$(psql_value "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY finished_at DESC, migration_name DESC LIMIT 1" 2>/dev/null || echo unknown)

FINAL="$BACKUP_DIR/$BASE"
if [ -n "$BACKUP_PASSPHRASE_FILE" ]; then
  command -v gpg >/dev/null || die "gpg is required when BACKUP_PASSPHRASE_FILE is set (apt install gnupg)"
  gpg --batch --yes --quiet --pinentry-mode loopback --passphrase-file "$BACKUP_PASSPHRASE_FILE" \
      --symmetric --cipher-algo AES256 --s2k-digest-algo SHA512 --s2k-count 65011712 \
      --compress-algo none --output "$TMP_ENC" "$TMP"
  rm -f "$TMP"
  FINAL="$FINAL.gpg"
  mv "$TMP_ENC" "$FINAL"
  encryption="gpg-aes256"
else
  mv "$TMP" "$FINAL"
  encryption="none"
fi

( cd "$BACKUP_DIR" && sha256sum "$(basename "$FINAL")" > "$(basename "$FINAL").sha256" )
cat > "$FINAL.meta" <<META
file=$(basename "$FINAL")
database=$POSTGRES_DB
created_utc=$STAMP
format=pg_dump-custom
compression=zlib-6
encryption=$encryption
plaintext_sha256=$plain_sha
archive_entries=$entries
server_version=$server_version
prisma_migration_head=$migration_head
size_bytes=$(stat -c %s "$FINAL")
META

log "backup complete: $(basename "$FINAL") ($(du -h "$FINAL" | cut -f1), $entries archive entries, $(( $(date +%s) - started ))s, encryption: $encryption)"

# ── Retention: only after a successful dump ─────────────────────────────────
pruned=0
while IFS= read -r -d '' old; do
  rm -f "$old" "$old.sha256" "$old.meta"
  pruned=$((pruned + 1))
done < <(find "$BACKUP_DIR" -maxdepth 1 -type f \
           \( -name 'shopino_*.dump' -o -name 'shopino_*.dump.gpg' \) \
           -mtime "+$((BACKUP_RETENTION_DAYS - 1))" -print0)
kept=$(find "$BACKUP_DIR" -maxdepth 1 -type f \( -name 'shopino_*.dump' -o -name 'shopino_*.dump.gpg' \) | wc -l)
log "retention ${BACKUP_RETENTION_DAYS}d: pruned $pruned old backup(s), $kept kept"
```

#### `scripts/backup/restore-postgres.sh`

```bash
#!/usr/bin/env bash
# =============================================================================
# Shopino — PostgreSQL restore (one command, safe by default)
# -----------------------------------------------------------------------------
#   scripts/backup/restore-postgres.sh [options] BACKUP_FILE
#
#   --check-only        verify checksum, decrypt and read the archive; change nothing
#   --target-db NAME    restore into a NEW database NAME (restore drills); the
#                       live database and the running services are not touched
#   --yes               do not ask for confirmation (automation)
#   --env-file FILE     default /opt/shopino/.env.production
#
# Without --target-db the live database is REPLACED, safely:
#   1. the .sha256 checksum is verified (a missing or wrong checksum aborts),
#      the file is decrypted (.gpg) and read back with pg_restore --list,
#      and the plaintext checksum in .meta is verified when present;
#   2. the backup is restored into a scratch database `<db>_restore_<ts>` in a
#      single transaction — any error aborts and leaves the live data untouched;
#   3. backend + frontend are stopped (no writes during the switch), open
#      sessions are closed, and the databases are swapped by RENAME:
#         <db>                → <db>_prerestore_<ts>   (kept for rollback)
#         <db>_restore_<ts>   → <db>
#   4. backend + frontend are started again and their health is awaited.
#   Rollback: stop the apps and rename the databases back (printed at the end).
# =============================================================================
set -Eeuo pipefail
umask 077
LOG_TAG=restore
# shellcheck source=scripts/backup/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

CHECK_ONLY=0; ASSUME_YES=0; TARGET_DB=""; FILE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --check-only) CHECK_ONLY=1; shift ;;
    --target-db) TARGET_DB="$2"; shift 2 ;;
    --yes) ASSUME_YES=1; shift ;;
    --env-file) SHOPINO_ENV_FILE="$2"; shift 2 ;;
    -h|--help) sed -n '2,28p' "$0"; exit 0 ;;
    -*) die "unknown option: $1 (see --help)" ;;
    *) [ -z "$FILE" ] || die "only one backup file may be given"; FILE="$1"; shift ;;
  esac
done
[ -n "$FILE" ] || die "usage: $0 [--check-only] [--target-db NAME] [--yes] BACKUP_FILE"
[ -f "$FILE" ] || die "backup file not found: $FILE"

load_config
require_postgres

WORK="$(mktemp -d "${TMPDIR:-/tmp}/shopino-restore.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
trap 'die "restore failed at line $LINENO — the live database was not modified unless step 3 was reported as done"' ERR

# ── 1. Integrity ────────────────────────────────────────────────────────────
SUM_FILE="$FILE.sha256"
[ -f "$SUM_FILE" ] || die "checksum file missing: $SUM_FILE — refusing to restore an unverifiable backup"
expected=$(awk '{print $1}' "$SUM_FILE")
actual=$(sha256sum "$FILE" | awk '{print $1}')
if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
  die "checksum MISMATCH for $FILE (expected ${expected:-nothing}, got $actual)"
fi
log "checksum OK ($actual)"

DUMP="$FILE"
case "$FILE" in
  *.gpg)
    [ -n "$BACKUP_PASSPHRASE_FILE" ] || die "encrypted backup: set BACKUP_PASSPHRASE_FILE in $SHOPINO_ENV_FILE"
    command -v gpg >/dev/null || die "gpg is required to decrypt this backup"
    DUMP="$WORK/restore.dump"
    gpg --batch --quiet --pinentry-mode loopback --passphrase-file "$BACKUP_PASSPHRASE_FILE" \
        --decrypt --output "$DUMP" "$FILE" || die "decryption failed (wrong passphrase or tampered file)"
    log "decrypted (GnuPG integrity check passed)"
    ;;
esac

if [ -f "$FILE.meta" ]; then
  meta_sha=$(grep '^plaintext_sha256=' "$FILE.meta" | cut -d= -f2 || true)
  if [ -n "$meta_sha" ]; then
    [ "$meta_sha" = "$(sha256sum "$DUMP" | awk '{print $1}')" ] || die "plaintext checksum does not match $FILE.meta"
    log "plaintext checksum matches metadata"
  fi
fi

entries=$(pg_exec pg_restore --list < "$DUMP" | grep -cv '^;' || true)
[ "${entries:-0}" -gt 0 ] || die "archive is unreadable or empty"
log "archive readable: $entries entries"

if [ "$CHECK_ONLY" -eq 1 ]; then
  log "check-only: backup is valid and restorable; nothing was changed"
  exit 0
fi

# ── 2. Restore into a fresh database ────────────────────────────────────────
TS="$(date -u +%Y%m%d%H%M%S)"
if [ -n "$TARGET_DB" ]; then
  valid_identifier "$TARGET_DB" || die "--target-db must be lowercase letters, digits and _ (max 50)"
  [ "$TARGET_DB" != "$POSTGRES_DB" ] || die "--target-db must differ from the live database; omit it to replace the live database"
  SCRATCH="$TARGET_DB"
else
  SCRATCH="${POSTGRES_DB}_restore_${TS}"
fi
exists=$(psql_value "SELECT 1 FROM pg_database WHERE datname = '$SCRATCH'" postgres)
[ -z "$exists" ] || die "database $SCRATCH already exists — choose another --target-db or drop it first"

if [ -z "$TARGET_DB" ] && [ "$ASSUME_YES" -ne 1 ]; then
  echo
  echo "  This REPLACES the live database '$POSTGRES_DB' with:"
  echo "    $FILE"
  echo "  The current data is kept as '${POSTGRES_DB}_prerestore_${TS}'."
  echo "  The backend and frontend are stopped during the switch (short downtime)."
  printf '  Type the database name (%s) to continue: ' "$POSTGRES_DB"
  read -r answer
  [ "$answer" = "$POSTGRES_DB" ] || die "confirmation did not match — nothing was changed"
fi

log "restoring into scratch database '$SCRATCH' (single transaction)"
psql_value "CREATE DATABASE \"$SCRATCH\" OWNER \"$POSTGRES_USER\"" postgres >/dev/null
if ! pg_exec pg_restore -U "$POSTGRES_USER" -d "$SCRATCH" --no-owner --no-privileges \
       --single-transaction --exit-on-error < "$DUMP"; then
  psql_value "DROP DATABASE IF EXISTS \"$SCRATCH\"" postgres >/dev/null || true
  die "pg_restore failed; scratch database removed, live database untouched"
fi
tables=$(psql_value "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'" "$SCRATCH")
head=$(psql_value "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY finished_at DESC, migration_name DESC LIMIT 1" "$SCRATCH" 2>/dev/null || echo unknown)
log "restored: $tables tables, prisma migration head: $head"

if [ -n "$TARGET_DB" ]; then
  log "done — backup restored into '$TARGET_DB'. The live database '$POSTGRES_DB' was not touched."
  exit 0
fi

# ── 3. Swap (short, controlled downtime) ────────────────────────────────────
OLD="${POSTGRES_DB}_prerestore_${TS}"
log "stopping backend and frontend"
"${COMPOSE[@]}" stop backend frontend < /dev/null >/dev/null
psql_value "SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE datname = '$POSTGRES_DB' AND pid <> pg_backend_pid()" postgres >/dev/null
psql_value "ALTER DATABASE \"$POSTGRES_DB\" RENAME TO \"$OLD\"" postgres >/dev/null
psql_value "ALTER DATABASE \"$SCRATCH\" RENAME TO \"$POSTGRES_DB\"" postgres >/dev/null
log "step 3 done: '$POSTGRES_DB' now holds the restored data; previous data kept as '$OLD'"

# ── 4. Bring the apps back ──────────────────────────────────────────────────
log "starting backend and frontend"
"${COMPOSE[@]}" up -d --wait backend frontend < /dev/null >/dev/null
log "restore complete — services healthy"
cat <<EOF

  Rollback (if needed):
    ${COMPOSE[*]} stop backend frontend
    ${COMPOSE[*]} exec -T postgres psql -U $POSTGRES_USER -d postgres \\
      -c 'ALTER DATABASE "$POSTGRES_DB" RENAME TO "${POSTGRES_DB}_bad_${TS}"' \\
      -c 'ALTER DATABASE "$OLD" RENAME TO "$POSTGRES_DB"'
    ${COMPOSE[*]} up -d backend frontend
  When the restored data is confirmed, drop the old copy:
    ${COMPOSE[*]} exec -T postgres psql -U $POSTGRES_USER -d postgres -c 'DROP DATABASE "$OLD"'
EOF
```

#### `deploy/systemd/shopino-backup.service`

```ini
# Shopino — daily PostgreSQL backup (triggered by shopino-backup.timer).
# Install: see docs/production-deployment-guide.md § Backups.
[Unit]
Description=Shopino PostgreSQL backup
Wants=docker.service
After=docker.service

[Service]
Type=oneshot
WorkingDirectory=/opt/shopino/app
Environment=SHOPINO_ENV_FILE=/opt/shopino/.env.production
ExecStart=/opt/shopino/app/scripts/backup/backup-postgres.sh
Nice=10
IOSchedulingClass=best-effort
IOSchedulingPriority=7
# Hardening: the job only needs the Docker socket and the backup directory.
PrivateTmp=true
NoNewPrivileges=true
ProtectSystem=full
ReadWritePaths=/var/backups/shopino
```

#### `deploy/systemd/shopino-backup.timer`

```ini
# Daily at 03:30 server time (set the server timezone to Asia/Tehran, or adjust).
# Persistent=true runs a missed backup at the next boot.
[Unit]
Description=Daily Shopino PostgreSQL backup

[Timer]
OnCalendar=*-*-* 03:30:00
RandomizedDelaySec=10m
Persistent=true
Unit=shopino-backup.service

[Install]
WantedBy=timers.target
```

#### `deploy/systemd/shopino-certbot-renew.service`

```ini
# Shopino — Let's Encrypt renewal (webroot). nginx reloads the renewed
# certificate by itself within CERT_RELOAD_INTERVAL (6 h).
[Unit]
Description=Shopino Let's Encrypt certificate renewal
Wants=docker.service
After=docker.service

[Service]
Type=oneshot
WorkingDirectory=/opt/shopino/app
ExecStart=/usr/bin/docker compose -f docker-compose.prod.yml --env-file /opt/shopino/.env.production run --rm certbot renew --webroot -w /var/www/certbot --quiet
ExecStartPost=/usr/bin/docker compose -f docker-compose.prod.yml --env-file /opt/shopino/.env.production exec -T nginx docker-entrypoint.sh reload
PrivateTmp=true
NoNewPrivileges=true
```

#### `deploy/systemd/shopino-certbot-renew.timer`

```ini
# certbot only renews certificates within 30 days of expiry; twice a day is the
# Let's Encrypt recommendation.
[Unit]
Description=Twice-daily Shopino certificate renewal check

[Timer]
OnCalendar=*-*-* 04,16:17:00
RandomizedDelaySec=30m
Persistent=true
Unit=shopino-certbot-renew.service

[Install]
WantedBy=timers.target
```

### CI/CD

#### `.github/workflows/ci.yml`

```yaml
# =============================================================================
# Shopino CI — every pull request and every push to main
#   quality      lint + typecheck (all workspaces), backend unit tests, frontend unit tests
#   backend-e2e  PostgreSQL 16 + Redis 7 (docker-compose.yml), migrations, seed, e2e suites
#   build        production build of every workspace (frontend: next build)
#   docker       builds the four production images and boots nginx with its config
#   infra-lint   shellcheck for deploy/backup scripts, compose validation
# =============================================================================
name: CI

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}

env:
  NODE_VERSION: "22"
  TURBO_TELEMETRY_DISABLED: "1"
  NEXT_TELEMETRY_DISABLED: "1"

jobs:
  quality:
    name: Lint, typecheck, unit tests
    runs-on: ubuntu-24.04
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: pnpm
      - name: Install dependencies
        run: pnpm install --frozen-lockfile
      - name: Prepare CI environment
        run: bash scripts/ci/prepare-env.sh
      - name: Lint
        run: pnpm lint
      - name: Typecheck
        run: pnpm typecheck
      - name: Backend unit tests
        run: pnpm --filter @shopino/backend test
      - name: Frontend unit tests
        run: pnpm --filter @shopino/frontend test

  backend-e2e:
    name: Backend e2e (PostgreSQL + Redis)
    runs-on: ubuntu-24.04
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: pnpm
      - name: Install dependencies
        run: pnpm install --frozen-lockfile
      - name: Prepare CI environment
        run: bash scripts/ci/prepare-env.sh
      - name: Start PostgreSQL 16 and Redis 7
        # The base compose file only (not the dev override): same images,
        # authentication and settings as every other environment.
        run: docker compose -f docker-compose.yml up -d --wait
      - name: Generate Prisma client
        run: pnpm --filter @shopino/backend db:generate
      - name: Apply migrations
        run: pnpm --filter @shopino/backend db:deploy
      - name: Seed master data (development profile)
        run: pnpm --filter @shopino/backend db:seed
      - name: Verify seed
        run: pnpm verify:seed
      - name: End-to-end tests
        run: pnpm --filter @shopino/backend test:e2e
      - name: Service logs on failure
        if: failure()
        run: docker compose -f docker-compose.yml logs --tail=200

  build:
    name: Production build
    runs-on: ubuntu-24.04
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: pnpm
      - name: Install dependencies
        run: pnpm install --frozen-lockfile
      - name: Prepare CI environment
        run: bash scripts/ci/prepare-env.sh
      - name: Build all workspaces
        run: pnpm build

  docker:
    name: Docker images
    runs-on: ubuntu-24.04
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - name: Backend (runner)
        uses: docker/build-push-action@v6
        with:
          context: .
          file: apps/backend/Dockerfile
          target: runner
          tags: shopino/backend:ci
          load: true
          cache-from: type=gha,scope=backend
          cache-to: type=gha,mode=max,scope=backend
      - name: Migrator
        uses: docker/build-push-action@v6
        with:
          context: .
          file: apps/backend/Dockerfile
          target: migrator
          tags: shopino/migrator:ci
          cache-from: type=gha,scope=backend
      - name: Frontend
        uses: docker/build-push-action@v6
        with:
          context: .
          file: apps/frontend/Dockerfile
          tags: shopino/frontend:ci
          load: true
          cache-from: type=gha,scope=frontend
          cache-to: type=gha,mode=max,scope=frontend
      - name: nginx
        uses: docker/build-push-action@v6
        with:
          context: deploy/nginx
          tags: shopino/nginx:ci
          load: true
          cache-from: type=gha,scope=nginx
          cache-to: type=gha,mode=max,scope=nginx
      - name: Image checks (non-root, size)
        run: |
          set -euo pipefail
          for image in shopino/backend:ci shopino/frontend:ci; do
            user=$(docker run --rm --entrypoint id "$image" -u)
            size=$(docker image inspect "$image" --format '{{.Size}}')
            echo "$image uid=$user size=$((size / 1024 / 1024))MB"
            test "$user" != "0"
          done
      - name: Backend refuses sandbox providers in production
        run: |
          set -uo pipefail
          out=$(docker run --rm -e NODE_ENV=production -e DATABASE_URL=postgresql://u:p@127.0.0.1:5432/db \
                  -e DIRECT_URL=postgresql://u:p@127.0.0.1:5432/db -e REDIS_HOST=127.0.0.1 -e REDIS_PORT=6379 -e REDIS_PASSWORD=x \
                  -e JWT_ACCESS_SECRET="$(openssl rand -hex 32)" -e JWT_REFRESH_SECRET="$(openssl rand -hex 32)" \
                  -e PUBLIC_API_ORIGIN=https://ci.test -e SHIPPING_DEFAULT_FEE_PER_VENDOR=0 \
                  -e SHIPPING_FREE_THRESHOLD_PER_VENDOR=0 -e SMS_PROVIDER=sandbox \
                  shopino/backend:ci 2>&1 || true)
          echo "$out" | tail -n 5
          echo "$out" | grep -q "SMS_PROVIDER=sandbox cannot be used in production"
      - name: nginx renders and validates its configuration
        run: |
          set -euo pipefail
          docker run -d --name edge --network host -e SHOPINO_DOMAIN=ci.shopino.test \
            -e FRONTEND_UPSTREAM=127.0.0.1:3000 shopino/nginx:ci
          for _ in $(seq 1 20); do
            [ "$(docker inspect -f '{{.State.Health.Status}}' edge)" = healthy ] && break
            sleep 2
          done
          docker logs edge 2>&1 | grep -v '^{'
          test "$(docker inspect -f '{{.State.Health.Status}}' edge)" = healthy
          curl -sk --resolve ci.shopino.test:443:127.0.0.1 -o /dev/null -D - https://ci.shopino.test/ \
            | grep -i '^strict-transport-security'

  infra-lint:
    name: Infrastructure lint
    runs-on: ubuntu-24.04
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - name: shellcheck
        run: |
          shellcheck -x scripts/backup/*.sh scripts/ci/*.sh deploy/scripts/*.sh
          shellcheck -s sh deploy/nginx/docker-entrypoint.sh
      - name: Validate docker-compose.prod.yml against the env template
        run: |
          set -euo pipefail
          env_file=$(mktemp)
          # Fill every empty key of the template with a syntactically valid value.
          sed -E 's/^([A-Z0-9_]+)=$/\1=ci-value/' deploy/env/production.env.example > "$env_file"
          SHOPINO_ENV_FILE="$env_file" docker compose -f docker-compose.prod.yml --env-file "$env_file" config -q
          SHOPINO_ENV_FILE="$env_file" docker compose -f docker-compose.prod.yml --env-file "$env_file" --profile ops config --services
      - name: Validate base compose
        run: |
          cp .env.example .env
          docker compose -f docker-compose.yml config -q
```

#### `.github/workflows/deploy.yml`

```yaml
# =============================================================================
# Shopino — build, publish and deploy to the production server
# -----------------------------------------------------------------------------
# Triggers: a version tag (v1.2.3) or a manual run (optionally with an existing
# tag to roll back to).
#
#   images  builds backend, migrator, frontend and nginx; pushes
#           <REGISTRY>/<name>:<git sha> (+ :<version tag>) to the registry
#   deploy  GitHub Environment "production" (add required reviewers there),
#           SSH with a pinned host key → git checkout of the same commit on the
#           server → deploy/scripts/deploy.sh --tag <sha> (pre-deploy backup,
#           migrations, rolling restart, smoke test)
#
# Repository configuration
#   variables  REGISTRY            e.g. ghcr.io/acme/shopino (default: ghcr.io/<owner>/shopino)
#              DEPLOY_PATH         checkout on the server (default /opt/shopino/app)
#   secrets    DEPLOY_HOST, DEPLOY_USER, DEPLOY_PORT (optional, default 22)
#              DEPLOY_SSH_KEY      private key of a deploy-only user (docker group)
#              DEPLOY_KNOWN_HOSTS  output of `ssh-keyscan -p <port> <host>` (verified!)
#              REGISTRY_USERNAME / REGISTRY_PASSWORD  only for a non-GHCR registry
#                                  (GHCR uses the workflow's GITHUB_TOKEN)
# =============================================================================
name: Deploy

on:
  push:
    tags: ["v*.*.*"]
  workflow_dispatch:
    inputs:
      image_tag:
        description: "Existing image tag to deploy (rollback). Empty = build this commit."
        required: false
        default: ""

permissions:
  contents: read
  packages: write

concurrency:
  group: deploy-production
  cancel-in-progress: false

jobs:
  images:
    name: Build and push images
    if: ${{ github.event.inputs.image_tag == '' }}
    runs-on: ubuntu-24.04
    timeout-minutes: 40
    outputs:
      registry: ${{ steps.meta.outputs.registry }}
      tag: ${{ steps.meta.outputs.tag }}
    steps:
      - uses: actions/checkout@v4
      - name: Image coordinates
        id: meta
        env:
          REGISTRY_VAR: ${{ vars.REGISTRY }}
          OWNER: ${{ github.repository_owner }}
        run: |
          registry="${REGISTRY_VAR:-ghcr.io/${OWNER}/shopino}"
          {
            echo "registry=${registry,,}"
            echo "host=${registry%%/*}"
            echo "tag=${GITHUB_SHA::12}"
          } >> "$GITHUB_OUTPUT"
      - uses: docker/setup-buildx-action@v3
      - name: Registry login
        uses: docker/login-action@v3
        with:
          registry: ${{ steps.meta.outputs.host }}
          username: ${{ secrets.REGISTRY_USERNAME || github.actor }}
          password: ${{ secrets.REGISTRY_PASSWORD || secrets.GITHUB_TOKEN }}
      - name: Backend
        uses: docker/build-push-action@v6
        with:
          context: .
          file: apps/backend/Dockerfile
          target: runner
          push: true
          tags: |
            ${{ steps.meta.outputs.registry }}/backend:${{ steps.meta.outputs.tag }}
            ${{ startsWith(github.ref, 'refs/tags/') && format('{0}/backend:{1}', steps.meta.outputs.registry, github.ref_name) || '' }}
          cache-from: type=gha,scope=backend
          cache-to: type=gha,mode=max,scope=backend
      - name: Migrator
        uses: docker/build-push-action@v6
        with:
          context: .
          file: apps/backend/Dockerfile
          target: migrator
          push: true
          tags: ${{ steps.meta.outputs.registry }}/migrator:${{ steps.meta.outputs.tag }}
          cache-from: type=gha,scope=backend
      - name: Frontend
        uses: docker/build-push-action@v6
        with:
          context: .
          file: apps/frontend/Dockerfile
          push: true
          tags: |
            ${{ steps.meta.outputs.registry }}/frontend:${{ steps.meta.outputs.tag }}
            ${{ startsWith(github.ref, 'refs/tags/') && format('{0}/frontend:{1}', steps.meta.outputs.registry, github.ref_name) || '' }}
          cache-from: type=gha,scope=frontend
          cache-to: type=gha,mode=max,scope=frontend
      - name: nginx
        uses: docker/build-push-action@v6
        with:
          context: deploy/nginx
          push: true
          tags: ${{ steps.meta.outputs.registry }}/nginx:${{ steps.meta.outputs.tag }}
          cache-from: type=gha,scope=nginx
          cache-to: type=gha,mode=max,scope=nginx

  deploy:
    name: Deploy to production
    needs: [images]
    # Runs after a successful build, or alone for a rollback to an existing tag.
    if: ${{ always() && (needs.images.result == 'success' || (needs.images.result == 'skipped' && github.event.inputs.image_tag != '')) }}
    runs-on: ubuntu-24.04
    timeout-minutes: 30
    environment:
      name: production
    steps:
      - name: Resolve image tag
        id: target
        env:
          BUILT_TAG: ${{ needs.images.outputs.tag }}
          BUILT_REGISTRY: ${{ needs.images.outputs.registry }}
          INPUT_TAG: ${{ github.event.inputs.image_tag }}
          REGISTRY_VAR: ${{ vars.REGISTRY }}
          OWNER: ${{ github.repository_owner }}
        run: |
          registry="${BUILT_REGISTRY:-${REGISTRY_VAR:-ghcr.io/${OWNER}/shopino}}"
          tag="${INPUT_TAG:-$BUILT_TAG}"
          [[ "$tag" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "invalid image tag: $tag"; exit 1; }
          {
            echo "registry=${registry,,}"
            echo "host=${registry%%/*}"
            echo "tag=$tag"
          } >> "$GITHUB_OUTPUT"
      - name: Configure SSH (pinned host key)
        env:
          SSH_KEY: ${{ secrets.DEPLOY_SSH_KEY }}
          KNOWN_HOSTS: ${{ secrets.DEPLOY_KNOWN_HOSTS }}
        run: |
          install -d -m 700 ~/.ssh
          printf '%s\n' "$SSH_KEY" > ~/.ssh/deploy_key
          chmod 600 ~/.ssh/deploy_key
          printf '%s\n' "$KNOWN_HOSTS" > ~/.ssh/known_hosts
          chmod 644 ~/.ssh/known_hosts
      - name: Deploy over SSH
        env:
          HOST: ${{ secrets.DEPLOY_HOST }}
          USER: ${{ secrets.DEPLOY_USER }}
          PORT: ${{ secrets.DEPLOY_PORT || '22' }}
          DEPLOY_PATH: ${{ vars.DEPLOY_PATH || '/opt/shopino/app' }}
          REGISTRY: ${{ steps.target.outputs.registry }}
          REGISTRY_HOST: ${{ steps.target.outputs.host }}
          TAG: ${{ steps.target.outputs.tag }}
          COMMIT: ${{ github.sha }}
          ROLLBACK: ${{ github.event.inputs.image_tag != '' }}
          REGISTRY_USERNAME: ${{ secrets.REGISTRY_USERNAME || github.actor }}
          REGISTRY_PASSWORD: ${{ secrets.REGISTRY_PASSWORD || secrets.GITHUB_TOKEN }}
        run: |
          ssh_cmd=(ssh -i ~/.ssh/deploy_key -p "$PORT" -o StrictHostKeyChecking=yes -o BatchMode=yes "$USER@$HOST")
          # Registry credentials go over stdin, never on a command line.
          printf '%s' "$REGISTRY_PASSWORD" | "${ssh_cmd[@]}" \
            "docker login '$REGISTRY_HOST' -u '$REGISTRY_USERNAME' --password-stdin >/dev/null"
          "${ssh_cmd[@]}" bash -s -- "$DEPLOY_PATH" "$COMMIT" "$REGISTRY" "$TAG" "$ROLLBACK" <<'REMOTE'
          set -euo pipefail
          path="$1"; commit="$2"; registry="$3"; tag="$4"; rollback="$5"
          cd "$path"
          git fetch --quiet --tags origin
          # Compose file + scripts from the same revision as the images. A rollback
          # keeps the checked-out revision (the old tag's images are compatible
          # with it only if no migration was added since — see the deployment guide).
          if [ "$rollback" != "true" ]; then
            git checkout --quiet --detach "$commit"
          fi
          deploy/scripts/deploy.sh --tag "$tag" --registry "$registry"
          REMOTE
      - name: Registry logout
        if: always()
        env:
          HOST: ${{ secrets.DEPLOY_HOST }}
          USER: ${{ secrets.DEPLOY_USER }}
          PORT: ${{ secrets.DEPLOY_PORT || '22' }}
          REGISTRY_HOST: ${{ steps.target.outputs.host }}
        run: |
          ssh -i ~/.ssh/deploy_key -p "$PORT" -o StrictHostKeyChecking=yes -o BatchMode=yes "$USER@$HOST" \
            "docker logout '$REGISTRY_HOST' >/dev/null" || true
          rm -f ~/.ssh/deploy_key
```

#### `scripts/ci/prepare-env.sh`

```bash
#!/usr/bin/env bash
# =============================================================================
# CI: create the root .env from .env.example with throw-away values.
# -----------------------------------------------------------------------------
# Every secret is freshly random per run (nothing is stored in the repository);
# providers are the development/test SANDBOX implementations, which is what the
# unit and e2e suites exercise. Never use this file outside CI.
#
#   bash scripts/ci/prepare-env.sh            # writes ./.env (fails if it exists)
# =============================================================================
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

[ -f .env.example ] || { echo "prepare-env: .env.example not found" >&2; exit 1; }
[ ! -e .env ] || { echo "prepare-env: .env already exists — refusing to overwrite" >&2; exit 1; }

rand() { openssl rand -hex "${1:-24}"; }
PG_PASSWORD="$(rand 18)"
REDIS_PASSWORD="$(rand 18)"

declare -A VALUES=(
  [NODE_ENV]=development
  [LOG_LEVEL]=warn
  [POSTGRES_USER]=shopino
  [POSTGRES_PASSWORD]="$PG_PASSWORD"
  [POSTGRES_DB]=shopino_ci
  [DATABASE_URL]="postgresql://shopino:${PG_PASSWORD}@127.0.0.1:5432/shopino_ci?schema=public&connection_limit=10&pool_timeout=20"
  [DIRECT_URL]="postgresql://shopino:${PG_PASSWORD}@127.0.0.1:5432/shopino_ci?schema=public"
  [REDIS_HOST]=127.0.0.1
  [REDIS_PASSWORD]="$REDIS_PASSWORD"
  [JWT_ACCESS_SECRET]="$(rand 32)"
  [JWT_REFRESH_SECRET]="$(rand 32)"
  [SMS_PROVIDER]=sandbox
  [SMS_SANDBOX_LOG_CODES]=true
  [STORAGE_PROVIDER]=local
  [PAYMENT_GATEWAY_PROVIDER]=sandbox
  [SEED_PROFILE]=development
  [SUPER_ADMIN_PASSWORD]="Ci-$(rand 12)"
  [SEED_STAFF_PASSWORD]="Ci-$(rand 12)"
  [SEED_VENDOR_PASSWORD]="Ci-$(rand 12)"
  [PUBLIC_API_ORIGIN]=http://localhost:3000
  [BACKEND_INTERNAL_URL]=http://127.0.0.1:4000
)

for key in "${!VALUES[@]}"; do
  grep -qE "^${key}=" .env.example || { echo "prepare-env: $key is missing from .env.example" >&2; exit 1; }
done

# Rewrite line by line in bash: values are inserted literally (a sed
# replacement would interpret '&' and '\' inside the database URLs).
tmp="$(mktemp)"
while IFS= read -r line || [ -n "$line" ]; do
  key="${line%%=*}"
  if [ "$key" != "$line" ] && [ -n "${VALUES[$key]+set}" ]; then
    printf '%s=%s\n' "$key" "${VALUES[$key]}"
  else
    printf '%s\n' "$line"
  fi
done < .env.example > "$tmp"
install -m 600 "$tmp" .env
rm -f "$tmp"

# Mask generated secrets in the GitHub Actions log.
if [ -n "${GITHUB_ACTIONS:-}" ]; then
  for key in POSTGRES_PASSWORD REDIS_PASSWORD JWT_ACCESS_SECRET JWT_REFRESH_SECRET SUPER_ADMIN_PASSWORD SEED_STAFF_PASSWORD SEED_VENDOR_PASSWORD; do
    echo "::add-mask::${VALUES[$key]}"
  done
fi
echo "prepare-env: wrote .env (sandbox providers, random secrets)"
```

