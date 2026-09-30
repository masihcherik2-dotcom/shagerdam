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
