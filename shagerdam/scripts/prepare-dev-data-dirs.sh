#!/usr/bin/env bash
#
# Prepares the development persistence directories used by
# docker-compose.override.yml (decision: Strategy B).
#
# Why this is needed: when a bind-mount source does not exist, Docker creates it
# as root:root. The official postgres and redis images run as uid 999, so they
# cannot write into a root-owned directory and the containers fail to start.
# This script creates the directories and, on Linux, hands them to the correct
# uid. macOS and Windows Docker Desktop map permissions transparently and are
# left untouched.
#
# Idempotent: safe to run before every `docker compose up`.
#
# Usage:  bash scripts/prepare-dev-data-dirs.sh     (also: pnpm infra:prepare)
#
set -euo pipefail

DATA_ROOT=".docker-data"
POSTGRES_DIR="${DATA_ROOT}/postgres"
REDIS_DIR="${DATA_ROOT}/redis"
POSTGRES_UID=999
REDIS_UID=999

log() { printf '[infra:prepare] %s\n' "$*"; }

if [ "$(uname -s)" != "Linux" ]; then
  log "not Linux — Docker Desktop handles bind-mount ownership; creating directories only"
  mkdir -p "${POSTGRES_DIR}" "${REDIS_DIR}"
  exit 0
fi

mkdir -p "${POSTGRES_DIR}" "${REDIS_DIR}"

needs_chown() {
  local dir="$1" uid="$2"
  [ "$(stat -c '%u' "${dir}")" != "${uid}" ]
}

CHOWN_CMD=""
if [ "$(id -u)" -eq 0 ]; then
  CHOWN_CMD="chown"
elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
  # Passwordless sudo (CI containers, remote dev sandboxes).
  CHOWN_CMD="sudo -n chown"
fi

if [ -n "${CHOWN_CMD}" ]; then
  if needs_chown "${POSTGRES_DIR}" "${POSTGRES_UID}"; then
    ${CHOWN_CMD} -R "${POSTGRES_UID}:${POSTGRES_UID}" "${POSTGRES_DIR}"
    log "ownership set: ${POSTGRES_DIR} → ${POSTGRES_UID}:${POSTGRES_UID}"
  fi
  if needs_chown "${REDIS_DIR}" "${REDIS_UID}"; then
    ${CHOWN_CMD} -R "${REDIS_UID}:${REDIS_UID}" "${REDIS_DIR}"
    log "ownership set: ${REDIS_DIR} → ${REDIS_UID}:${REDIS_UID}"
  fi
fi

# Report rather than fail: on a machine without root the developer can either
# run this script with sudo once, or accept that Docker will create the
# directories itself and report a clear permission error at startup.
for pair in "${POSTGRES_DIR}:${POSTGRES_UID}" "${REDIS_DIR}:${REDIS_UID}"; do
  dir="${pair%%:*}"
  uid="${pair##*:}"
  owner="$(stat -c '%u' "${dir}")"
  if [ "${owner}" = "${uid}" ]; then
    log "ok   ${dir} (uid ${owner})"
  else
    printf '[infra:prepare][WARN] %s is owned by uid %s, expected %s.\n' "${dir}" "${owner}" "${uid}" >&2
    printf '                      Run: sudo chown -R %s:%s %s\n' "${uid}" "${uid}" "${dir}" >&2
  fi
done

log "development data directories ready"
