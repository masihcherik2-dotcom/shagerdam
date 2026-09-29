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
