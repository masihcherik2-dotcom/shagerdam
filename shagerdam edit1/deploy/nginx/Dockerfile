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
