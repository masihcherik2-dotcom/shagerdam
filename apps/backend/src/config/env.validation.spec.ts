import type { ConfigService } from '@nestjs/config';
import { validateEnvironment, NodeEnvironment, resolveGoogleRedirectUri, resolveMailProvider } from './env.validation';
import { resolveLogLevels } from './logger.config';
import { buildCorsOptions, parseOriginList } from './cors.config';

const VALID_ENV: Record<string, unknown> = {
  NODE_ENV: 'development',
  PORT: '4000',
  HOST: '0.0.0.0',
  DATABASE_URL: 'postgresql://shopino:secret@127.0.0.1:5432/shopino_db?schema=public',
  DIRECT_URL: 'postgresql://shopino:secret@127.0.0.1:5432/shopino_db?schema=public',
  REDIS_HOST: '127.0.0.1',
  REDIS_PORT: '6379',
  REDIS_PASSWORD: 'redis-secret',
  REDIS_DB: '0',
  CORS_ORIGINS: 'http://localhost:3000',
  LOG_LEVEL: 'debug',
  JWT_ACCESS_SECRET: 'a'.repeat(48),
  JWT_REFRESH_SECRET: 'b'.repeat(48),
  SHIPPING_DEFAULT_FEE_PER_VENDOR: '500000',
  SHIPPING_FREE_THRESHOLD_PER_VENDOR: '10000000',
  PUBLIC_API_ORIGIN: 'http://localhost:4000',
};

const MERCHANT_ID = '1344b5d4-0048-11e8-94db-005056a205be';

describe('validateEnvironment', () => {
  it('requires the shipping fee settings and validates the order lifecycle timings', () => {
    const withoutFee: Record<string, unknown> = { ...VALID_ENV };
    delete withoutFee.SHIPPING_DEFAULT_FEE_PER_VENDOR;
    expect(() => validateEnvironment(withoutFee)).toThrow(/SHIPPING_DEFAULT_FEE_PER_VENDOR/);
    expect(() => validateEnvironment({ ...VALID_ENV, SHIPPING_FREE_THRESHOLD_PER_VENDOR: '-1' })).toThrow(
      /SHIPPING_FREE_THRESHOLD_PER_VENDOR/,
    );
    expect(() => validateEnvironment({ ...VALID_ENV, ORDER_PAYMENT_TIMEOUT_MINUTES: '1' })).toThrow(
      /ORDER_PAYMENT_TIMEOUT_MINUTES/,
    );

    const config = validateEnvironment(VALID_ENV);
    expect(config.SHIPPING_DEFAULT_FEE_PER_VENDOR).toBe(500_000);
    expect(config.SHIPPING_FREE_THRESHOLD_PER_VENDOR).toBe(10_000_000);
    expect(config.ORDER_PAYMENT_TIMEOUT_MINUTES).toBe(30);
    expect(config.ORDER_EXPIRY_SWEEP_INTERVAL_SECONDS).toBe(60);
  });

  it('accepts a complete configuration and coerces numeric values', () => {
    const config = validateEnvironment(VALID_ENV);

    expect(config.NODE_ENV).toBe(NodeEnvironment.Development);
    expect(config.PORT).toBe(4000);
    expect(config.REDIS_PORT).toBe(6379);
    expect(config.REDIS_DB).toBe(0);
  });

  it('rejects a configuration without a database connection string', () => {
    const withoutDatabase: Record<string, unknown> = { ...VALID_ENV };
    delete withoutDatabase.DATABASE_URL;

    expect(() => validateEnvironment(withoutDatabase)).toThrow(/DATABASE_URL/);
  });

  it('rejects a database URL that is not a postgres connection string', () => {
    expect(() => validateEnvironment({ ...VALID_ENV, DATABASE_URL: 'mysql://host/db' })).toThrow(
      /postgresql:\/\//,
    );
  });

  it('rejects an out-of-range port', () => {
    expect(() => validateEnvironment({ ...VALID_ENV, PORT: '70000' })).toThrow(/PORT/);
  });

  it('fails when JWT secrets are missing, in every environment', () => {
    // From Phase 3 on the API signs real tokens, so a missing secret is a service
    // that cannot authenticate anyone — a boot failure, not a warning.
    for (const nodeEnv of ['development', 'test', 'production']) {
      expect(() =>
        validateEnvironment(
          { ...VALID_ENV, NODE_ENV: nodeEnv, JWT_ACCESS_SECRET: '', JWT_REFRESH_SECRET: '   ' },
          { logger: { warn: jest.fn() } },
        ),
      ).toThrow(/Missing required secrets: JWT_ACCESS_SECRET, JWT_REFRESH_SECRET/);
    }
  });

  it('fails when only one of the two secrets is present', () => {
    expect(() =>
      validateEnvironment({ ...VALID_ENV, JWT_REFRESH_SECRET: '' }),
    ).toThrow(/Missing required secrets: JWT_REFRESH_SECRET/);
  });

  it('applies the authentication and OTP defaults', () => {
    const config = validateEnvironment(VALID_ENV);

    expect(config.JWT_ACCESS_TTL).toBe('15m');
    expect(config.JWT_REFRESH_TTL).toBe('7d');
    expect(config.OTP_TTL_SECONDS).toBe(120);
    expect(config.OTP_LENGTH).toBe(5);
    expect(config.OTP_REQUEST_COOLDOWN_SECONDS).toBe(120);
    expect(config.OTP_MAX_VERIFY_ATTEMPTS).toBe(5);
    expect(config.OTP_LOCK_SECONDS).toBe(900);
    expect(config.SMS_PROVIDER).toBe('sandbox');
  });

  it('coerces the numeric OTP policy overrides', () => {
    const config = validateEnvironment({
      ...VALID_ENV,
      OTP_TTL_SECONDS: '180',
      OTP_LENGTH: '6',
      AUTH_MAX_LOGIN_ATTEMPTS: '3',
    });

    expect(config.OTP_TTL_SECONDS).toBe(180);
    expect(config.OTP_LENGTH).toBe(6);
    expect(config.AUTH_MAX_LOGIN_ATTEMPTS).toBe(3);
  });

  it('rejects a JWT lifetime it cannot interpret', () => {
    expect(() => validateEnvironment({ ...VALID_ENV, JWT_ACCESS_TTL: 'fifteen minutes' })).toThrow(
      /JWT_ACCESS_TTL/,
    );
  });

  it('rejects an OTP policy outside the safe bounds', () => {
    expect(() => validateEnvironment({ ...VALID_ENV, OTP_LENGTH: '2' })).toThrow(/OTP_LENGTH/);
    expect(() => validateEnvironment({ ...VALID_ENV, OTP_MAX_VERIFY_ATTEMPTS: '50' })).toThrow(
      /OTP_MAX_VERIFY_ATTEMPTS/,
    );
    expect(() => validateEnvironment({ ...VALID_ENV, OTP_TTL_SECONDS: '5' })).toThrow(/OTP_TTL_SECONDS/);
  });

  it('refuses the sandbox SMS provider in production', () => {
    expect(() =>
      validateEnvironment({ ...VALID_ENV, NODE_ENV: 'production', SMS_PROVIDER: 'sandbox' }),
    ).toThrow(/sandbox cannot be used in production/);
  });

  it('requires the gateway credentials when the real provider is selected', () => {
    expect(() => validateEnvironment({ ...VALID_ENV, SMS_PROVIDER: 'kavenegar' })).toThrow(
      /SMS_PROVIDER=kavenegar requires SMS_KAVENEGAR_API_KEY, SMS_KAVENEGAR_SENDER, SMS_KAVENEGAR_OTP_TEMPLATE/,
    );
  });

  it('accepts the real provider once its credentials are present', () => {
    const config = validateEnvironment({
      ...VALID_ENV,
      SMS_PROVIDER: 'kavenegar',
      SMS_KAVENEGAR_API_KEY: 'a-real-key',
      SMS_KAVENEGAR_SENDER: '10004346',
      SMS_KAVENEGAR_OTP_TEMPLATE: 'shopino-otp',
    });

    expect(config.SMS_PROVIDER).toBe('kavenegar');
  });

  it('rejects an unknown SMS provider name', () => {
    expect(() => validateEnvironment({ ...VALID_ENV, SMS_PROVIDER: 'twilio' })).toThrow(/SMS_PROVIDER/);
  });

  it('rejects JWT secrets that are too short to be safe', () => {
    expect(() => validateEnvironment({ ...VALID_ENV, JWT_ACCESS_SECRET: 'too-short' })).toThrow(
      /at least 32 characters/,
    );
  });

  it('rejects an unsupported log level', () => {
    expect(() => validateEnvironment({ ...VALID_ENV, LOG_LEVEL: 'loud' })).toThrow(/LOG_LEVEL/);
  });

  // ── Phase 4: storage configuration ─────────────────────────────────────────

  it('defaults to the local storage provider with an API-hosted public base URL', () => {
    const config = validateEnvironment(VALID_ENV);

    expect(config.STORAGE_PROVIDER).toBe('local');
    expect(config.STORAGE_LOCAL_ROOT).toBe('uploads');
    expect(config.STORAGE_PUBLIC_BASE_URL).toBe('/api/v1/media/files');
    expect(config.MEDIA_MAX_IMAGE_BYTES).toBe(5_242_880);
    expect(config.MEDIA_MAX_DOCUMENT_BYTES).toBe(10_485_760);
  });

  it('coerces the media size ceilings from the environment', () => {
    const config = validateEnvironment({
      ...VALID_ENV,
      MEDIA_MAX_IMAGE_BYTES: '1048576',
      MEDIA_MAX_DOCUMENT_BYTES: '20971520',
    });

    expect(config.MEDIA_MAX_IMAGE_BYTES).toBe(1_048_576);
    expect(config.MEDIA_MAX_DOCUMENT_BYTES).toBe(20_971_520);
  });

  it('rejects an unknown storage provider and an absurd size ceiling', () => {
    expect(() => validateEnvironment({ ...VALID_ENV, STORAGE_PROVIDER: 'ftp' })).toThrow(
      /STORAGE_PROVIDER must be one of: local, s3/,
    );
    expect(() => validateEnvironment({ ...VALID_ENV, MEDIA_MAX_IMAGE_BYTES: '10' })).toThrow(
      /MEDIA_MAX_IMAGE_BYTES/,
    );
  });

  it('refuses to boot with s3 selected while the bucket or keys are missing', () => {
    expect(() =>
      validateEnvironment({ ...VALID_ENV, STORAGE_PROVIDER: 's3' }, { logger: { warn: jest.fn() } }),
    ).toThrow(/STORAGE_PROVIDER=s3 requires S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY/);
  });

  it('accepts s3 once the bucket and keys are present', () => {
    const config = validateEnvironment(
      {
        ...VALID_ENV,
        STORAGE_PROVIDER: 's3',
        S3_BUCKET: 'shopino-media',
        S3_ACCESS_KEY_ID: 'AKIAEXAMPLE',
        S3_SECRET_ACCESS_KEY: 'secret-value',
        S3_ENDPOINT: 'https://s3.ir-thr-at1.arvanstorage.ir',
      },
      { logger: { warn: jest.fn() } },
    );

    expect(config.STORAGE_PROVIDER).toBe('s3');
    expect(config.S3_BUCKET).toBe('shopino-media');
    expect(config.S3_FORCE_PATH_STYLE).toBe(true);
  });

  it('parses boolean flags instead of letting every non-empty string be truthy', () => {
    // `Boolean('false')` is `true`: this is the exact regression the explicit
    // transform exists to prevent, so both directions are asserted.
    const off = validateEnvironment({
      ...VALID_ENV,
      SMS_SANDBOX_LOG_CODES: 'false',
      S3_FORCE_PATH_STYLE: 'false',
    });
    expect(off.SMS_SANDBOX_LOG_CODES).toBe(false);
    expect(off.S3_FORCE_PATH_STYLE).toBe(false);

    const on = validateEnvironment({
      ...VALID_ENV,
      SMS_SANDBOX_LOG_CODES: 'true',
      S3_FORCE_PATH_STYLE: '1',
    });
    expect(on.SMS_SANDBOX_LOG_CODES).toBe(true);
    expect(on.S3_FORCE_PATH_STYLE).toBe(true);

    expect(() => validateEnvironment({ ...VALID_ENV, S3_FORCE_PATH_STYLE: 'maybe' })).toThrow(
      /S3_FORCE_PATH_STYLE/,
    );
  });
});

describe('validateEnvironment — payment gateway', () => {
  it('defaults to the sandbox gateway in development and says so in the log', () => {
    const warn = jest.fn();
    const config = validateEnvironment(VALID_ENV, { logger: { warn } });
    expect(config.PAYMENT_GATEWAY_PROVIDER).toBe('sandbox');
    expect(config.PAYMENT_CALLBACK_GRACE_MINUTES).toBe(20);
    expect(config.ZARINPAL_API_BASE_URL).toBe('https://payment.zarinpal.com');
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/PAYMENT_GATEWAY_PROVIDER=sandbox/));
  });

  it('requires an absolute public API origin without a path', () => {
    const without: Record<string, unknown> = { ...VALID_ENV };
    delete without.PUBLIC_API_ORIGIN;
    expect(() => validateEnvironment(without)).toThrow(/PUBLIC_API_ORIGIN/);
    expect(() => validateEnvironment({ ...VALID_ENV, PUBLIC_API_ORIGIN: 'https://api.shopino.ir/api/v1' })).toThrow(/PUBLIC_API_ORIGIN/);
    expect(() => validateEnvironment({ ...VALID_ENV, PUBLIC_API_ORIGIN: 'api.shopino.ir' })).toThrow(/PUBLIC_API_ORIGIN/);
  });

  it('refuses the sandbox gateway in production', () => {
    const production = { ...VALID_ENV, NODE_ENV: 'production', SMS_PROVIDER: 'kavenegar', SMS_KAVENEGAR_API_KEY: 'k', SMS_KAVENEGAR_SENDER: 's', SMS_KAVENEGAR_OTP_TEMPLATE: 't' };
    expect(() => validateEnvironment({ ...production, PAYMENT_GATEWAY_PROVIDER: 'sandbox' }, { logger: { warn: jest.fn() } })).toThrow(
      /PAYMENT_GATEWAY_PROVIDER=sandbox cannot be used in production/,
    );
    const config = validateEnvironment({ ...production, PAYMENT_GATEWAY_PROVIDER: 'zarinpal', ZARINPAL_MERCHANT_ID: MERCHANT_ID }, { logger: { warn: jest.fn() } });
    expect(config.PAYMENT_GATEWAY_PROVIDER).toBe('zarinpal');
  });

  it('requires a well-formed merchant id for zarinpal, and treats a blank one as missing', () => {
    expect(() => validateEnvironment({ ...VALID_ENV, PAYMENT_GATEWAY_PROVIDER: 'zarinpal' })).toThrow(/requires ZARINPAL_MERCHANT_ID/);
    expect(() => validateEnvironment({ ...VALID_ENV, PAYMENT_GATEWAY_PROVIDER: 'zarinpal', ZARINPAL_MERCHANT_ID: '  ' })).toThrow(/requires ZARINPAL_MERCHANT_ID/);
    expect(() => validateEnvironment({ ...VALID_ENV, PAYMENT_GATEWAY_PROVIDER: 'zarinpal', ZARINPAL_MERCHANT_ID: 'short' })).toThrow(/ZARINPAL_MERCHANT_ID must be/);
    expect(() => validateEnvironment({ ...VALID_ENV, PAYMENT_GATEWAY_PROVIDER: 'zarinpal', ZARINPAL_MERCHANT_ID: MERCHANT_ID, ZARINPAL_API_BASE_URL: 'http://payment.zarinpal.com' })).toThrow(
      /ZARINPAL_API_BASE_URL/,
    );
  });

  it('rejects an unknown gateway and an invalid result redirect', () => {
    expect(() => validateEnvironment({ ...VALID_ENV, PAYMENT_GATEWAY_PROVIDER: 'mellat' })).toThrow(/PAYMENT_GATEWAY_PROVIDER must be one of/);
    expect(() => validateEnvironment({ ...VALID_ENV, PAYMENT_RESULT_REDIRECT_URL: 'javascript:alert(1)' })).toThrow(/PAYMENT_RESULT_REDIRECT_URL/);
    const config = validateEnvironment({ ...VALID_ENV, PAYMENT_RESULT_REDIRECT_URL: '/checkout/result' }, { logger: { warn: jest.fn() } });
    expect(config.PAYMENT_RESULT_REDIRECT_URL).toBe('/checkout/result');
  });
});

describe('resolveLogLevels', () => {
  it('enables the requested level and everything more severe', () => {
    expect(resolveLogLevels('error')).toEqual(['error']);
    expect(resolveLogLevels('warn')).toEqual(['error', 'warn']);
    expect(resolveLogLevels('debug')).toEqual(['error', 'warn', 'log', 'debug']);
    expect(resolveLogLevels('verbose')).toEqual(['error', 'warn', 'log', 'debug', 'verbose']);
  });
});

describe('buildCorsOptions', () => {
  const createConfigService = (values: Record<string, unknown>): ConfigService =>
    ({ get: (key: string) => values[key] }) as unknown as ConfigService;

  const isAllowed = (options: ReturnType<typeof buildCorsOptions>, origin: string): boolean => {
    const originOption = options.origin;
    if (typeof originOption !== 'function') {
      throw new Error('CORS origin option must be a callback function');
    }

    let allowed = false;
    originOption(origin, (_error: Error | null, result?: unknown) => {
      allowed = result === true;
    });
    return allowed;
  };

  it('allows configured origins in production and refuses unknown ones', () => {
    const options = buildCorsOptions(
      createConfigService({ NODE_ENV: 'production', CORS_ORIGINS: 'https://shopino.ir' }),
    );

    expect(isAllowed(options, 'https://shopino.ir')).toBe(true);
    expect(isAllowed(options, 'https://evil.example')).toBe(false);
  });

  it('allows local origins in development even when CORS_ORIGINS is empty', () => {
    const options = buildCorsOptions(createConfigService({ NODE_ENV: 'development', CORS_ORIGINS: '' }));

    expect(isAllowed(options, 'http://localhost:3000')).toBe(true);
    expect(isAllowed(options, 'https://3000-abc123.e2b.app')).toBe(true);
    expect(isAllowed(options, 'https://evil.example')).toBe(false);
  });

  it('parses a comma separated allow-list and ignores blank entries', () => {
    expect(parseOriginList(' https://a.example , ,https://b.example ')).toEqual([
      'https://a.example',
      'https://b.example',
    ]);
  });
});

describe('Google sign-in configuration', () => {
  const CLIENT = { GOOGLE_CLIENT_ID: '1234-abc.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'GOCSPX-test-secret-value' };

  it('is off when both keys are blank, and the redirect URI defaults to the storefront session endpoint', () => {
    const config = validateEnvironment({ ...VALID_ENV, GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: ' ' });
    expect(config.GOOGLE_CLIENT_ID).toBeUndefined();
    expect(resolveGoogleRedirectUri(config)).toBe('http://localhost:4000/api/session/google/callback');
    expect(resolveGoogleRedirectUri(validateEnvironment({ ...VALID_ENV, PUBLIC_WEB_ORIGIN: 'https://shagerdam.ir' }))).toBe('https://shagerdam.ir/api/session/google/callback');
  });

  it('accepts a complete client and an explicit redirect URI', () => {
    const config = validateEnvironment({ ...VALID_ENV, ...CLIENT, GOOGLE_REDIRECT_URI: 'https://shop.example/api/session/google/callback' });
    expect(config.GOOGLE_CLIENT_ID).toBe(CLIENT.GOOGLE_CLIENT_ID);
    expect(resolveGoogleRedirectUri(config)).toBe('https://shop.example/api/session/google/callback');
  });

  it('refuses half a client, a malformed client id and plain-http redirects in production', () => {
    expect(() => validateEnvironment({ ...VALID_ENV, GOOGLE_CLIENT_ID: CLIENT.GOOGLE_CLIENT_ID })).toThrow(/missing GOOGLE_CLIENT_SECRET/);
    expect(() => validateEnvironment({ ...VALID_ENV, GOOGLE_CLIENT_SECRET: CLIENT.GOOGLE_CLIENT_SECRET })).toThrow(/missing GOOGLE_CLIENT_ID/);
    expect(() => validateEnvironment({ ...VALID_ENV, ...CLIENT, GOOGLE_CLIENT_ID: 'not-a-client' })).toThrow(/GOOGLE_CLIENT_ID must be/);
    const production = { ...VALID_ENV, NODE_ENV: 'production', SMS_PROVIDER: 'kavenegar', SMS_KAVENEGAR_API_KEY: 'k', SMS_KAVENEGAR_SENDER: 's', SMS_KAVENEGAR_OTP_TEMPLATE: 't', PAYMENT_GATEWAY_PROVIDER: 'zarinpal', ZARINPAL_MERCHANT_ID: MERCHANT_ID, ...CLIENT };
    expect(() => validateEnvironment(production)).toThrow(/https redirect URI/);
    expect(() => validateEnvironment({ ...production, PUBLIC_WEB_ORIGIN: 'https://shagerdam.ir' })).not.toThrow();
  });
});

describe('e-mail (SMTP) configuration', () => {
  const PRODUCTION = { ...VALID_ENV, NODE_ENV: 'production', SMS_PROVIDER: 'kavenegar', SMS_KAVENEGAR_API_KEY: 'k', SMS_KAVENEGAR_SENDER: 's', SMS_KAVENEGAR_OTP_TEMPLATE: 't', PAYMENT_GATEWAY_PROVIDER: 'zarinpal', ZARINPAL_MERCHANT_ID: MERCHANT_ID };
  const SMTP = { MAIL_PROVIDER: 'smtp', SMTP_HOST: 'smtp.gmail.com', SMTP_USER: 'shop@gmail.com', SMTP_PASS: 'abcd efgh ijkl mnop', SMTP_FROM: 'شاگردم <shop@gmail.com>' };

  it('defaults to sandbox in development and to off in production, so existing deployments keep booting', () => {
    const dev = validateEnvironment(VALID_ENV);
    expect(resolveMailProvider(dev)).toBe('sandbox');
    expect(dev.SMTP_PORT).toBe(587);
    expect(dev.SMTP_SECURE).toBe(false);
    expect(resolveMailProvider(validateEnvironment({ ...PRODUCTION, MAIL_PROVIDER: '' }))).toBe('none');
  });

  it('refuses the sandbox in production', () => {
    expect(() => validateEnvironment({ ...PRODUCTION, MAIL_PROVIDER: 'sandbox' })).toThrow(/MAIL_PROVIDER=sandbox cannot be used in production/);
  });

  it('accepts a complete Gmail SMTP setup in production', () => {
    const config = validateEnvironment({ ...PRODUCTION, ...SMTP, SMTP_PORT: '587', SMTP_SECURE: 'false' });
    expect(resolveMailProvider(config)).toBe('smtp');
    expect(config.SMTP_FROM).toBe('شاگردم <shop@gmail.com>');
  });

  it('needs a host and a sender, and the login as a pair', () => {
    expect(() => validateEnvironment({ ...VALID_ENV, ...SMTP, SMTP_HOST: '' })).toThrow(/requires SMTP_HOST/);
    expect(() => validateEnvironment({ ...VALID_ENV, ...SMTP, SMTP_FROM: '' })).toThrow(/requires SMTP_FROM/);
    expect(() => validateEnvironment({ ...VALID_ENV, ...SMTP, SMTP_PASS: '' })).toThrow(/missing SMTP_PASS/);
    expect(() => validateEnvironment({ ...VALID_ENV, ...SMTP, SMTP_USER: undefined })).toThrow(/missing SMTP_USER/);
    expect(() => validateEnvironment({ ...VALID_ENV, ...SMTP, SMTP_USER: '', SMTP_PASS: '' })).not.toThrow();
  });

  it('rejects malformed hosts, senders and providers', () => {
    expect(() => validateEnvironment({ ...VALID_ENV, ...SMTP, SMTP_HOST: 'https://smtp.gmail.com' })).toThrow(/SMTP_HOST must be/);
    expect(() => validateEnvironment({ ...VALID_ENV, ...SMTP, SMTP_FROM: 'not an address' })).toThrow(/SMTP_FROM must be/);
    expect(() => validateEnvironment({ ...VALID_ENV, ...SMTP, SMTP_FROM: 'Shop <a@b.com>\r\nBcc: x@y.com' })).toThrow(/SMTP_FROM must be/);
    expect(() => validateEnvironment({ ...VALID_ENV, MAIL_PROVIDER: 'sendgrid' })).toThrow(/MAIL_PROVIDER must be one of/);
    expect(() => validateEnvironment({ ...VALID_ENV, SMTP_PORT: '0' })).toThrow(/SMTP_PORT/);
    expect(validateEnvironment({ ...VALID_ENV, ...SMTP, SMTP_FROM: 'noreply@shagerdam.ir' }).SMTP_FROM).toBe('noreply@shagerdam.ir');
  });

  it('warns about the classic port / TLS mismatches', () => {
    const warn = jest.fn();
    validateEnvironment({ ...VALID_ENV, ...SMTP, SMTP_PORT: '465', SMTP_SECURE: 'false' }, { logger: { warn } });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/SMTP_PORT=465/));
  });
});
