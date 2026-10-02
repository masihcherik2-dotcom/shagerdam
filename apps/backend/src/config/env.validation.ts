import { Logger } from '@nestjs/common';
import { plainToInstance, Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  MinLength,
  validateSync,
  type ValidationError,
} from 'class-validator';

export enum NodeEnvironment {
  Development = 'development',
  Test = 'test',
  Production = 'production',
}

/** Values accepted by `LOG_LEVEL`, ordered from most to least severe. */
export const LOG_LEVELS = ['error', 'warn', 'log', 'debug', 'verbose'] as const;
export type LogLevelName = (typeof LOG_LEVELS)[number];

/** JWT secrets shorter than this are considered unusable. */
export const MIN_SECRET_LENGTH = 32;

/** SMS providers the API can be configured with. */
export const SMS_PROVIDERS = ['sandbox', 'kavenegar'] as const;
export type SmsProviderName = (typeof SMS_PROVIDERS)[number];

/** Card-payment (IPG) gateways the API can be configured with. */
export const PAYMENT_GATEWAY_PROVIDERS = ['sandbox', 'zarinpal'] as const;
/** Unit of the prices in the Torob feed: IRR = Rial (the platform currency), IRT = Toman (Rial ÷ 10). */
export const TOROB_PRICE_UNITS = ['IRR', 'IRT'] as const;
export type TorobPriceUnit = (typeof TOROB_PRICE_UNITS)[number];
export type PaymentGatewayProviderName = (typeof PAYMENT_GATEWAY_PROVIDERS)[number];

/** Storage backends the API can be configured with. */
export const STORAGE_PROVIDERS = ['local', 's3'] as const;
export type StorageProviderName = (typeof STORAGE_PROVIDERS)[number];

const POSTGRES_URL_PATTERN = /^postgres(ql)?:\/\/\S+$/;

/** JWT lifetimes accept the `@nestjs/jwt` shorthand, e.g. `15m`, `7d`, `12h`. */
const DURATION_PATTERN = /^[1-9][0-9]*[smhd]$/;

const SECRET_KEYS = ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'] as const;
const OPTIONAL_KEYS: readonly string[] = [
  ...SECRET_KEYS,
  'CORS_ORIGINS',
  'LOG_LEVEL',
  'SMS_KAVENEGAR_API_KEY',
  'SMS_KAVENEGAR_SENDER',
  'SMS_KAVENEGAR_OTP_TEMPLATE',
  // S3 settings are blank in `.env` while STORAGE_PROVIDER=local; treating those
  // blanks as "not set" is what keeps the local provider bootable. When
  // STORAGE_PROVIDER=s3 they become mandatory, which `assertStorageConfiguration`
  // enforces with a message that names exactly what is missing.
  'S3_ENDPOINT',
  'S3_BUCKET',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
  'S3_PUBLIC_BASE_URL',
  'ZARINPAL_MERCHANT_ID',
  'PAYMENT_RESULT_REDIRECT_URL',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_REDIRECT_URI',
];

/** Shape of the validated configuration object exposed through `ConfigService`. */
export class EnvironmentVariables {
  @IsEnum(NodeEnvironment)
  NODE_ENV: NodeEnvironment = NodeEnvironment.Development;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65_535)
  PORT: number = 4000;

  @IsString()
  @MinLength(1)
  HOST: string = '0.0.0.0';

  @IsString()
  @Matches(POSTGRES_URL_PATTERN, {
    message: 'DATABASE_URL must be a postgresql:// connection string',
  })
  DATABASE_URL!: string;

  @IsString()
  @Matches(POSTGRES_URL_PATTERN, {
    message: 'DIRECT_URL must be a postgresql:// connection string',
  })
  DIRECT_URL!: string;

  @IsString()
  @MinLength(1)
  REDIS_HOST!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65_535)
  REDIS_PORT!: number;

  @IsString()
  @MinLength(1)
  REDIS_PASSWORD!: string;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(15)
  REDIS_DB: number = 0;

  @IsOptional()
  @IsString()
  CORS_ORIGINS?: string;

  // ─── Authentication ───────────────────────────────────────────────────────
  // Mandatory from Phase 3 on: the API signs real tokens, so a missing secret is
  // no longer a warning, it is a service that cannot authenticate anyone.
  //
  // `@IsOptional()` here is about *message quality*, not leniency: a blank value
  // is normalized to "not set" and reported by `assertSecrets` with the exact
  // command to generate one. The boot still fails — see the unit tests.
  @IsOptional()
  @IsString()
  @MinLength(MIN_SECRET_LENGTH, {
    message: `JWT_ACCESS_SECRET must be at least ${MIN_SECRET_LENGTH} characters`,
  })
  JWT_ACCESS_SECRET?: string;

  @IsOptional()
  @IsString()
  @MinLength(MIN_SECRET_LENGTH, {
    message: `JWT_REFRESH_SECRET must be at least ${MIN_SECRET_LENGTH} characters`,
  })
  JWT_REFRESH_SECRET?: string;

  /** Access-token lifetime. Short by design; refresh tokens carry the session. */
  @IsString()
  @Matches(DURATION_PATTERN, { message: 'JWT_ACCESS_TTL must look like 15m, 1h or 7d' })
  JWT_ACCESS_TTL: string = '15m';

  /** Refresh-token lifetime. Persistent session length. */
  @IsString()
  @Matches(DURATION_PATTERN, { message: 'JWT_REFRESH_TTL must look like 15m, 1h or 7d' })
  JWT_REFRESH_TTL: string = '7d';

  // ─── OTP policy ───────────────────────────────────────────────────────────
  /** Validity of a generated code. */
  @Type(() => Number)
  @IsInt()
  @Min(60)
  @Max(600)
  OTP_TTL_SECONDS: number = 120;

  /** Digits in the generated code (cryptographically secure, never sequential). */
  @Type(() => Number)
  @IsInt()
  @Min(4)
  @Max(8)
  OTP_LENGTH: number = 5;

  /** Minimum delay between two OTP requests for the same mobile number. */
  @Type(() => Number)
  @IsInt()
  @Min(30)
  @Max(600)
  OTP_REQUEST_COOLDOWN_SECONDS: number = 120;

  /** Wrong codes tolerated per mobile number before the account is locked. */
  @Type(() => Number)
  @IsInt()
  @Min(3)
  @Max(10)
  OTP_MAX_VERIFY_ATTEMPTS: number = 5;

  /** How long a number stays locked after exceeding the attempt budget. */
  @Type(() => Number)
  @IsInt()
  @Min(60)
  @Max(86_400)
  OTP_LOCK_SECONDS: number = 900;

  /** Ceiling per mobile number per hour, independent of the cooldown. */
  @Type(() => Number)
  @IsInt()
  @Min(3)
  @Max(100)
  OTP_MAX_REQUESTS_PER_HOUR: number = 5;

  /** Ceiling per client IP per hour; stops distributed enumeration of numbers. */
  @Type(() => Number)
  @IsInt()
  @Min(5)
  @Max(500)
  OTP_MAX_REQUESTS_PER_IP_PER_HOUR: number = 20;

  // ─── Password login policy ────────────────────────────────────────────────
  @Type(() => Number)
  @IsInt()
  @Min(3)
  @Max(20)
  AUTH_MAX_LOGIN_ATTEMPTS: number = 5;

  @Type(() => Number)
  @IsInt()
  @Min(60)
  @Max(86_400)
  AUTH_LOCK_SECONDS: number = 900;

  // ─── SMS provider ─────────────────────────────────────────────────────────
  @IsIn(SMS_PROVIDERS, { message: `SMS_PROVIDER must be one of: ${SMS_PROVIDERS.join(', ')}` })
  SMS_PROVIDER: SmsProviderName = 'sandbox';

  /** Prints OTP codes to the log. Only meaningful for the sandbox provider. */
  @Transform(toBoolean)
  @IsBoolean()
  SMS_SANDBOX_LOG_CODES: boolean = true;

  @IsOptional()
  @IsString()
  @MinLength(1)
  SMS_KAVENEGAR_API_KEY?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  SMS_KAVENEGAR_SENDER?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  SMS_KAVENEGAR_OTP_TEMPLATE?: string;

  // ─── File storage ─────────────────────────────────────────────────────────
  /**
   * `local` writes to {@link STORAGE_LOCAL_ROOT} and serves the files through the
   * API; `s3` talks to any S3-compatible object store (AWS, ArvanCloud, Liara,
   * MinIO). Selected once at boot by `StorageModule`.
   */
  @IsIn(STORAGE_PROVIDERS, { message: `STORAGE_PROVIDER must be one of: ${STORAGE_PROVIDERS.join(', ')}` })
  STORAGE_PROVIDER: StorageProviderName = 'local';

  /** Uploads root for the local provider. Relative paths resolve from the app cwd. */
  @IsString()
  @MinLength(1)
  STORAGE_LOCAL_ROOT: string = 'uploads';

  /**
   * Base URL the stored objects are published under. The default points at the
   * API's own file route, so a fresh checkout serves uploads without any extra
   * configuration; set it to a CDN origin in production.
   */
  @IsString()
  @MinLength(1)
  STORAGE_PUBLIC_BASE_URL: string = '/api/v1/media/files';

  @IsOptional()
  @IsString()
  @MinLength(1)
  S3_ENDPOINT?: string;

  @IsString()
  @MinLength(1)
  S3_REGION: string = 'ir-thr-at1';

  @IsOptional()
  @IsString()
  @MinLength(1)
  S3_BUCKET?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  S3_ACCESS_KEY_ID?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  S3_SECRET_ACCESS_KEY?: string;

  /**
   * Path-style addressing (`endpoint/bucket/key`). Required by ArvanCloud and
   * Liara with a custom endpoint; AWS deprecated it, hence the `false` default.
   */
  @Transform(toBoolean)
  @IsBoolean()
  S3_FORCE_PATH_STYLE: boolean = true;

  /** CDN or custom domain in front of the bucket; falls back to endpoint/bucket. */
  @IsOptional()
  @IsString()
  @MinLength(1)
  S3_PUBLIC_BASE_URL?: string;

  // ─── Media limits ─────────────────────────────────────────────────────────
  /** Ceiling for an uploaded image (default 5 MiB). */
  @Type(() => Number)
  @IsInt()
  @Min(64 * 1024)
  @Max(50 * 1024 * 1024)
  MEDIA_MAX_IMAGE_BYTES: number = 5_242_880;

  /** Ceiling for an uploaded document (default 10 MiB). */
  @Type(() => Number)
  @IsInt()
  @Min(64 * 1024)
  @Max(100 * 1024 * 1024)
  MEDIA_MAX_DOCUMENT_BYTES: number = 10_485_760;

  // ─── Commerce: shipping and order lifecycle ────────────────────────────────
  /**
   * Platform default shipping fee per store package, in the platform currency
   * (`platform.currency`, IRR). Fallback when the `system_configs` key
   * `shipping.default_fee_per_vendor` is absent. Required: the fee is a business
   * value and has no code default.
   */
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  SHIPPING_DEFAULT_FEE_PER_VENDOR!: number;

  /**
   * Store-package subtotal at which shipping becomes free (platform currency);
   * `0` disables free shipping. Fallback for `shipping.free_threshold_per_vendor`.
   */
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  SHIPPING_FREE_THRESHOLD_PER_VENDOR!: number;

  /** Minutes an unpaid order keeps its stock reservation before it is cancelled. */
  @Type(() => Number)
  @IsInt()
  @Min(5)
  @Max(24 * 60)
  ORDER_PAYMENT_TIMEOUT_MINUTES: number = 30;

  /** How often the expiry sweeper runs, in seconds; `0` disables it on this instance. */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(3600)
  ORDER_EXPIRY_SWEEP_INTERVAL_SECONDS: number = 60;

  /**
   * How often PENDING instalments whose due date has passed are marked OVERDUE
   * (seconds; 0 disables the timer, e.g. when a dedicated worker runs it).
   */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(86_400)
  INSTALLMENT_OVERDUE_SWEEP_INTERVAL_SECONDS: number = 3600;

  /**
   * Absolute origin the *customer's browser* and the bank reach this API on
   * (scheme + host [+ port], no path). Used to build the gateway callback URL
   * and the sandbox bank page URL.
   */
  @Matches(/^https?:\/\/[^/\s]+$/, { message: 'PUBLIC_API_ORIGIN must be an absolute origin such as https://api.example.com (no path, no trailing slash)' })
  PUBLIC_API_ORIGIN!: string;

  /**
   * Absolute origin of the storefront (scheme + host [+ port], no path), used for
   * canonical product links published to third parties (Torob `page_url`).
   * Optional: defaults to PUBLIC_API_ORIGIN, which is the same origin in the
   * single-domain deployment (nginx serves the storefront and the API together).
   */
  @IsOptional()
  @Matches(/^https?:\/\/[^/\s]+$/, { message: 'PUBLIC_WEB_ORIGIN must be an absolute origin such as https://shagerdam.ir (no path, no trailing slash)' })
  PUBLIC_WEB_ORIGIN?: string;

  // ─── Sign-in with Google (OAuth 2.0 / OpenID Connect) ─────────────────────
  /**
   * OAuth client of the Google Cloud project ("Web application" type). Both
   * blank → Google sign-in is switched off and the storefront hides its button;
   * one without the other is a configuration error.
   */
  @IsOptional()
  @IsString()
  @Matches(/^[0-9A-Za-z._-]+\.apps\.googleusercontent\.com$/, { message: 'GOOGLE_CLIENT_ID must be an OAuth client id such as 1234-abc.apps.googleusercontent.com' })
  GOOGLE_CLIENT_ID?: string;

  @IsOptional()
  @IsString()
  @MinLength(10)
  GOOGLE_CLIENT_SECRET?: string;

  /**
   * Redirect URI registered for the client in Google Cloud Console. Optional:
   * defaults to `<PUBLIC_WEB_ORIGIN or PUBLIC_API_ORIGIN>/api/session/google/callback`
   * (the storefront's session endpoint, which completes the sign-in).
   */
  @IsOptional()
  @Matches(/^https?:\/\/[^/\s]+\/\S*$/, { message: 'GOOGLE_REDIRECT_URI must be an absolute URL such as https://shagerdam.ir/api/session/google/callback' })
  GOOGLE_REDIRECT_URI?: string;

  // ─── Integrations: Torob ───────────────────────────────────────────────────
  /** Redis TTL of a cached Torob feed page, in seconds; `0` disables the cache. Mutations invalidate earlier. */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(3600)
  TOROB_FEED_CACHE_TTL_SECONDS: number = 300;

  /** Price unit of the Torob feed. The platform stores Rial; IRT publishes Toman (Rial ÷ 10, rounded). */
  @IsIn(TOROB_PRICE_UNITS, { message: `TOROB_PRICE_UNIT must be one of: ${TOROB_PRICE_UNITS.join(', ')}` })
  TOROB_PRICE_UNIT: TorobPriceUnit = 'IRR';

  @IsIn(PAYMENT_GATEWAY_PROVIDERS, { message: `PAYMENT_GATEWAY_PROVIDER must be one of: ${PAYMENT_GATEWAY_PROVIDERS.join(', ')}` })
  PAYMENT_GATEWAY_PROVIDER: PaymentGatewayProviderName = 'sandbox';

  /** Zarinpal merchant id (36-character UUID). Required when PAYMENT_GATEWAY_PROVIDER=zarinpal. */
  @IsOptional()
  @Matches(/^[0-9a-fA-F-]{36}$/, { message: 'ZARINPAL_MERCHANT_ID must be the 36-character merchant id issued by Zarinpal' })
  ZARINPAL_MERCHANT_ID?: string;

  /** Zarinpal host: https://payment.zarinpal.com (live) or https://sandbox.zarinpal.com (Zarinpal's own test host). */
  @Matches(/^https:\/\/[^/\s]+$/, { message: 'ZARINPAL_API_BASE_URL must be an https origin without a path' })
  ZARINPAL_API_BASE_URL: string = 'https://payment.zarinpal.com';

  /** Timeout of one call to the gateway API, in milliseconds. */
  @Type(() => Number)
  @IsInt()
  @Min(1000)
  @Max(60_000)
  PAYMENT_GATEWAY_TIMEOUT_MS: number = 15_000;

  /**
   * Optional frontend page the payment callback redirects the browser to
   * (`?orderNumber=…&status=…`). When unset the callback answers with JSON.
   */
  @IsOptional()
  @Matches(/^(https?:\/\/\S+|\/\S*)$/, { message: 'PAYMENT_RESULT_REDIRECT_URL must be an absolute URL or a path starting with /' })
  PAYMENT_RESULT_REDIRECT_URL?: string;

  /**
   * Minutes after which an INITIATED payment no longer protects its order from
   * the expiry sweeper (the customer is assumed to have abandoned the bank page).
   */
  @Type(() => Number)
  @IsInt()
  @Min(5)
  @Max(120)
  PAYMENT_CALLBACK_GRACE_MINUTES: number = 20;

  @IsOptional()
  @IsIn(LOG_LEVELS, { message: `LOG_LEVEL must be one of: ${LOG_LEVELS.join(', ')}` })
  LOG_LEVEL?: LogLevelName;
}

export interface EnvironmentValidationOptions {
  /** Injected in tests; defaults to a Nest logger scoped to this module. */
  logger?: Pick<Logger, 'warn'>;
}

/**
 * Validates the raw process environment (and `.env` contents) for
 * `ConfigModule.forRoot({ validate })`.
 *
 * Structural problems always fail the boot, and so does anything that would
 * silently degrade security: missing JWT secrets, an SMS provider that cannot
 * deliver, or a test provider in production.
 */
export function validateEnvironment(
  raw: Record<string, unknown>,
  options: EnvironmentValidationOptions = {},
): EnvironmentVariables {
  const logger = options.logger ?? new Logger('EnvironmentValidation');
  const config = plainToInstance(EnvironmentVariables, normalizeEmptyValues(raw));
  const errors = validateSync(config, { forbidUnknownValues: false, whitelist: false });

  if (errors.length > 0) {
    throw new Error(`Invalid environment configuration:\n${formatValidationErrors(errors)}`);
  }

  assertSecrets(config);
  assertSmsConfiguration(config, logger);
  assertStorageConfiguration(config, logger);
  assertPaymentConfiguration(config, logger);
  assertGoogleConfiguration(config);
  return config;
}

/**
 * Parses a boolean environment variable.
 *
 * `@Type(() => Boolean)` is wrong for this job: `Boolean('false')` is `true`, so
 * `SMS_SANDBOX_LOG_CODES=false` would silently turn logging *on*. Every value the
 * dotenv file can contain is handled explicitly, and anything unrecognized is
 * passed through so `@IsBoolean()` rejects it with a clear message instead of
 * guessing.
 */
function toBoolean({ value }: { value: unknown }): unknown {
  if (typeof value === 'boolean' || value === undefined || value === null) {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) {
      return true;
    }
    if (['false', '0', 'no', 'off', ''].includes(normalized)) {
      return false;
    }
  }
  return value;
}

/** Treats blank values (`KEY=`) as "not set" so optional keys stay optional. */
function normalizeEmptyValues(raw: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = { ...raw };
  for (const key of OPTIONAL_KEYS) {
    const value = normalized[key];
    if (typeof value === 'string' && value.trim() === '') {
      delete normalized[key];
    }
  }
  return normalized;
}

/**
 * Secrets are required in every environment from Phase 3 on. Development still
 * gets its values from `.env` (generated with `openssl rand -base64 48`), so the
 * absence of one means a broken checkout, and a broken checkout must not boot
 * with an API that silently cannot authenticate anyone.
 */
function assertSecrets(config: EnvironmentVariables): void {
  const missing = SECRET_KEYS.filter((key) => {
    const value = config[key];
    return typeof value !== 'string' || value.length === 0;
  });
  if (missing.length > 0) {
    throw new Error(
      `Missing required secrets: ${missing.join(', ')}. ` +
        'Generate values with "openssl rand -base64 48" and add them to .env (never commit them).',
    );
  }
}

/** Cross-field checks that a per-property validator cannot express. */
function assertSmsConfiguration(config: EnvironmentVariables, logger: Pick<Logger, 'warn'>): void {
  if (config.SMS_PROVIDER === 'kavenegar') {
    const required = [
      'SMS_KAVENEGAR_API_KEY',
      'SMS_KAVENEGAR_SENDER',
      'SMS_KAVENEGAR_OTP_TEMPLATE',
    ] as const;
    const missing = required.filter((key) => {
      const value = config[key];
      return typeof value !== 'string' || value.trim() === '';
    });

    if (missing.length > 0) {
      throw new Error(
        `SMS_PROVIDER=kavenegar requires ${missing.join(', ')}. ` +
          'Provide the real gateway credentials, or use SMS_PROVIDER=sandbox in development.',
      );
    }
    return;
  }

  if (config.NODE_ENV === NodeEnvironment.Production) {
    throw new Error(
      'SMS_PROVIDER=sandbox cannot be used in production: it logs codes instead of delivering them. ' +
        'Configure SMS_PROVIDER=kavenegar with real credentials.',
    );
  }

  if (config.SMS_SANDBOX_LOG_CODES) {
    logger.warn(
      'SMS_PROVIDER=sandbox — OTP codes are written to the application log and not delivered by SMS. ' +
        'This is a development/test provider only.',
    );
  }
}

/**
 * Cross-field checks for the storage configuration.
 *
 * `s3` without credentials must fail at boot: discovering it at the first upload
 * would mean a vendor submits KYC documents and gets a 503 they cannot act on.
 */
function assertStorageConfiguration(config: EnvironmentVariables, logger: Pick<Logger, 'warn'>): void {
  if (config.STORAGE_PROVIDER === 's3') {
    const required = ['S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const;
    const missing = required.filter((key) => {
      const value = config[key];
      return typeof value !== 'string' || value.trim() === '';
    });

    if (missing.length > 0) {
      throw new Error(
        `STORAGE_PROVIDER=s3 requires ${missing.join(', ')}. ` +
          'Provide the object-storage credentials, or use STORAGE_PROVIDER=local in development.',
      );
    }
    return;
  }

  if (config.NODE_ENV === NodeEnvironment.Production) {
    logger.warn(
      `STORAGE_PROVIDER=local in production: uploads are written to "${config.STORAGE_LOCAL_ROOT}" on this host. ` +
        'This is only safe for a single-node deployment with a persistent volume — use s3 otherwise.',
    );
  }
}

/**
 * The sandbox gateway simulates the bank inside this API and would mark orders
 * paid without any money moving, so it can never run in production; Zarinpal
 * needs its merchant id at boot, not at the first checkout.
 */
function assertPaymentConfiguration(config: EnvironmentVariables, logger: Pick<Logger, 'warn'>): void {
  if (config.PAYMENT_GATEWAY_PROVIDER === 'zarinpal') {
    if (config.ZARINPAL_MERCHANT_ID === undefined) {
      throw new Error(
        'PAYMENT_GATEWAY_PROVIDER=zarinpal requires ZARINPAL_MERCHANT_ID. ' +
          'Provide the merchant id issued by Zarinpal, or use PAYMENT_GATEWAY_PROVIDER=sandbox in development.',
      );
    }
    return;
  }

  if (config.NODE_ENV === NodeEnvironment.Production) {
    throw new Error(
      'PAYMENT_GATEWAY_PROVIDER=sandbox cannot be used in production: it simulates the bank and confirms payments without moving money. ' +
        'Configure PAYMENT_GATEWAY_PROVIDER=zarinpal with a real merchant id.',
    );
  }

  logger.warn(
    'PAYMENT_GATEWAY_PROVIDER=sandbox — card payments are simulated by the built-in sandbox bank page; no money moves. ' +
      'This is a development/test provider only.',
  );
}

/** Redirect URI Google sends the user back to (see {@link EnvironmentVariables.GOOGLE_REDIRECT_URI}). */
export function resolveGoogleRedirectUri(config: Pick<EnvironmentVariables, 'GOOGLE_REDIRECT_URI' | 'PUBLIC_WEB_ORIGIN' | 'PUBLIC_API_ORIGIN'>): string {
  return config.GOOGLE_REDIRECT_URI ?? `${config.PUBLIC_WEB_ORIGIN ?? config.PUBLIC_API_ORIGIN}/api/session/google/callback`;
}

/**
 * Google sign-in is optional, but half a client is a mistake worth failing on;
 * in production Google only accepts (and we only send) an https redirect URI.
 */
function assertGoogleConfiguration(config: EnvironmentVariables): void {
  const hasId = config.GOOGLE_CLIENT_ID !== undefined;
  const hasSecret = config.GOOGLE_CLIENT_SECRET !== undefined;
  if (hasId !== hasSecret) {
    throw new Error(
      `Google sign-in needs both GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (missing ${hasId ? 'GOOGLE_CLIENT_SECRET' : 'GOOGLE_CLIENT_ID'}). ` +
        'Set both from the OAuth client in Google Cloud Console, or leave both blank to switch Google sign-in off.',
    );
  }
  if (!hasId) {
    return;
  }
  const redirectUri = resolveGoogleRedirectUri(config);
  if (config.NODE_ENV === NodeEnvironment.Production && !redirectUri.startsWith('https://')) {
    throw new Error(`Google sign-in in production needs an https redirect URI (got "${redirectUri}"). Set PUBLIC_WEB_ORIGIN or GOOGLE_REDIRECT_URI to the https address.`);
  }
}

function formatValidationErrors(errors: readonly ValidationError[], parentPath = ''): string {
  return errors
    .flatMap((error) => {
      const path = parentPath ? `${parentPath}.${error.property}` : error.property;
      const ownMessages = error.constraints ? Object.values(error.constraints) : [];
      const childMessages = error.children?.length ? [formatValidationErrors(error.children, path)] : [];
      return [...ownMessages, ...childMessages];
    })
    .join('\n');
}
