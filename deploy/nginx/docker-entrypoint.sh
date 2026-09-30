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
# trustseal.enamad.ir / logo.samandehi.ir: the footer trust-seal images
# (they must load from the issuer; see /admin/site-info).
# The single quotes are literal CSP syntax ('self', 'none'), not shell quoting.
# shellcheck disable=SC2089,SC2090
SHOPINO_CSP="default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://trustseal.enamad.ir https://logo.samandehi.ir ${CSP_EXTRA_IMG_SRC}; font-src 'self' data:; connect-src 'self'; media-src 'self'; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self' ${CSP_FORM_ACTION_EXTRA}; upgrade-insecure-requests"
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
