import { Injectable } from '@nestjs/common';
import { RedisService } from '../../../infra/redis/redis.service';
import type { BulkItem, BulkJobMeta } from './bulk-job.types';

/** Jobs (and the pointer to a store's latest job) are kept a week, then expire. */
export const BULK_JOB_TTL_SECONDS = 7 * 24 * 60 * 60;
/** The active-job lock expires unless the runner's heartbeat refreshes it. */
export const BULK_LOCK_TTL_SECONDS = 60;

export const bulkKeys = {
  meta: (jobId: string): string => `importer:bulk:job:${jobId}`,
  items: (jobId: string): string => `importer:bulk:job:${jobId}:items`,
  cancel: (jobId: string): string => `importer:bulk:job:${jobId}:cancel`,
  latest: (vendorId: string): string => `importer:bulk:latest:${vendorId}`,
  active: (vendorId: string): string => `importer:bulk:active:${vendorId}`,
  daily: (vendorId: string): string => `importer:bulk:daily:${vendorId}`,
  crawl: (vendorId: string): string => `importer:crawl:${vendorId}`,
};

/** Deletes the lock only when it still belongs to this job (never another job's lock). */
const RELEASE_LOCK = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`;
/** Extends the lock only when it still belongs to this job. */
const REFRESH_LOCK = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('EXPIRE', KEYS[1], ARGV[2]) else return 0 end`;

/**
 * Redis persistence of bulk-import jobs.
 *
 * - `importer:bulk:job:{id}` — job metadata (JSON string);
 * - `importer:bulk:job:{id}:items` — hash: item index → item JSON, so the
 *   runner updates one item with one `HSET` and any instance can read the whole
 *   job with one `HGETALL`;
 * - `importer:bulk:job:{id}:cancel` — cancel flag, a separate key so a cancel
 *   request never races the runner's metadata writes;
 * - `importer:bulk:latest:{vendorId}` — the store's most recent job (the panel
 *   shows it again after the window was closed);
 * - `importer:bulk:active:{vendorId}` — one running job per store (`SET NX`,
 *   expiring lock refreshed by the heartbeat).
 */
@Injectable()
export class BulkJobStore {
  constructor(private readonly redis: RedisService) {}

  async create(meta: BulkJobMeta, items: BulkItem[]): Promise<void> {
    const pipeline = this.redis.client.multi();
    pipeline.set(bulkKeys.meta(meta.id), JSON.stringify(meta), 'EX', BULK_JOB_TTL_SECONDS);
    pipeline.hset(bulkKeys.items(meta.id), Object.fromEntries(items.map((item) => [String(item.index), JSON.stringify(item)])));
    pipeline.expire(bulkKeys.items(meta.id), BULK_JOB_TTL_SECONDS);
    pipeline.set(bulkKeys.latest(meta.vendorId), meta.id, 'EX', BULK_JOB_TTL_SECONDS);
    await pipeline.exec();
  }

  async getMeta(jobId: string): Promise<BulkJobMeta | null> {
    const raw = await this.redis.client.get(bulkKeys.meta(jobId));
    return raw === null ? null : (JSON.parse(raw) as BulkJobMeta);
  }

  async saveMeta(meta: BulkJobMeta): Promise<void> {
    await this.redis.client.set(bulkKeys.meta(meta.id), JSON.stringify(meta), 'EX', BULK_JOB_TTL_SECONDS);
  }

  async getItems(jobId: string): Promise<BulkItem[]> {
    const raw = await this.redis.client.hgetall(bulkKeys.items(jobId));
    return Object.values(raw)
      .map((value) => JSON.parse(value) as BulkItem)
      .sort((a, b) => a.index - b.index);
  }

  async getItem(jobId: string, index: number): Promise<BulkItem | null> {
    const raw = await this.redis.client.hget(bulkKeys.items(jobId), String(index));
    return raw === null ? null : (JSON.parse(raw) as BulkItem);
  }

  async saveItem(jobId: string, item: BulkItem): Promise<void> {
    await this.redis.client.hset(bulkKeys.items(jobId), String(item.index), JSON.stringify(item));
  }

  async saveItems(jobId: string, items: BulkItem[]): Promise<void> {
    if (items.length === 0) return;
    await this.redis.client.hset(bulkKeys.items(jobId), Object.fromEntries(items.map((item) => [String(item.index), JSON.stringify(item)])));
  }

  async latestJobId(vendorId: string): Promise<string | null> {
    return this.redis.client.get(bulkKeys.latest(vendorId));
  }

  /** Takes the store's single active-job slot; returns the holder's job id when it is taken. */
  async acquireLock(vendorId: string, jobId: string): Promise<{ acquired: true } | { acquired: false; holder: string | null }> {
    const result = await this.redis.client.set(bulkKeys.active(vendorId), jobId, 'EX', BULK_LOCK_TTL_SECONDS, 'NX');
    if (result === 'OK') return { acquired: true };
    return { acquired: false, holder: await this.redis.client.get(bulkKeys.active(vendorId)) };
  }

  async refreshLock(vendorId: string, jobId: string): Promise<boolean> {
    const result = await this.redis.client.eval(REFRESH_LOCK, 1, bulkKeys.active(vendorId), jobId, String(BULK_LOCK_TTL_SECONDS));
    return result === 1;
  }

  async releaseLock(vendorId: string, jobId: string): Promise<void> {
    await this.redis.client.eval(RELEASE_LOCK, 1, bulkKeys.active(vendorId), jobId);
  }

  async requestCancel(jobId: string): Promise<void> {
    await this.redis.client.set(bulkKeys.cancel(jobId), '1', 'EX', BULK_JOB_TTL_SECONDS);
  }

  async isCancelRequested(jobId: string): Promise<boolean> {
    return (await this.redis.client.exists(bulkKeys.cancel(jobId))) === 1;
  }

  async clearCancel(jobId: string): Promise<void> {
    await this.redis.client.del(bulkKeys.cancel(jobId));
  }
}
