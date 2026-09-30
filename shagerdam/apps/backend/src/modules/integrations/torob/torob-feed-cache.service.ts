import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnvironmentVariables } from '../../../config/env.validation';
import { errorMessage } from '../../../common/utils';
import { RedisService } from '../../../infra/redis/redis.service';

/** Redis key holding the feed generation; every cached page key embeds it. */
export const TOROB_FEED_GENERATION_KEY = 'torob:feed:generation';
/** Prefix of cached feed pages: `torob:feed:v1:g<generation>:<rest>`. */
export const TOROB_FEED_PAGE_PREFIX = 'torob:feed:v1';
/**
 * Delay of the second invalidation, for writers that call `invalidate()` from
 * inside a database transaction (the inventory service). See `invalidate`.
 */
export const TOROB_DELAYED_INVALIDATION_MS = 2_000;

/**
 * Cache of rendered Torob feed pages.
 *
 * Invalidation is O(1) and never scans Redis: every page key embeds the current
 * *generation* (`INCR torob:feed:generation`). Bumping the generation makes every
 * cached page unreachable at once; the orphaned keys simply expire with their TTL.
 *
 * All operations are best-effort. A Redis failure never fails a product write or
 * a feed request: reads fall back to PostgreSQL, and a failed invalidation is
 * bounded by the TTL (`TOROB_FEED_CACHE_TTL_SECONDS`).
 */
@Injectable()
export class TorobFeedCacheService implements OnModuleDestroy {
  private readonly logger = new Logger(TorobFeedCacheService.name);
  private readonly ttlSeconds: number;
  private readonly pendingTimers = new Set<NodeJS.Timeout>();

  constructor(
    private readonly redis: RedisService,
    config: ConfigService<EnvironmentVariables, true>,
  ) {
    this.ttlSeconds = config.get('TOROB_FEED_CACHE_TTL_SECONDS', { infer: true });
  }

  get enabled(): boolean {
    return this.ttlSeconds > 0;
  }

  /**
   * Makes every cached page stale.
   *
   * Callers that run *after* their transaction committed (the products service)
   * need nothing more. Callers inside a transaction (stock reservations) pass
   * `{ afterCommit: true }`: the generation is bumped now **and again** after a
   * short delay, so a feed request that re-cached the pre-commit state in the gap
   * between the first bump and the commit is discarded too ("delayed double
   * invalidation"). The TTL bounds anything beyond that.
   */
  async invalidate(options: { afterCommit?: boolean } = {}): Promise<void> {
    await this.bump();
    if (options.afterCommit === true) {
      const timer = setTimeout(() => {
        this.pendingTimers.delete(timer);
        void this.bump();
      }, TOROB_DELAYED_INVALIDATION_MS);
      timer.unref();
      this.pendingTimers.add(timer);
    }
  }

  /** Cached page for `key` under `generation` (read `generation()` first and reuse it for `write`). */
  async read<T>(key: string, generation: number): Promise<T | null> {
    if (!this.enabled) {
      return null;
    }
    try {
      const raw = await this.redis.client.get(this.pageKey(generation, key));
      return raw === null ? null : (JSON.parse(raw) as T);
    } catch (error) {
      this.logger.warn(`Torob feed cache read failed, loading from PostgreSQL: ${errorMessage(error)}`);
      return null;
    }
  }

  /**
   * Stores a page under the generation that was current **before** the page was
   * loaded, so a page built from data older than a concurrent invalidation is
   * written to an already-stale key and can never be served.
   */
  async write(key: string, generation: number, value: unknown): Promise<void> {
    if (!this.enabled) {
      return;
    }
    try {
      await this.redis.client.set(this.pageKey(generation, key), JSON.stringify(value), 'EX', this.ttlSeconds);
    } catch (error) {
      this.logger.warn(`Torob feed cache write failed: ${errorMessage(error)}`);
    }
  }

  /** Current generation (0 when never bumped or when Redis is unavailable). */
  async generation(): Promise<number> {
    try {
      const raw = await this.redis.client.get(TOROB_FEED_GENERATION_KEY);
      const parsed = raw === null ? 0 : Number.parseInt(raw, 10);
      return Number.isFinite(parsed) ? parsed : 0;
    } catch (error) {
      this.logger.warn(`Torob feed generation read failed: ${errorMessage(error)}`);
      return 0;
    }
  }

  onModuleDestroy(): void {
    for (const timer of this.pendingTimers) {
      clearTimeout(timer);
    }
    this.pendingTimers.clear();
  }

  private async bump(): Promise<void> {
    try {
      await this.redis.client.incr(TOROB_FEED_GENERATION_KEY);
    } catch (error) {
      this.logger.warn(`Torob feed cache invalidation failed (TTL applies): ${errorMessage(error)}`);
    }
  }

  private pageKey(generation: number, key: string): string {
    return `${TOROB_FEED_PAGE_PREFIX}:g${generation}:${key}`;
  }
}
