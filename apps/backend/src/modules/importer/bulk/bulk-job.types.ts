import type { DraftOptions } from './product-draft';

/**
 * - `RUNNING`: an API instance is processing the job (heartbeat fresh);
 * - `COMPLETED`: every queued item reached a final state;
 * - `CANCELLED`: stopped on request; untouched items stay `PENDING`;
 * - `INTERRUPTED`: the processing instance stopped (deploy/restart/crash) —
 *   detected by a stale heartbeat; resumable.
 */
export type BulkJobStatus = 'RUNNING' | 'COMPLETED' | 'CANCELLED' | 'INTERRUPTED';

/**
 * - `SUCCEEDED`: product created (published when the job said so);
 * - `SKIPPED`: this store already has a product imported from the page;
 * - `NEEDS_REVIEW`: page read, but price/unit/category is missing (see `code`);
 * - `FAILED`: the page could not be read or the product was rejected.
 */
export type BulkItemStatus = 'PENDING' | 'PROCESSING' | 'SUCCEEDED' | 'SKIPPED' | 'NEEDS_REVIEW' | 'FAILED';

export const RETRYABLE_STATUSES: ReadonlySet<BulkItemStatus> = new Set(['PENDING', 'PROCESSING', 'FAILED', 'NEEDS_REVIEW']);

export interface BulkJobMeta {
  id: string;
  vendorId: string;
  /** Store owner: products and images belong to this user. */
  ownerUserId: string;
  /** Who started the job (vendor or staff) — the actor on every product audit row. */
  actorId: string;
  staff: boolean;
  storeUrl: string | null;
  options: DraftOptions;
  status: BulkJobStatus;
  total: number;
  /** Number of processing runs (1 + retries/resumes). */
  runs: number;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  heartbeatAt: string;
}

/** Remarks on a created product that the vendor should know about (machine-readable; the UI translates them). */
export const BULK_ITEM_NOTES = ['NO_IMAGE', 'SOME_IMAGES_FAILED', 'OUT_OF_STOCK'] as const;
export type BulkItemNote = (typeof BULK_ITEM_NOTES)[number];

export interface BulkItemProduct {
  id: string;
  slug: string;
  isPublished: boolean;
}

export interface BulkItem {
  index: number;
  url: string;
  status: BulkItemStatus;
  attempts: number;
  /** Machine-readable reason for SKIPPED / NEEDS_REVIEW / FAILED (e.g. `IMPORT_TIMEOUT`, `NO_PRICE`). */
  code: string | null;
  /** Human-readable detail (English; the UI translates known codes). */
  message: string | null;
  /** Remarks on a SUCCEEDED item (empty otherwise). */
  notes: BulkItemNote[];
  title: string | null;
  /** Thumbnail of the first imported image (our media URL). */
  imageUrl: string | null;
  /** Selling price in IRR. */
  price: number | null;
  product: BulkItemProduct | null;
  updatedAt: string;
}

export interface BulkJobCounts {
  pending: number;
  processing: number;
  succeeded: number;
  skipped: number;
  needsReview: number;
  failed: number;
}

export interface BulkJobView extends Omit<BulkJobMeta, 'ownerUserId' | 'actorId' | 'heartbeatAt'> {
  counts: BulkJobCounts;
  /** Items in a final state (everything except PENDING/PROCESSING). */
  processed: number;
  progressPercent: number;
  items: BulkItem[];
}
