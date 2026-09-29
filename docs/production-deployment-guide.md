# Shopino — Production Deployment Guide

This guide takes a fresh Ubuntu LTS server to a running Shopino marketplace:
- HTTPS with Let's Encrypt;
- real SMS (Kavenegar), card payments (Zarinpal) and object storage (ArvanCloud or Liara);
- daily encrypted backups;
- CI/CD from GitHub Actions.

Every command in it was run against the stack in this repository, except the steps that need real external accounts. Those are marked **[needs account]**.

---

## 0. What runs where

```
Internet ──► :80/:443  nginx (TLS, security headers, gzip/Brotli, rate limits)
                          │  network "edge"
                          ▼
                       frontend  Next.js storefront + panels + same-origin BFF (/api/v1, /api/session)
                          │  network "app"  (outbound allowed: SMS, bank, S3)
                          ▼
                       backend   NestJS API :4000 (never published)
                          │  network "data" (internal: no route to the internet)
                          ├──► postgres 16   (volume postgres_data)
                          └──► redis 7       (volume redis_data, AOF)
```

- **Only nginx publishes ports.** The browser talks to Next.js only. The BFF turns the httpOnly session cookies into Bearer tokens and calls the API over the private network. The API docs (`/api/docs`) are therefore not public.
- The **frontend container holds no secrets**. Its only runtime setting is `BACKEND_INTERNAL_URL`.
- The containers run with non-root users (backend and frontend uid 1000), read-only root filesystems (backend, frontend, redis), `no-new-privileges`, all Linux capabilities dropped (nginx keeps only what it needs to bind 80/443 and switch to its worker user), memory limits and log rotation.

Infrastructure files:

| Path | Purpose |
|---|---|
| `apps/backend/Dockerfile` | API image (`runner`) and operations image (`migrator`: migrations + seed) |
| `apps/frontend/Dockerfile` | Next.js standalone image |
| `deploy/nginx/` | Edge proxy image: `nginx.conf`, site template, security headers, entrypoint (certificates, config rendering) |
| `docker-compose.prod.yml` | The production stack |
| `deploy/env/production.env.example` | Template of `/opt/shopino/.env.production` |
| `deploy/scripts/deploy.sh` | Deploy/upgrade/rollback on the server |
| `scripts/backup/backup-postgres.sh`, `restore-postgres.sh` | Backups and restores |
| `deploy/systemd/*.service`, `*.timer` | Daily backup, certificate renewal |
| `.github/workflows/ci.yml`, `deploy.yml` | CI and CD |

---

## 1. Provision the server

### 1.1 Size

| Traffic | vCPU | RAM | Disk |
|---|---|---|---|
| Launch / low | 2 | 4 GB | 60 GB SSD |
| Growing | 4 | 8 GB | 120 GB SSD + object storage |

The stack itself idles at about 200 MB of RAM (measured). The margin is for PostgreSQL's cache, image processing (`sharp`) and building images on the server if you choose to.

Use **Ubuntu Server 24.04 LTS** (22.04 LTS also works). Iranian data centres (ArvanCloud, Pars Online, Asiatech, Afranet, …) keep latency low for Iranian customers. Payment gateways and SMS providers also work reliably from Iranian IP addresses.

### 1.2 Base hardening

```bash
# as root, once
adduser --disabled-password --gecos "" shopino
usermod -aG sudo shopino
install -d -m 700 -o shopino -g shopino /home/shopino/.ssh
cp ~/.ssh/authorized_keys /home/shopino/.ssh/ && chown shopino: /home/shopino/.ssh/authorized_keys

# SSH: keys only, no root login
sed -i -E 's/^#?PasswordAuthentication .*/PasswordAuthentication no/; s/^#?PermitRootLogin .*/PermitRootLogin no/' /etc/ssh/sshd_config
systemctl restart ssh

# firewall: SSH + HTTP + HTTPS only
ufw default deny incoming && ufw default allow outgoing
ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp
ufw enable

# security updates, clock, time zone
apt-get update && apt-get -y upgrade
apt-get install -y unattended-upgrades fail2ban git curl gnupg ca-certificates
dpkg-reconfigure -f noninteractive unattended-upgrades
timedatectl set-timezone Asia/Tehran     # backup timer times are server-local

# swap (protects against OOM during image builds)
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

> **Docker and ufw:** ports published by Docker bypass ufw's INPUT rules. This stack publishes **only** 80/443 (nginx). PostgreSQL, Redis, the API and Next.js have no published ports, so there is nothing else to protect.

### 1.3 Docker Engine + Compose v2

```bash
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update && apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
usermod -aG docker shopino        # membership of "docker" is root-equivalent: only for the deploy user
docker compose version            # must be v2.20+
```

**Servers in Iran:**
- **Docker Hub:** it blocks Iranian IP addresses ([Docker's notice, quoted here](https://github.com/Gozargah/Marzban/discussions/987)). Configure a Docker Hub mirror for the public base images (`postgres`, `redis`, `alpine`, `node`, `certbot`), e.g. ArvanCloud's ([mirror list](https://mirrors.arash-hatami.ir/)):

  ```bash
  cat > /etc/docker/daemon.json <<'EOF'
  { "registry-mirrors": ["https://docker.arvancloud.ir"] }
  EOF
  systemctl restart docker
  ```

- **Shopino images:** GitHub and GHCR may also be unreachable. Either push them to a registry the server can reach (e.g. ArvanCloud Container Registry; set the repository variable `REGISTRY`, see §8), or build them on the server with `deploy.sh --build` (this needs access to the npm registry or an npm mirror).

### 1.4 Directory layout

```bash
sudo install -d -m 750 -o shopino -g shopino /opt/shopino
sudo install -d -m 700 -o root -g root /var/backups/shopino
sudo -u shopino git clone <your-repository-url> /opt/shopino/app
```

| Path | Content |
|---|---|
| `/opt/shopino/app` | Repository checkout (compose file, nginx build context, scripts) |
| `/opt/shopino/.env.production` | **All secrets**, mode 600, never in git |
| `/opt/shopino/backup.passphrase` | Backup encryption key, mode 600 (keep a copy off the server) |
| `/var/backups/shopino` | Local backups (copy them off-site, see §7.4) |

---

## 2. DNS

Create these records at your DNS provider:

| Type | Name | Value |
|---|---|---|
| A | `example.ir` | server IPv4 |
| A | `www.example.ir` | server IPv4 |
| AAAA | both (optional) | server IPv6 |

Wait until `dig +short example.ir` returns the server address; Let's Encrypt validates over HTTP.

**Behind a CDN / reverse proxy** (e.g. ArvanCloud CDN):
- Set `TRUSTED_PROXY_CIDRS` to the CDN's published egress ranges. Only then does nginx accept the `X-Forwarded-For` header as the client address.
- Without that setting, all visitors appear to come from the CDN, so the rate limits and the API's per-IP OTP limits would treat them as a single client.
- With a wrong (too broad) setting, clients can spoof their address.
- Leave it empty when clients connect directly.

---

## 3. Configure the environment

```bash
cd /opt/shopino/app
sudo install -m 600 -o shopino -g shopino deploy/env/production.env.example /opt/shopino/.env.production
nano /opt/shopino/.env.production
```

Every `REQUIRED` key must be filled; `deploy.sh` refuses to run otherwise. Generate secrets on the server:

```bash
openssl rand -hex 24     # POSTGRES_PASSWORD, REDIS_PASSWORD (hex: safe inside URLs)
openssl rand -base64 48  # JWT_ACCESS_SECRET and JWT_REFRESH_SECRET (two different values)
openssl rand -base64 24  # SUPER_ADMIN_PASSWORD
```

Key points:

| Key | Value |
|---|---|
| `SHOPINO_DOMAIN` | `example.ir` (canonical; `SHOPINO_EXTRA_DOMAINS="www.example.ir"` redirects to it) |
| `PUBLIC_API_ORIGIN` | `https://example.ir`: the bank redirects the customer to `https://example.ir/api/v1/payments/callback`, which the BFF forwards to the API |
| `CORS_ORIGINS` | `https://example.ir` |
| `DATABASE_URL` / `DIRECT_URL` | Host **`postgres`** (compose service), the same password as `POSTGRES_PASSWORD` |
| `LETSENCRYPT_EMAIL` | Receives expiry warnings |

`NODE_ENV=production`, `HOST`, `PORT` and `REDIS_HOST` are forced by `docker-compose.prod.yml`.

In production the API **refuses to start** with:
- `SMS_PROVIDER=sandbox`;
- `PAYMENT_GATEWAY_PROVIDER=sandbox`;
- missing or short JWT secrets;
- `STORAGE_PROVIDER=s3` without a bucket or keys.

`deploy.sh` checks the same things before touching anything.

---

## 4. Switch from sandbox to real providers

In development every external integration uses a sandbox implementation behind the same interface. Production selects the real one purely by configuration. No code changes are needed.

| Concern | Development | Production | Status |
|---|---|---|---|
| SMS / OTP | `sandbox` (code printed to the log) | `kavenegar` | Implemented (`KavenegarSmsProvider`) |
| Card payment | `sandbox` (built-in simulated bank page) | `zarinpal` (IPG v4) | Implemented (`ZarinpalPaymentGatewayProvider`) |
| File storage | `local` (volume) | `s3` (ArvanCloud / Liara / any S3-compatible store) | Implemented (`S3StorageProvider`) |
| BNPL credit | `SANDBOX_BANK` | a bank's live credit API | **Not implemented**; see §4.4 |

### 4.1 SMS: Kavenegar [needs account]

1. Create a Kavenegar account and charge it. Buy or activate a sender line.
2. In the panel, create a **verification ("lookup") template** for login codes, with a single `%token` parameter. Example body: `کد ورود شما به شاپینو: %token`. Wait for approval.
   - OTP messages use the `verify/lookup` endpoint. It is the fast, pre-approved channel for codes that Iranian operators require.
   - Other messages use `sms/send`.
3. Fill in:

```
SMS_PROVIDER=kavenegar
SMS_SANDBOX_LOG_CODES=false
SMS_KAVENEGAR_API_KEY=<API key from the panel>
SMS_KAVENEGAR_SENDER=<sender line number>
SMS_KAVENEGAR_OTP_TEMPLATE=<template name>
```

The API key travels in the request path of the Kavenegar API. Treat it as a secret, and rotate it in the panel if it leaks.

Verification after deploy:
- `curl https://example.ir/api/v1/auth/sms-provider` (public) reports the active provider (`kavenegar`).
- Sign in with your own mobile number on `/login`.

### 4.2 Card payments: Zarinpal [needs account]

1. Register the business at Zarinpal and complete merchant verification. Register the **domain** `example.ir` for the gateway; Zarinpal only accepts callbacks on the registered domain.
2. Copy the 36-character **merchant ID**.
3. Fill in:

```
PAYMENT_GATEWAY_PROVIDER=zarinpal
ZARINPAL_MERCHANT_ID=<merchant id>
ZARINPAL_API_BASE_URL=https://payment.zarinpal.com
PUBLIC_API_ORIGIN=https://example.ir
PAYMENT_RESULT_REDIRECT_URL=/payment/result
```

Flow:
1. Checkout calls `payment/request.json`.
2. The customer is redirected to `https://payment.zarinpal.com/pg/StartPay/<authority>`.
3. The customer returns to `/api/v1/payments/callback?Authority=…&Status=OK|NOK`, which is served through nginx and the BFF.
4. The API calls `payment/verify.json`. Code 100, or 101 for "already verified", counts as paid.
5. The customer is redirected to `/payment/result`.

Staging tip: `ZARINPAL_API_BASE_URL=https://sandbox.zarinpal.com` uses Zarinpal's own test host (no real money) with the live code path. Never leave it like that in production.

nginx's CSP allows `https://payment.zarinpal.com` as a form target (`CSP_FORM_ACTION_EXTRA`).

### 4.3 Object storage: ArvanCloud or Liara [needs account]

Uploads are stored as follows:
- **product images, store logos/banners and avatars** under `images/…`: public, served from the bucket/CDN URL;
- **KYC and dispute documents** under `documents/…`: private, downloaded only through the authenticated API.

The API sends no ACL headers; visibility is decided by the bucket policy.

1. Create a **private** bucket and an access key limited to that bucket.
2. Allow anonymous `GetObject` on `images/*` **only**. Never make `documents/*` public. Bucket policy (S3 syntax; both providers accept it through their S3 API or panel):

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "PublicImages",
    "Effect": "Allow",
    "Principal": "*",
    "Action": ["s3:GetObject"],
    "Resource": ["arn:aws:s3:::<bucket>/images/*"]
  }]
}
```

3. Optionally put a CDN domain in front of the bucket, e.g. `https://cdn.example.ir`.
4. Fill in:

**ArvanCloud** (endpoints from the [ArvanCloud SDK documentation](https://docs.arvancloud.ir/en/developer-tools/sdk/object-storage/): Simin `https://s3.ir-thr-at1.arvanstorage.ir`, Shahriar `https://s3.ir-tbz-sh1.arvanstorage.ir`):

```
STORAGE_PROVIDER=s3
S3_ENDPOINT=https://s3.ir-thr-at1.arvanstorage.ir
S3_REGION=ir-thr-at1
S3_BUCKET=<bucket>
S3_ACCESS_KEY_ID=<access key>
S3_SECRET_ACCESS_KEY=<secret key>
S3_FORCE_PATH_STYLE=true
S3_PUBLIC_BASE_URL=https://cdn.example.ir        # or https://<bucket>.s3.ir-thr-at1.arvanstorage.ir
CSP_EXTRA_IMG_SRC=https://cdn.example.ir         # the same origin, for the Content-Security-Policy
```

**Liara:**
- Copy the endpoint from the bucket's *Settings → SDK access* page. Liara's documentation and rclone list `https://storage.iran.liara.space` ([rclone](https://rclone.org/s3/), [Liara docs](https://docs.liara.ir/object-storage/how-tos/connect-via-platform/laravel/)).
- Liara uses path-style addressing, and its examples use region `us-east-1` / `default`.

```
STORAGE_PROVIDER=s3
S3_ENDPOINT=<endpoint from the Liara panel>
S3_REGION=us-east-1
S3_FORCE_PATH_STYLE=true
S3_BUCKET=…  S3_ACCESS_KEY_ID=…  S3_SECRET_ACCESS_KEY=…
S3_PUBLIC_BASE_URL=<public bucket or CDN URL>
CSP_EXTRA_IMG_SRC=<its origin>
```

`STORAGE_PROVIDER=local` is accepted (files go to the `uploads` volume, which the backups do **not** include) but logs a warning. Use it only for a single server, and back the volume up separately.

### 4.4 BNPL credit (`credit.enabled`)

**Current state:**
- The credit module (applications, limits, installment plans, overdue sweeps) is complete.
- The only implemented bank adapter is `SANDBOX_BANK`, a development/test simulation. The provider registry **refuses it in production** (HTTP 503 `CREDIT_PROVIDER_NOT_ALLOWED`).
- `SAMAN_BANK`, `BLUBANK` and `DIGIPAY` exist only as inactive catalogue rows; **their API adapters are not implemented**.
- The production seed therefore sets `credit.enabled=false` and `credits.activeProvider=''`. The storefront hides credit purchases, and no customer can start one.

**Enabling credit** requires, in this order:
1. A signed agreement with the bank or BNPL provider, and its API specification and credentials.
2. A new adapter implementing `CreditProviderAdapter` (`apps/backend/src/modules/credit/providers/credit-provider.interface.ts`; `SandboxBankProvider` is the reference implementation), registered in `credit-provider.registry.ts` and covered by tests. This is a development task, not configuration.
3. Deploy, then switch it on. There is no admin UI for these two settings yet, so use SQL:

```bash
cd /opt/shopino/app
docker compose -f docker-compose.prod.yml --env-file /opt/shopino/.env.production exec -T postgres \
  psql -U shopino -d shopino -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
UPDATE credit_providers SET is_active = true WHERE code = 'SAMAN_BANK';      -- the implemented provider
UPDATE system_configs SET value = 'SAMAN_BANK' WHERE key = 'credits.activeProvider';
UPDATE system_configs SET value = 'true'       WHERE key = 'credit.enabled';
COMMIT;
SQL
```

Switching it off again is the reverse (`credit.enabled='false'`). Existing installment schedules keep running.

---

## 5. TLS certificates (Let's Encrypt)

nginx starts immediately with a 7-day **self-signed** placeholder certificate. It switches to the Let's Encrypt certificate automatically within 6 h, or immediately with `docker-entrypoint.sh reload`, which re-selects the certificate, validates the configuration and reloads nginx.

1. **First deploy** (§6) brings nginx up on port 80 with the ACME webroot.
2. **Issue the certificate** (all names in `SHOPINO_DOMAIN` + `SHOPINO_EXTRA_DOMAINS`):

```bash
cd /opt/shopino/app
export SHOPINO_ENV_FILE=/opt/shopino/.env.production
C="docker compose -f docker-compose.prod.yml --env-file $SHOPINO_ENV_FILE"
$C run --rm certbot certonly --webroot -w /var/www/certbot \
   -d example.ir -d www.example.ir \
   --email admin@example.ir --agree-tos --no-eff-email --non-interactive
$C exec nginx docker-entrypoint.sh reload            # switch from the placeholder to the new certificate
curl -sI https://example.ir | head -1                 # HTTP/2 200 with a valid certificate
```

3. **Renewal:** `shopino-certbot-renew.timer` (twice a day, as Let's Encrypt recommends) runs `certbot renew`, then `docker-entrypoint.sh reload` inside nginx:

```bash
sudo cp deploy/systemd/shopino-certbot-renew.* /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now shopino-certbot-renew.timer
sudo systemctl start shopino-certbot-renew.service && journalctl -u shopino-certbot-renew -n 20
```

TLS settings follow the Mozilla "intermediate" profile: TLS 1.2 and 1.3, TLS 1.1 refused (tested). Unknown host names get the TLS handshake rejected.

**HSTS:**
- `max-age=63072000; includeSubDomains`, without `preload`.
- Every subdomain of the domain must serve HTTPS before you go live.
- Submit to the browser preload list only as a deliberate, separate decision.

---

## 6. First-time installation (migrations + seed)

```bash
cd /opt/shopino/app
deploy/scripts/deploy.sh --build --seed                                    # build on the server
# or, with CI-built images:
deploy/scripts/deploy.sh --tag <image-tag> --registry ghcr.io/<owner>/shopino --seed
```

`deploy.sh` runs these steps:
1. Validates `/opt/shopino/.env.production`: file mode 600, required keys present, production providers selected, `PUBLIC_API_ORIGIN = https://SHOPINO_DOMAIN`, different JWT secrets of at least 32 characters, `DATABASE_URL` pointing at the `postgres` service.
2. Builds or pulls the images.
3. Makes a pre-deploy backup when a database is already running.
4. Starts PostgreSQL and Redis, and waits for their health checks.
5. **`prisma migrate deploy`** in the one-off `migrate` container, which applies only pending migrations.
6. With `--seed`: **the seed, production profile.** It creates only:
   - the super admin from `SUPER_ADMIN_*`;
   - the optional support/finance accounts from `SEED_SUPPORT_*` / `SEED_FINANCE_*` (password `SEED_STAFF_PASSWORD`);
   - the category tree with default commission rates;
   - the credit provider catalogue (all inactive) and plans;
   - the platform settings (commission 12%, escrow 7 days, settlement minimum, `credit.enabled=false`).

   The production profile creates no sample shop, no products and no demo customers.
7. Starts backend → frontend → nginx, waiting for each health check.
8. Smoke-tests `/`, `/api/session` and `/api/v1/products` through nginx.

**The seed is idempotent and create-only in production:**
- Running it again adds only missing rows.
- It never overwrites an admin's later changes to categories, commissions or settings (verified).
- It never replaces an existing password unless `SEED_RESET_ADMIN_PASSWORD=true`.
- Accepted mobile formats: `09…`, `+989…` and `00989…`.

Then:
1. Issue the certificate (§5).
2. Sign in at `https://example.ir/login` with the super-admin e-mail and password, and change the password.
3. Remove `SUPER_ADMIN_PASSWORD` and `SEED_STAFF_PASSWORD` from the env file (they are not needed at runtime).
4. Onboard the first vendors through the vendor application flow.

Manual equivalents:

```bash
export SHOPINO_ENV_FILE=/opt/shopino/.env.production
C="docker compose -f docker-compose.prod.yml --env-file $SHOPINO_ENV_FILE"
$C run --rm migrate                                                     # migrations
$C run --rm migrate ts-node --project tsconfig.json prisma/seed.ts      # seed
$C ps                                                                   # all "healthy"
$C logs -f --tail=100 backend
```

---

## 7. Backups and restores

### 7.1 What is backed up

- **Database:** `pg_dump` runs **inside** the postgres container, so the client and server versions always match. It is a consistent snapshot while the shop keeps running.
  - **Format:** custom (`-Fc`), zlib level 6.
  - **Verification:** the archive is read back with `pg_restore --list` before it is kept.
  - **Encryption (optional):** GnuPG AES-256, which has its own integrity check.
- **Sidecar files:** `.sha256` (checksum) and `.meta` (server version, Prisma migration head, plaintext checksum).
- **Not in the dump:**
  - **Object storage:** use the provider's versioning or replication.
  - **The `uploads` volume**, only relevant with `STORAGE_PROVIDER=local`.
  - **The env file:** keep an encrypted copy in your password manager.

### 7.2 Daily backup

```bash
# encryption key (keep a second copy OFF the server — without it backups are unrecoverable)
sudo sh -c 'openssl rand -base64 48 > /opt/shopino/backup.passphrase && chmod 600 /opt/shopino/backup.passphrase'
# in /opt/shopino/.env.production:
#   BACKUP_DIR=/var/backups/shopino
#   BACKUP_RETENTION_DAYS=30
#   BACKUP_PASSPHRASE_FILE=/opt/shopino/backup.passphrase

sudo /opt/shopino/app/scripts/backup/backup-postgres.sh          # first run by hand
sudo cp /opt/shopino/app/deploy/systemd/shopino-backup.* /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now shopino-backup.timer
systemctl list-timers shopino-backup.timer
journalctl -u shopino-backup -n 20
```

The timer runs daily at 03:30 server time (`Persistent=true` catches up after downtime).
- **Retention:** 30 days.
- **Pruning:** only after a successful backup, so a failing job never deletes the last good copies.
- **Concurrent runs:** refused (`flock`).
- **Permissions:** files 600, directory 700.
- **Monitoring:** a failed job leaves the systemd unit `failed`. Hook `OnFailure=` or your monitoring to it.

### 7.3 Restore (one command)

```bash
cd /opt/shopino/app
F=/var/backups/shopino/shopino_shopino_20261001T000000Z.dump.gpg

sudo scripts/backup/restore-postgres.sh --check-only "$F"               # verify only, changes nothing
sudo scripts/backup/restore-postgres.sh --target-db restore_drill "$F"  # restore beside the live DB (drill)
sudo scripts/backup/restore-postgres.sh "$F"                            # replace the live DB (asks for the DB name)
```

Safety chain for a live restore:
1. The `.sha256` checksum must match; a missing checksum is refused.
2. Decryption must succeed (GnuPG integrity check).
3. The archive must be readable, and the plaintext checksum must match `.meta`.
4. The dump is restored into a **scratch database in one transaction**; any error drops it and leaves the live data untouched.
5. Backend and frontend are stopped, sessions are closed, and the databases are swapped with two `RENAME`s. The previous data is **kept** as `<db>_prerestore_<timestamp>`.
6. The apps are started and their health is awaited. The script prints the exact rollback and cleanup commands.

Run a restore drill (`--target-db`) at least monthly, then drop the drill database.

### 7.4 Off-site copies

Copy `/var/backups/shopino` to a second location daily, e.g. `rclone sync` to a bucket in another region or provider. The dumps are already encrypted. This is outside the scripts on purpose, because the destination and credentials are yours.

---

## 8. CI/CD (GitHub Actions)

**`ci.yml`** runs on every pull request and every push to `main`:

| Job | Checks |
|---|---|
| quality | `pnpm lint`, `pnpm typecheck`, backend unit tests, frontend unit tests |
| backend-e2e | PostgreSQL 16 + Redis 7 from `docker-compose.yml`, `prisma migrate deploy`, seed, `verify:seed`, all e2e suites |
| build | `pnpm build` (includes `next build`) |
| docker | builds all four images; checks that the images are non-root; checks that the API refuses sandbox providers in production; boots nginx and checks HSTS |
| infra-lint | shellcheck on every script, validation of `docker-compose.prod.yml` against the env template |

The CI `.env` is generated per run by `scripts/ci/prepare-env.sh`, with random secrets and sandbox providers. There are no secrets in the repository.

**`deploy.yml`** runs on a version tag `vX.Y.Z`, or manually:
1. **Builds and pushes** the images as `<REGISTRY>/{backend,migrator,frontend,nginx}:<sha12>`, plus the version tag.
2. **Deploys** in the GitHub Environment `production`. Add *required reviewers* there so that every deploy needs an approval.
3. Over SSH with a **pinned host key**, it checks out the same commit on the server and runs `deploy/scripts/deploy.sh --tag <sha12>`.

Repository settings:

| Kind | Name | Value |
|---|---|---|
| Variable | `REGISTRY` | e.g. `ghcr.io/<owner>/shopino`, or a registry reachable from Iran |
| Variable | `DEPLOY_PATH` | `/opt/shopino/app` |
| Secret | `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_PORT` | server address, `shopino`, `22` |
| Secret | `DEPLOY_SSH_KEY` | private key of a deploy-only key pair (public half in `~shopino/.ssh/authorized_keys`) |
| Secret | `DEPLOY_KNOWN_HOSTS` | `ssh-keyscan -p 22 <host>`, **checked against the server's real fingerprint** (`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`) |
| Secret | `REGISTRY_USERNAME`, `REGISTRY_PASSWORD` | only for a non-GHCR registry |

**Rollback:** run *Deploy* manually with `image_tag` set to a previous tag. `/opt/shopino/deployments.log` lists every deploy.

**Rollbacks and migrations:**
- Migrations are forward-only.
- Rolling the images back is safe only if no migration was added since that tag.
- Otherwise, restore the pre-deploy backup that `deploy.sh` took (§7.3) together with the old images.

---

## 9. Operations cheat sheet

```bash
cd /opt/shopino/app
export SHOPINO_ENV_FILE=/opt/shopino/.env.production
C="docker compose -f docker-compose.prod.yml --env-file $SHOPINO_ENV_FILE"

$C ps                                    # health of every service
$C logs -f --tail=200 backend            # API logs (JSON access logs: $C logs nginx)
$C restart backend                       # restart one service
$C exec -T postgres psql -U shopino -d shopino -c 'select count(*) from parent_orders'
docker stats --no-stream                 # memory per container
```

| Symptom | Check |
|---|---|
| 502 from nginx | `$C ps`: frontend or backend unhealthy → `$C logs backend` (the environment validation message names the missing key) |
| Browser certificate warning | The certificate has not been issued yet (§5); nginx logs a warning while it serves the placeholder |
| All users rate-limited together | A CDN is in front without `TRUSTED_PROXY_CIDRS` (§2) |
| Images do not load | `S3_PUBLIC_BASE_URL` is wrong, or its origin is missing from `CSP_EXTRA_IMG_SRC`, or the bucket policy does not cover `images/*` |
| Payment returns to an error page | The Zarinpal domain registration must match `SHOPINO_DOMAIN`; `PUBLIC_API_ORIGIN` must be `https://SHOPINO_DOMAIN` |
| OTP not delivered | `$C logs backend \| grep -i kavenegar`, the panel balance, and template approval |

**Rate limits** (per client IP; tune them in `deploy/nginx/nginx.conf`):

| Traffic | Limit |
|---|---|
| Pages | 20 r/s, burst 80 |
| BFF API | 15 r/s, burst 60 |
| Sign-in endpoints (`/api/session/{otp,verify,password}`, `/api/v1/auth/*`) | 10 per minute, burst 10 |
| Uploads | 2 r/s, burst 10 |
| Connections | 60 per IP |

Request bodies are capped at 1 MB, except upload routes (15 MB). The API additionally enforces 5 MB for images and 10 MB for documents, and checks file signatures.

Iranian mobile carriers put many users behind shared (CGNAT) addresses. Watch for 429s in the nginx logs after launch, and raise the limits if real users hit them.
