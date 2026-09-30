/**
 * Operational connectivity probe for PostgreSQL and Redis.
 *
 * Run with:  pnpm --filter @shopino/backend run verify:connections
 *
 * Unlike the HTTP health endpoint this script runs outside Nest, prints the
 * server versions it reached and exits with a non-zero status on failure, so it
 * can be used in CI gates and in deployment smoke tests.
 */
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import { errorMessage } from '../src/common/utils';

interface PostgresFacts {
  database: string;
  role: string;
  server_version: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`${name} is not set. Run this script through "pnpm run verify:connections" so .env is loaded.`);
  }
  return value;
}

function parseRedisVersion(info: string): string {
  const match = /^redis_version:(.+)$/m.exec(info);
  return match?.[1]?.trim() ?? 'unknown';
}

async function verifyPostgres(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const rows = await prisma.$queryRaw<PostgresFacts[]>`
      SELECT current_database() AS database,
             current_user AS role,
             version() AS server_version
    `;
    const [facts] = rows;
    if (facts === undefined) {
      throw new Error('PostgreSQL returned no rows for the connectivity probe.');
    }
    console.warn(`[postgres] ok  database=${facts.database} role=${facts.role}`);
    console.warn(`[postgres] ${facts.server_version}`);
  } finally {
    await prisma.$disconnect();
  }
}

async function verifyRedis(): Promise<void> {
  const client = new Redis({
    host: requireEnv('REDIS_HOST'),
    port: Number.parseInt(requireEnv('REDIS_PORT'), 10),
    password: requireEnv('REDIS_PASSWORD'),
    db: Number.parseInt(process.env.REDIS_DB ?? '0', 10),
    connectTimeout: 5_000,
    maxRetriesPerRequest: 2,
    lazyConnect: true,
  });

  try {
    await client.connect();
    const startedAt = Date.now();
    const pong: string = await client.ping();
    if (pong !== 'PONG') {
      throw new Error(`Unexpected PING reply: ${pong}`);
    }
    const info = await client.info('server');
    console.warn(`[redis]    ok  version=${parseRedisVersion(info)} ping=${Date.now() - startedAt}ms`);
  } finally {
    await client.quit();
  }
}

async function main(): Promise<void> {
  await verifyPostgres();
  await verifyRedis();
  console.warn('[verify:connections] all infrastructure connections are healthy');
}

main().catch((error: unknown) => {
  console.error(`[verify:connections] FAILED: ${errorMessage(error)}`);
  process.exitCode = 1;
});
