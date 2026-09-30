/**
 * HTTP smoke test for a running API instance.
 *
 * Run with:  pnpm --filter @shopino/backend run verify:http
 * Target:    API_BASE_URL (defaults to http://127.0.0.1:4000)
 *
 * Exercises the public contract over the network — the same way a browser or a
 * load balancer does — and fails with a non-zero exit code when a check breaks.
 * This is the layer where the Swagger UI is verified, since serving it depends
 * on the ESM-only glob package that Jest cannot load (see test/health.e2e-spec.ts).
 */

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

const REQUEST_TIMEOUT_MS = 5_000;

function apiBaseUrl(): string {
  return (process.env.API_BASE_URL ?? 'http://127.0.0.1:4000').replace(/\/+$/, '');
}

async function request(path: string): Promise<Response> {
  return fetch(`${apiBaseUrl()}${path}`, {
    headers: { Accept: '*/*' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

async function checkHealth(): Promise<CheckResult> {
  const response = await request('/api/v1/health');
  const body = (await response.json()) as {
    status: string;
    info?: Record<string, { status: string }>;
  };
  const database = body.info?.database?.status;
  const redis = body.info?.redis?.status;
  return {
    name: 'GET /api/v1/health',
    ok: response.status === 200 && body.status === 'ok' && database === 'up' && redis === 'up',
    detail: `HTTP ${response.status} · status=${body.status} · database=${database} · redis=${redis}`,
  };
}

async function checkOpenApiDocument(): Promise<CheckResult> {
  const response = await request('/api/docs-json');
  const document = (await response.json()) as { info?: { title?: string }; paths?: object };
  const paths = Object.keys(document.paths ?? {});
  return {
    name: 'GET /api/docs-json',
    ok: response.status === 200 && paths.includes('/api/v1/health'),
    detail: `HTTP ${response.status} · title=${document.info?.title ?? 'unknown'} · paths=${paths.join(', ')}`,
  };
}

async function checkSwaggerUi(): Promise<CheckResult> {
  const response = await request('/api/docs');
  const html = await response.text();
  const rendersSwagger = html.includes('swagger-ui') && html.includes('<title>Shopino API</title>');
  return {
    name: 'GET /api/docs',
    ok: response.status === 200 && rendersSwagger,
    detail: `HTTP ${response.status} · ${html.length} bytes · swagger-ui assets referenced=${rendersSwagger}`,
  };
}

async function checkUnknownRouteIs404(): Promise<CheckResult> {
  const response = await request('/api/v1/definitely-not-a-route');
  return {
    name: 'GET /api/v1/definitely-not-a-route',
    ok: response.status === 404,
    detail: `HTTP ${response.status}`,
  };
}

async function main(): Promise<void> {
  const checks = [
    await checkHealth(),
    await checkOpenApiDocument(),
    await checkSwaggerUi(),
    await checkUnknownRouteIs404(),
  ];

  for (const check of checks) {
    console.warn(`${check.ok ? '[ok]  ' : '[FAIL]'} ${check.name} — ${check.detail}`);
  }

  const failed = checks.filter((check) => !check.ok);
  if (failed.length > 0) {
    throw new Error(`${failed.length} of ${checks.length} HTTP checks failed`);
  }
  console.warn(`[verify:http] API at ${apiBaseUrl()} passed all ${checks.length} checks`);
}

main().catch((error: unknown) => {
  console.error(`[verify:http] FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
