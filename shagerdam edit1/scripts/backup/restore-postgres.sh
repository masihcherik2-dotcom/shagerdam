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
