#!/bin/bash
set -e
F="/opt/shopino/.env.production"
cat << 'ENVEOF' > "$F"
SHOPINO_DOMAIN=shagerdam.ir
SHOPINO_EXTRA_DOMAINS=www.shagerdam.ir
PUBLIC_API_ORIGIN=https://shagerdam.ir
CORS_ORIGINS=https://shagerdam.ir
POSTGRES_PASSWORD=ShopinoPgSecurePass2026
DATABASE_URL="postgresql://shopino:ShopinoPgSecurePass2026@postgres:5432/shopino?schema=public&connection_limit=10&pool_timeout=20"
DIRECT_URL="postgresql://shopino:ShopinoPgSecurePass2026@postgres:5432/shopino?schema=public"
REDIS_PASSWORD=ShopinoRedisSecurePass2026
JWT_ACCESS_SECRET=ShopinoJwtAccessSecretKeyUltraSecure202699
JWT_REFRESH_SECRET=ShopinoJwtRefreshSecretKeyUltraSecure202699
STORAGE_PROVIDER=local
SUPER_ADMIN_PASSWORD=AdminPass123456!
LETSENCRYPT_EMAIL=masihcherik2@gmail.com
SUPER_ADMIN_EMAIL=admin@shagerdam.ir
SUPER_ADMIN_MOBILE=+989120000001
SUPER_ADMIN_FULL_NAME=Manager
SMS_PROVIDER=kavenegar
SMS_KAVENEGAR_API_KEY=LOCAL-KEY-DEMO
SMS_KAVENEGAR_SENDER=1000
SMS_KAVENEGAR_OTP_TEMPLATE=verify
PAYMENT_GATEWAY_PROVIDER=zarinpal
ZARINPAL_MERCHANT_ID=00000000-0000-0000-0000-000000000000
ENVEOF

chmod 600 "$F"
echo "=== CONFIGURATION CREATED ==="
cd /opt/shopino
bash deploy/scripts/deploy.sh --build --seed