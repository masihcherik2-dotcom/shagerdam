import { ConfigService } from '@nestjs/config';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { GLOBAL_API_PREFIX } from '../src/common/constants';
import { applyGlobalPolicies, buildOpenApiDocument } from '../src/setup/app.setup';

/**
 * End-to-end verification against the real infrastructure: this suite talks to
 * the PostgreSQL and Redis instances started by docker-compose — nothing is
 * stubbed. Run `docker compose up -d` first, then
 * `pnpm --filter @shopino/backend run test:e2e`.
 *
 * Note on Swagger: the DocumentBuilder contract is asserted here, while the
 * served UI is verified over HTTP by `pnpm run verify:http` (see
 * scripts/smoke-http.ts). Serving the UI pulls in @fastify/static → glob@13,
 * which is ESM-only: Node 22 loads it through require(esm), whereas Jest's
 * CommonJS runtime cannot, so the HTTP layer is exercised where it actually
 * matters — against a running server.
 */
describe('Health endpoint (e2e)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());

    const config = app.get(ConfigService);
    applyGlobalPolicies(app, config);

    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/v1/health reports database and redis as up', async () => {
    const response = await app.inject({ method: 'GET', url: `/${GLOBAL_API_PREFIX}/health` });

    expect(response.statusCode).toBe(200);

    const body = response.json<{ status: string; info: Record<string, { status: string }> }>();
    expect(body.status).toBe('ok');
    expect(body.info.database?.status).toBe('up');
    expect(body.info.redis?.status).toBe('up');
    expect(body.info.memory?.status).toBe('up');
    expect(body.info.uptime?.status).toBe('up');
  });

  it('publishes the health route in the OpenAPI document', () => {
    const document = buildOpenApiDocument(app);

    expect(document.info.title).toBe('Shagerdam (شاگردم) API');
    expect(Object.keys(document.paths)).toContain(`/${GLOBAL_API_PREFIX}/health`);
  });

  it('rejects unknown routes with 404', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/${GLOBAL_API_PREFIX}/does-not-exist`,
    });

    expect(response.statusCode).toBe(404);
  });
});
