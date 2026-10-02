import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { TooManyRequestsException } from '../../../common/exceptions/too-many-requests.exception';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { RedisService } from '../../../infra/redis/redis.service';
import { CategoriesService } from '../../categories/categories.service';
import { MAX_STOCK } from '../../products/product-rules';
import { ProductsService } from '../../products/products.service';
import type { ExtractedProduct } from '../extractors/extracted-product';
import { StoreCrawlerService, type CrawlStoreInput, type CrawlStoreResult } from '../crawler/store-crawler.service';
import { ImportError, toHttpException } from '../import-error';
import { ProductImporterService } from '../product-importer.service';
import { canonicalProductUrl } from '../crawler/sitemap';
import { BulkJobStore, bulkKeys } from './bulk-job.store';
import {
  RETRYABLE_STATUSES,
  type BulkItem,
  type BulkItemNote,
  type BulkJobCounts,
  type BulkJobMeta,
  type BulkJobStatus,
  type BulkJobView,
} from './bulk-job.types';
import { buildProductDraft, draftProblems, importSku, type DraftOptions, type PriceUnitOption } from './product-draft';

/** Parallel product pages per job (TM: concurrency 3). */
export const BULK_CONCURRENCY = 3;
/** Minimum spacing between two page requests of one job, so the source site is not hammered. */
export const BULK_REQUEST_SPACING_MS = 500;
export const MAX_BULK_URLS = 200;
/** Images copied per product (the first ones of the gallery). */
export const MAX_BULK_IMAGES_PER_PRODUCT = 6;
/** Products a store may bulk-import per 24 h (staff are exempt). */
export const BULK_DAILY_LIMIT = 400;
export const BULK_DAILY_WINDOW_SECONDS = 24 * 60 * 60;
/** Store scans per store per hour (each is up to 25 requests to the source site; staff are exempt). */
export const CRAWL_LIMIT = 20;
export const CRAWL_WINDOW_SECONDS = 60 * 60;
/** Jobs processed at once by one API instance (memory/CPU guard for image processing). */
export const MAX_RUNNING_JOBS_PER_INSTANCE = 4;
export const HEARTBEAT_INTERVAL_MS = 10_000;
/** A RUNNING job whose heartbeat is older than this has lost its runner. */
export const STALE_AFTER_MS = 45_000;

export interface BulkActor {
  vendorId: string;
  ownerUserId: string;
  actorId: string;
  staff: boolean;
}

export interface StartBulkInput {
  urls: string[];
  storeUrl?: string | null;
  autoPublish?: boolean;
  priceUnit?: PriceUnitOption;
  defaultStock?: number;
  defaultCategoryId?: string | null;
}

export interface RetryBulkInput {
  itemIndexes?: number[];
  autoPublish?: boolean;
  priceUnit?: PriceUnitOption;
  defaultStock?: number;
  defaultCategoryId?: string | null;
}

interface RunState {
  vendorId: string;
  stopping: boolean;
}

/**
 * Bulk product import as a background job (architect's decision: Redis-backed
 * job + polling).
 *
 * `start` validates the request, takes the store's single job slot, stores the
 * job in Redis and returns at once; the job then runs inside this API instance
 * with {@link BULK_CONCURRENCY} workers. Each item is persisted after every
 * state change, so any instance can report progress (`GET …/bulk-jobs/:id`)
 * and a closed browser window loses nothing.
 *
 * Each page goes through the same code as a manual import: the importer's
 * extractors (SSRF-guarded fetch), the media pipeline for images (owned by the
 * store owner), and `ProductsService.create` (validation, audit row naming the
 * actor). Nothing is guessed: a page without a usable price or category ends
 * as NEEDS_REVIEW, never as a product with invented data.
 *
 * Crash/restart safety: the runner refreshes a heartbeat; a RUNNING job with a
 * stale heartbeat is reported as INTERRUPTED and can be resumed with `retry`,
 * which re-queues unfinished, failed and needs-review items. Already created
 * products are never duplicated — every import has a deterministic SKU.
 */
@Injectable()
export class BulkImportService implements OnApplicationShutdown {
  private readonly logger = new Logger(BulkImportService.name);
  private readonly running = new Map<string, RunState>();

  constructor(
    private readonly store: BulkJobStore,
    private readonly importer: ProductImporterService,
    private readonly products: ProductsService,
    private readonly categories: CategoriesService,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly crawler: StoreCrawlerService,
  ) {}

  /** Resolves the calling vendor's store (403 when the account has none). */
  async vendorActor(userId: string): Promise<BulkActor> {
    const vendor = await this.prisma.vendor.findUnique({ where: { userId }, select: { id: true } });
    if (vendor === null) {
      throw new ForbiddenException('This account has no store');
    }
    return { vendorId: vendor.id, ownerUserId: userId, actorId: userId, staff: false };
  }

  /** Discovers product URLs of a store (sitemaps, or pasted content). */
  async crawl(actor: BulkActor, input: CrawlStoreInput): Promise<CrawlStoreResult> {
    await this.importer.requireApprovedStore(actor.ownerUserId);
    if (!actor.staff) {
      await this.consume(bulkKeys.crawl(actor.vendorId), 1, CRAWL_LIMIT, CRAWL_WINDOW_SECONDS, `A store can scan at most ${CRAWL_LIMIT} sites per hour`);
    }
    try {
      return await this.crawler.discover(input);
    } catch (error) {
      if (error instanceof ImportError) throw toHttpException(error);
      throw error;
    }
  }

  // ─── Commands ───────────────────────────────────────────────────────────

  async start(actor: BulkActor, input: StartBulkInput): Promise<{ jobId: string; totalProducts: number }> {
    await this.importer.requireApprovedStore(actor.ownerUserId);
    const urls = this.validateUrls(input.urls);
    const options: DraftOptions = {
      // Imported products go live at once unless the caller asks for drafts.
      autoPublish: input.autoPublish ?? true,
      priceUnit: input.priceUnit ?? 'AUTO',
      defaultStock: input.defaultStock ?? 10,
      defaultCategoryId: input.defaultCategoryId ?? null,
    };
    await this.assertCategory(options.defaultCategoryId);
    this.assertCapacity();

    const jobId = randomUUID();
    const lock = await this.store.acquireLock(actor.vendorId, jobId);
    if (!lock.acquired) {
      throw new ConflictException({ statusCode: 409, error: 'Conflict', code: 'BULK_JOB_RUNNING', message: 'Another bulk import of this store is still running', jobId: lock.holder });
    }
    try {
      if (!actor.staff) {
        await this.consumeDaily(actor.vendorId, urls.length);
      }
      const now = new Date().toISOString();
      const meta: BulkJobMeta = {
        id: jobId,
        vendorId: actor.vendorId,
        ownerUserId: actor.ownerUserId,
        actorId: actor.actorId,
        staff: actor.staff,
        storeUrl: input.storeUrl ?? null,
        options,
        status: 'RUNNING',
        total: urls.length,
        runs: 0,
        createdAt: now,
        updatedAt: now,
        finishedAt: null,
        heartbeatAt: now,
      };
      const items: BulkItem[] = urls.map((url, index) => emptyItem(index, url, now));
      await this.store.create(meta, items);
    } catch (error) {
      await this.store.releaseLock(actor.vendorId, jobId);
      throw error;
    }

    this.launch(jobId, actor.vendorId, null);
    this.logger.log(`Bulk import ${jobId} started for store ${actor.vendorId}: ${urls.length} URL(s) by ${actor.staff ? 'staff' : 'vendor'} ${actor.actorId}`);
    return { jobId, totalProducts: urls.length };
  }

  /**
   * Resume / retry: re-queues the chosen items (default: every PENDING,
   * interrupted, FAILED and NEEDS_REVIEW item). Options sent here replace the
   * job's options — e.g. a default category for NEEDS_REVIEW items.
   */
  async retry(actor: BulkActor, jobId: string, input: RetryBulkInput): Promise<BulkJobView> {
    await this.importer.requireApprovedStore(actor.ownerUserId);
    const meta = await this.requireJob(actor, jobId);
    if (meta.status === 'RUNNING') {
      throw new ConflictException({ statusCode: 409, error: 'Conflict', code: 'BULK_JOB_RUNNING', message: 'The job is still running', jobId });
    }
    const items = await this.store.getItems(jobId);
    const wanted = input.itemIndexes !== undefined ? new Set(input.itemIndexes) : null;
    const selected = items.filter((item) => RETRYABLE_STATUSES.has(item.status) && (wanted === null || wanted.has(item.index)));
    if (selected.length === 0) {
      throw new BadRequestException({ statusCode: 400, error: 'Bad Request', code: 'BULK_NOTHING_TO_RETRY', message: 'No pending, failed or needs-review item to retry' });
    }

    const options: DraftOptions = {
      autoPublish: input.autoPublish ?? meta.options.autoPublish,
      priceUnit: input.priceUnit ?? meta.options.priceUnit,
      defaultStock: input.defaultStock ?? meta.options.defaultStock,
      defaultCategoryId: input.defaultCategoryId !== undefined ? input.defaultCategoryId : meta.options.defaultCategoryId,
    };
    await this.assertCategory(options.defaultCategoryId);
    this.assertCapacity();

    const lock = await this.store.acquireLock(actor.vendorId, jobId);
    if (!lock.acquired) {
      throw new ConflictException({ statusCode: 409, error: 'Conflict', code: 'BULK_JOB_RUNNING', message: 'Another bulk import of this store is still running', jobId: lock.holder });
    }
    try {
      if (!actor.staff) {
        await this.consumeDaily(actor.vendorId, selected.length);
      }
      const now = new Date().toISOString();
      await this.store.saveItems(
        jobId,
        selected.map((item) => ({ ...item, status: 'PENDING', code: null, message: null, notes: [], updatedAt: now })),
      );
      await this.store.clearCancel(jobId);
      await this.store.saveMeta({ ...meta, options, actorId: actor.actorId, staff: actor.staff, status: 'RUNNING', finishedAt: null, heartbeatAt: now, updatedAt: now });
    } catch (error) {
      await this.store.releaseLock(actor.vendorId, jobId);
      throw error;
    }

    this.launch(jobId, actor.vendorId, selected.map((item) => item.index));
    this.logger.log(`Bulk import ${jobId} re-queued ${selected.length} item(s) by ${actor.actorId}`);
    return this.view(jobId);
  }

  /** Stops a running job after the items in progress; unprocessed items stay PENDING (resumable). */
  async cancel(actor: BulkActor, jobId: string): Promise<BulkJobView> {
    const meta = await this.requireJob(actor, jobId);
    if (meta.status !== 'RUNNING') {
      throw new ConflictException({ statusCode: 409, error: 'Conflict', code: 'BULK_JOB_NOT_RUNNING', message: 'The job is not running' });
    }
    await this.store.requestCancel(jobId);
    return this.view(jobId);
  }

  // ─── Queries ────────────────────────────────────────────────────────────

  async get(actor: BulkActor, jobId: string): Promise<BulkJobView> {
    await this.requireJob(actor, jobId);
    return this.view(jobId);
  }

  async latest(actor: BulkActor): Promise<BulkJobView | null> {
    const jobId = await this.store.latestJobId(actor.vendorId);
    if (jobId === null) return null;
    const meta = await this.store.getMeta(jobId);
    if (meta === null || meta.vendorId !== actor.vendorId) return null;
    await this.detectInterruption(meta);
    return this.view(jobId);
  }

  // ─── Runner ─────────────────────────────────────────────────────────────

  private launch(jobId: string, vendorId: string, indexes: number[] | null): void {
    const state: RunState = { vendorId, stopping: false };
    this.running.set(jobId, state);
    void this.run(jobId, state, indexes)
      .catch(async (error: unknown) => {
        this.logger.error(`Bulk import ${jobId} crashed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
        await this.finish(jobId, 'INTERRUPTED').catch(() => undefined);
      })
      .finally(() => {
        this.running.delete(jobId);
        void this.store.releaseLock(vendorId, jobId).catch(() => undefined);
      });
  }

  private async run(jobId: string, state: RunState, indexes: number[] | null): Promise<void> {
    const initial = await this.store.getMeta(jobId);
    if (initial === null) return;
    const now = new Date().toISOString();
    await this.store.saveMeta({ ...initial, status: 'RUNNING', runs: initial.runs + 1, heartbeatAt: now, updatedAt: now });

    const heartbeat = setInterval(() => {
      void this.beat(jobId, state.vendorId);
    }, HEARTBEAT_INTERVAL_MS);
    heartbeat.unref();

    try {
      const items = await this.store.getItems(jobId);
      const queue = items
        .filter((item) => (indexes === null ? item.status === 'PENDING' : indexes.includes(item.index)))
        .map((item) => item.index);
      let nextSlot = 0;
      const gate = async (): Promise<void> => {
        const now = Date.now();
        const wait = Math.max(0, nextSlot - now);
        nextSlot = Math.max(now, nextSlot) + BULK_REQUEST_SPACING_MS;
        if (wait > 0) await sleep(wait);
      };
      let cancelled = false;
      const worker = async (): Promise<void> => {
        for (;;) {
          if (state.stopping || cancelled) return;
          if (await this.store.isCancelRequested(jobId)) {
            cancelled = true;
            return;
          }
          const index = queue.shift();
          if (index === undefined) return;
          const meta = await this.store.getMeta(jobId);
          const item = await this.store.getItem(jobId, index);
          if (meta === null || item === null) return;
          await this.processItem(meta, item, gate);
        }
      };
      await Promise.all(Array.from({ length: Math.min(BULK_CONCURRENCY, Math.max(queue.length, 1)) }, () => worker()));

      if (state.stopping) {
        await this.finish(jobId, 'INTERRUPTED');
      } else if (cancelled) {
        await this.finish(jobId, 'CANCELLED');
      } else {
        await this.finish(jobId, 'COMPLETED');
      }
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async beat(jobId: string, vendorId: string): Promise<void> {
    try {
      const meta = await this.store.getMeta(jobId);
      if (meta === null || meta.status !== 'RUNNING') return;
      const now = new Date().toISOString();
      await this.store.saveMeta({ ...meta, heartbeatAt: now, updatedAt: now });
      await this.store.refreshLock(vendorId, jobId);
    } catch (error) {
      this.logger.warn(`Bulk import ${jobId} heartbeat failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async finish(jobId: string, status: BulkJobStatus): Promise<void> {
    const meta = await this.store.getMeta(jobId);
    if (meta === null) return;
    const now = new Date().toISOString();
    if (status !== 'COMPLETED') {
      // Items caught mid-flight go back to the queue; their next run starts them over.
      const items = await this.store.getItems(jobId);
      await this.store.saveItems(
        jobId,
        items
          .filter((item) => item.status === 'PROCESSING')
          .map((item) => ({ ...item, status: 'PENDING', code: 'INTERRUPTED', message: 'Stopped before this item finished', updatedAt: now })),
      );
    }
    await this.store.saveMeta({ ...meta, status, finishedAt: now, updatedAt: now });
    const counts = countItems(await this.store.getItems(jobId));
    this.logger.log(
      `Bulk import ${jobId} ${status}: ${counts.succeeded} created, ${counts.skipped} skipped, ${counts.needsReview} need review, ${counts.failed} failed, ${counts.pending} pending`,
    );
  }

  /**
   * One page → one product. Order matters: the cheap checks (duplicate,
   * extraction, price/unit/category, DTO validation) run before images are
   * downloaded, so a page that cannot become a product leaves no files behind.
   */
  private async processItem(meta: BulkJobMeta, item: BulkItem, gate: () => Promise<void>): Promise<void> {
    const save = async (patch: Partial<BulkItem>): Promise<void> => {
      Object.assign(item, patch, { updatedAt: new Date().toISOString() });
      await this.store.saveItem(meta.id, item);
    };
    await save({ status: 'PROCESSING', attempts: item.attempts + 1, code: null, message: null, notes: [] });

    try {
      const sku = importSku(meta.vendorId, item.url);
      const existing = await this.prisma.productVariant.findFirst({
        where: { sku },
        select: { price: true, product: { select: { id: true, slug: true, title: true, isPublished: true, vendorId: true } } },
      });
      if (existing !== null) {
        await save({
          status: 'SKIPPED',
          code: 'ALREADY_IMPORTED',
          message: 'This store already has a product imported from this page',
          title: existing.product.title,
          price: Number(existing.price),
          product: { id: existing.product.id, slug: existing.product.slug, isPublished: existing.product.isPublished },
        });
        return;
      }

      await gate();
      let extracted: ExtractedProduct;
      try {
        extracted = await this.importer.extractProduct(this.importer.validateUrl(item.url));
      } catch (error) {
        if (error instanceof ImportError) {
          await save({ status: 'FAILED', code: `IMPORT_${error.code}`, message: error.message });
          return;
        }
        throw error;
      }

      const categoryId = (await this.importer.matchCategory(extracted.categoryCandidates)) ?? meta.options.defaultCategoryId;
      const draft = buildProductDraft({ product: extracted, sku, categoryId, options: meta.options });
      if (draft.kind === 'review') {
        await save({ status: 'NEEDS_REVIEW', code: draft.code, message: draft.message, title: extracted.title });
        return;
      }
      const problems = await draftProblems(draft.dto);
      if (problems.length > 0) {
        await save({ status: 'FAILED', code: 'INVALID_DRAFT', message: problems.slice(0, 5).join('; '), title: extracted.title, price: draft.priceIrr });
        return;
      }

      const mediaIds: string[] = [];
      let thumbnail: string | null = null;
      let imageFailures = 0;
      for (const imageUrl of extracted.imageUrls.slice(0, MAX_BULK_IMAGES_PER_PRODUCT)) {
        let parsed: URL;
        try {
          parsed = this.importer.validateUrl(imageUrl);
        } catch {
          imageFailures += 1;
          continue;
        }
        const stored = await this.importer.ingestOne(meta.ownerUserId, imageUrl, parsed);
        if ('id' in stored) {
          mediaIds.push(stored.id);
          thumbnail ??= stored.thumbnailUrl;
        } else {
          imageFailures += 1;
        }
      }
      draft.dto.mediaIds = mediaIds;

      const created = await this.products.create(meta.ownerUserId, draft.dto, {
        actorId: meta.actorId,
        context: { ipAddress: null, userAgent: `shagerdam-bulk-importer (job ${meta.id})` },
      });
      const notes: BulkItemNote[] = [];
      const remarks: string[] = [];
      if (mediaIds.length === 0) {
        notes.push('NO_IMAGE');
        remarks.push('no image could be imported');
      } else if (imageFailures > 0) {
        notes.push('SOME_IMAGES_FAILED');
        remarks.push(`${imageFailures} image(s) could not be imported`);
      }
      if (!draft.inStock) {
        notes.push('OUT_OF_STOCK');
        remarks.push('out of stock at the source — stock set to 0');
      }
      await save({
        status: 'SUCCEEDED',
        code: null,
        message: remarks.length > 0 ? remarks.join('; ') : null,
        notes,
        title: created.title,
        imageUrl: thumbnail,
        price: draft.priceIrr,
        product: { id: created.id, slug: created.slug, isPublished: created.isPublished },
      });
    } catch (error) {
      if (error instanceof HttpException) {
        await save({ status: 'FAILED', code: `HTTP_${error.getStatus()}`, message: httpMessage(error) });
        return;
      }
      this.logger.error(`Bulk import ${meta.id} item ${item.index} (${item.url}) failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      await save({ status: 'FAILED', code: 'INTERNAL', message: 'Unexpected server error while importing this page' });
    }
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  /** Deploy/restart: stop taking items and hand the jobs over as INTERRUPTED (resumable). */
  async onApplicationShutdown(): Promise<void> {
    const jobs = [...this.running.entries()];
    for (const [, state] of jobs) state.stopping = true;
    await Promise.all(
      jobs.map(async ([jobId, state]) => {
        await this.finish(jobId, 'INTERRUPTED').catch(() => undefined);
        await this.store.releaseLock(state.vendorId, jobId).catch(() => undefined);
      }),
    );
  }

  // ─── Helpers ────────────────────────────────────────────────────────────

  private async requireJob(actor: BulkActor, jobId: string): Promise<BulkJobMeta> {
    const meta = await this.store.getMeta(jobId);
    if (meta === null || meta.vendorId !== actor.vendorId) {
      throw new NotFoundException('Bulk import job not found');
    }
    return (await this.detectInterruption(meta)) ?? meta;
  }

  /** A RUNNING job whose runner is gone (stale heartbeat, not running here) becomes INTERRUPTED. */
  private async detectInterruption(meta: BulkJobMeta): Promise<BulkJobMeta | null> {
    if (meta.status !== 'RUNNING' || this.running.has(meta.id)) return null;
    if (Date.now() - Date.parse(meta.heartbeatAt) < STALE_AFTER_MS) return null;
    this.logger.warn(`Bulk import ${meta.id} lost its runner (last heartbeat ${meta.heartbeatAt}); marking INTERRUPTED`);
    await this.finish(meta.id, 'INTERRUPTED');
    await this.store.releaseLock(meta.vendorId, meta.id);
    return this.store.getMeta(meta.id);
  }

  private async view(jobId: string): Promise<BulkJobView> {
    const meta = await this.store.getMeta(jobId);
    if (meta === null) throw new NotFoundException('Bulk import job not found');
    const items = await this.store.getItems(jobId);
    const counts = countItems(items);
    const processed = counts.succeeded + counts.skipped + counts.needsReview + counts.failed;
    return {
      id: meta.id,
      vendorId: meta.vendorId,
      staff: meta.staff,
      storeUrl: meta.storeUrl,
      options: meta.options,
      status: meta.status,
      total: meta.total,
      runs: meta.runs,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      finishedAt: meta.finishedAt,
      counts,
      processed,
      progressPercent: meta.total === 0 ? 100 : Math.round((processed / meta.total) * 100),
      items,
    };
  }

  private validateUrls(raw: string[]): string[] {
    const urls: string[] = [];
    const seen = new Set<string>();
    for (const value of raw) {
      let parsed: URL;
      try {
        parsed = this.importer.validateUrl(value);
      } catch (error) {
        const reason = error instanceof ImportError ? error.message : 'invalid URL';
        throw new BadRequestException({ statusCode: 400, error: 'Bad Request', code: 'BULK_INVALID_URL', message: `${value.slice(0, 200)}: ${reason}` });
      }
      const canonical = canonicalProductUrl(parsed.toString()) ?? parsed.toString();
      if (!seen.has(canonical)) {
        seen.add(canonical);
        urls.push(canonical);
      }
    }
    if (urls.length === 0) throw new BadRequestException('Send at least one product URL');
    if (urls.length > MAX_BULK_URLS) throw new BadRequestException(`At most ${MAX_BULK_URLS} product URLs per job`);
    return urls;
  }

  private async assertCategory(categoryId: string | null): Promise<void> {
    if (categoryId === null) return;
    const visible = new Set(await this.categories.visibleCategoryIds());
    if (!visible.has(categoryId)) {
      throw new BadRequestException('defaultCategoryId does not reference an active category');
    }
  }

  private assertCapacity(): void {
    if (this.running.size >= MAX_RUNNING_JOBS_PER_INSTANCE) {
      throw new HttpException(
        { statusCode: 503, error: 'Service Unavailable', code: 'BULK_BUSY', message: 'The importer is busy with other stores; try again in a few minutes' },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }

  private async consumeDaily(vendorId: string, amount: number): Promise<void> {
    await this.consume(bulkKeys.daily(vendorId), amount, BULK_DAILY_LIMIT, BULK_DAILY_WINDOW_SECONDS, (left) =>
      `A store can bulk-import at most ${BULK_DAILY_LIMIT} products per 24 hours (${left} left)`,
    );
  }

  /** Fixed-window quota: `amount` units charged at once, refunded when over the limit. */
  private async consume(key: string, amount: number, limit: number, windowSeconds: number, message: string | ((left: number) => string)): Promise<void> {
    const count = await this.redis.client.incrby(key, amount);
    if (count === amount) await this.redis.client.expire(key, windowSeconds);
    if (count > limit) {
      await this.redis.client.decrby(key, amount);
      const ttl = await this.redis.client.ttl(key);
      const left = Math.max(0, limit - (count - amount));
      throw new TooManyRequestsException(typeof message === 'string' ? message : message(left), ttl > 0 ? ttl : windowSeconds);
    }
  }
}

export function countItems(items: BulkItem[]): BulkJobCounts {
  const counts: BulkJobCounts = { pending: 0, processing: 0, succeeded: 0, skipped: 0, needsReview: 0, failed: 0 };
  for (const item of items) {
    switch (item.status) {
      case 'PENDING':
        counts.pending += 1;
        break;
      case 'PROCESSING':
        counts.processing += 1;
        break;
      case 'SUCCEEDED':
        counts.succeeded += 1;
        break;
      case 'SKIPPED':
        counts.skipped += 1;
        break;
      case 'NEEDS_REVIEW':
        counts.needsReview += 1;
        break;
      case 'FAILED':
        counts.failed += 1;
        break;
    }
  }
  return counts;
}

function emptyItem(index: number, url: string, now: string): BulkItem {
  return { index, url, status: 'PENDING', attempts: 0, code: null, message: null, notes: [], title: null, imageUrl: null, price: null, product: null, updatedAt: now };
}

function httpMessage(error: HttpException): string {
  const response = error.getResponse();
  if (typeof response === 'object' && response !== null && 'message' in response) {
    const message: unknown = response.message;
    return Array.isArray(message) ? message.map(String).join('; ') : String(message);
  }
  return error.message;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Upper bound for `defaultStock` (mirrors the variant DTO). */
export const MAX_DEFAULT_STOCK = MAX_STOCK;
