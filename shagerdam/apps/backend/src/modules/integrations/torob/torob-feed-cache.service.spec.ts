import type { ConfigService } from '@nestjs/config';
import type { EnvironmentVariables } from '../../../config/env.validation';
import type { RedisService } from '../../../infra/redis/redis.service';
import {
  TOROB_DELAYED_INVALIDATION_MS,
  TOROB_FEED_GENERATION_KEY,
  TOROB_FEED_PAGE_PREFIX,
  TorobFeedCacheService,
} from './torob-feed-cache.service';

interface RedisDouble {
  store: Map<string, string>;
  get: jest.Mock;
  set: jest.Mock;
  incr: jest.Mock;
}

function redisDouble(): RedisDouble {
  const store = new Map<string, string>();
  return {
    store,
    get: jest.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
    set: jest.fn((key: string, value: string) => {
      store.set(key, value);
      return Promise.resolve('OK');
    }),
    incr: jest.fn((key: string) => {
      const next = Number(store.get(key) ?? '0') + 1;
      store.set(key, String(next));
      return Promise.resolve(next);
    }),
  };
}

function service(client: RedisDouble, ttl = 300): TorobFeedCacheService {
  const redis = { client } as unknown as RedisService;
  const config = { get: jest.fn(() => ttl) } as unknown as ConfigService<EnvironmentVariables, true>;
  return new TorobFeedCacheService(redis, config);
}

describe('TorobFeedCacheService', () => {
  afterEach(() => jest.useRealTimers());

  it('stores pages under the given generation with the configured TTL', async () => {
    const client = redisDouble();
    const cache = service(client, 120);
    await cache.write('IRR:*:1:100', 0, { count: 1 });
    expect(client.set).toHaveBeenCalledWith(`${TOROB_FEED_PAGE_PREFIX}:g0:IRR:*:1:100`, '{"count":1}', 'EX', 120);
    await expect(cache.read('IRR:*:1:100', 0)).resolves.toEqual({ count: 1 });
  });

  it('invalidation bumps the generation, so earlier pages are unreachable', async () => {
    const client = redisDouble();
    const cache = service(client);
    const before = await cache.generation();
    await cache.write('k', before, { stale: true });
    await cache.invalidate();
    const after = await cache.generation();
    expect(after).toBe(before + 1);
    await expect(cache.read('k', after)).resolves.toBeNull();
  });

  it('a page built across an invalidation is written to the stale generation', async () => {
    const client = redisDouble();
    const cache = service(client);
    const generationAtLoad = await cache.generation();
    await cache.invalidate(); // a product changed while the page was being built
    await cache.write('k', generationAtLoad, { old: true });
    await expect(cache.read('k', await cache.generation())).resolves.toBeNull();
  });

  it('afterCommit invalidates now and again after the delay', async () => {
    jest.useFakeTimers();
    const client = redisDouble();
    const cache = service(client);
    await cache.invalidate({ afterCommit: true });
    expect(client.incr).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(TOROB_DELAYED_INVALIDATION_MS);
    await Promise.resolve();
    expect(client.incr).toHaveBeenCalledTimes(2);
    expect(client.store.get(TOROB_FEED_GENERATION_KEY)).toBe('2');
  });

  it('pending delayed invalidations are cancelled on shutdown', async () => {
    jest.useFakeTimers();
    const client = redisDouble();
    const cache = service(client);
    await cache.invalidate({ afterCommit: true });
    cache.onModuleDestroy();
    jest.advanceTimersByTime(TOROB_DELAYED_INVALIDATION_MS * 2);
    expect(client.incr).toHaveBeenCalledTimes(1);
  });

  it('TTL 0 disables caching entirely', async () => {
    const client = redisDouble();
    const cache = service(client, 0);
    expect(cache.enabled).toBe(false);
    await cache.write('k', 0, { x: 1 });
    await expect(cache.read('k', 0)).resolves.toBeNull();
    expect(client.set).not.toHaveBeenCalled();
  });

  it('never throws when Redis fails (reads miss, writes and invalidations are skipped)', async () => {
    const failing = redisDouble();
    const boom = (): Promise<never> => Promise.reject(new Error('redis down'));
    failing.get.mockImplementation(boom);
    failing.set.mockImplementation(boom);
    failing.incr.mockImplementation(boom);
    const cache = service(failing);
    await expect(cache.generation()).resolves.toBe(0);
    await expect(cache.read('k', 0)).resolves.toBeNull();
    await expect(cache.write('k', 0, {})).resolves.toBeUndefined();
    await expect(cache.invalidate()).resolves.toBeUndefined();
  });
});
