import { ValidationPipe, type INestApplication } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import multipart from '@fastify/multipart';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import { GLOBAL_API_PREFIX, SWAGGER_JSON_PATH, SWAGGER_PATH } from '../common/constants';
import { buildCorsOptions } from '../config/cors.config';

/**
 * Applies the HTTP contract of the API: URL prefix, CORS policy and request
 * validation. Called from `main.ts` and from the end-to-end tests so both run
 * the exact same configuration.
 */
export function applyGlobalPolicies(app: INestApplication, config: ConfigService): void {
  app.setGlobalPrefix(GLOBAL_API_PREFIX);
  app.enableCors(buildCorsOptions(config));
  registerMultipart(app, config);

  app.useGlobalPipes(
    new ValidationPipe({
      // Strip properties that carry no decorator, and reject the request when
      // unknown properties are present: clients get a loud error instead of
      // silently ignored input.
      whitelist: true,
      forbidNonWhitelisted: true,
      // Convert plain payloads into DTO instances so decorators transform values.
      transform: true,
      validateCustomDecorators: true,
    }),
  );
}

/**
 * Registers `@fastify/multipart` so `POST /media/upload/*` can accept
 * `multipart/form-data`.
 *
 * The limits here are the transport-level guard: a request body larger than the
 * document ceiling is aborted while it is still being received, so an oversized
 * upload never consumes memory in the application. The media service applies the
 * stricter per-kind limits (5 MB images / 10 MB documents) afterwards, because at
 * this level the kind is not yet known.
 *
 * `files: 1` is deliberate — one file per request. A batch endpoint, if it is
 * ever needed, should be its own route with its own accounting.
 */
export function registerMultipart(app: INestApplication, config: ConfigService): void {
  const maxDocumentBytes = config.get<number>('MEDIA_MAX_DOCUMENT_BYTES') ?? 10_485_760;
  // `register` lives on the Fastify adapter; the app is always created with it.
  const fastifyApp = app as NestFastifyApplication;
  // `@fastify/multipart` types its plugin against its own copy of `fastify`, which
  // TypeScript treats as a distinct module instance from the one the Nest adapter
  // ships. The runtime contract is the standard Fastify plugin signature, so the
  // cast is a version-drift workaround, not a behaviour change.
  const plugin = multipart as unknown as Parameters<NestFastifyApplication['register']>[0];

  void fastifyApp.register(plugin, {
    limits: {
      fileSize: maxDocumentBytes,
      files: 1,
      fields: 10,
      fieldNameSize: 100,
      fieldSize: 4_096,
    },
    // Streams are not thrown away silently: the media service reads the whole
    // buffer and decides, so a truncated file fails magic-byte detection.
    throwFileSizeLimit: true,
  });
}

/**
 * Builds the OpenAPI document from the registered controllers. Kept separate
 * from {@link setupSwagger} because generating the document is pure routing
 * metadata, while serving the UI needs the Fastify static-assets plugin. Tests
 * assert the contract in-process without pulling in the plugin.
 */
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  return SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Shagerdam (شاگردم) API')
      .setDescription(
        'Multi-vendor marketplace with banking credit (BNPL). Every endpoint is namespaced under /api/v1.\n\n' +
          '**Authentication:** the two anonymous entry points are `POST /api/v1/auth/otp/request` and ' +
          '`POST /api/v1/auth/login/password`, both of which return an access token (15 minutes) and a ' +
          'rotating refresh token (7 days). Send the access token as `Authorization: Bearer <token>`; ' +
          'every other endpoint rejects requests without it.',
      )
      .setVersion('1.0.0')
      .addBearerAuth(
        {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Access token issued by /api/v1/auth/otp/verify or /api/v1/auth/login/password',
        },
        'access-token',
      )
      .addTag('auth', 'Authentication, sessions and self-service profile')
      .addTag('admin-users', 'Staff-only identity lookup and search')
      .addTag('admin-audit', 'Immutable audit trail (admins only)')
      .addTag('media', 'File uploads: images are converted to WebP, documents stay private')
      .addTag('vendors', 'Store onboarding, KYC submission and storefront profile')
      .addTag('admin-vendors', 'Store review: listing, full detail and the verification decision')
      .addTag('categories', 'Public category tree and category pages with breadcrumbs')
      .addTag('admin-categories', 'Category management and commission rates (admins only)')
      .addTag('products', 'Public catalogue search, filtering and product pages')
      .addTag('vendor-products', "A vendor's own products, variant matrix and stock")
      .addTag('admin-products', 'Staff product review and moderation')
      .addTag('customer-addresses', "A customer's address book (copied into orders at checkout)")
      .addTag('cart', 'Guest and account cart, grouped by store, with live stock and price checks')
      .addTag('orders', 'Checkout: one order, one package per store, stock reserved in one transaction')
      .addTag('customer-orders', "A customer's orders, tracking and cancellation of unpaid orders")
      .addTag('vendor-orders', "A store's paid packages and fulfilment status")
      .addTag('admin-orders', 'Staff order search and forced package resolutions')
      .addTag('payments', 'Card payment (IPG): initiate a payment and the public bank callback')
      .addTag('sandbox-payments', 'DEVELOPMENT ONLY — simulated bank page of the sandbox gateway (404 unless PAYMENT_GATEWAY_PROVIDER=sandbox)')
      .addTag('vendor-wallet', "A store's escrow wallet, ledger and settlement (payout) requests")
      .addTag('admin-settlements', 'Finance: review and pay out vendor settlement requests')
      .addTag('admin-financial', 'Finance: platform GMV, commission, escrow and settlement overview')
      .addTag('credit', 'Credit engine (BNPL): apply for a credit line, my credit account, instalment plans on offer')
      .addTag('credit-payments', 'Pay an order with bank credit (BANK_CREDIT) or credit + card (HYBRID)')
      .addTag('credit-installments', 'My instalments grouped by order, and paying an instalment by card')
      .addTag('admin-credit', 'Finance: credit applications, credit accounts and the aggregated credit exposure')
      .addTag('customer-disputes', 'Disputes: open a dispute about a package (escrow is frozen), follow it, cancel it')
      .addTag('vendor-disputes', 'Disputes against my store: read the complaint and evidence, accept the return or defend')
      .addTag('admin-disputes', 'Trust & Safety: dispute dossiers and arbitration with automatic financial resolution')
      .addTag('branding', 'Public storefront identity: logo, mobile logo, favicon and active home hero banners')
      .addTag('admin-branding', 'Visual identity management: branding uploads (Sharp → WebP), logos, favicon and hero banners')
      .addTag('integrations-torob', 'Torob (ترب) price-comparison feed: marketplace and per-store product feeds, real-time product check')
      .build(),
  );
}

/**
 * Publishes the OpenAPI document. The UI is served at `/api/docs` and the raw
 * document at `/api/docs-json`; neither is affected by the global API prefix.
 */
export function setupSwagger(app: INestApplication): OpenAPIObject {
  const document = buildOpenApiDocument(app);

  SwaggerModule.setup(SWAGGER_PATH, app, document, {
    jsonDocumentUrl: SWAGGER_JSON_PATH,
    customSiteTitle: 'Shagerdam API',
    swaggerOptions: { persistAuthorization: true, displayRequestDuration: true },
  });

  return document;
}
