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
