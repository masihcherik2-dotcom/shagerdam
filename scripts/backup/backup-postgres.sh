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
