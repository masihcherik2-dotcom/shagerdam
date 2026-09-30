import type { CrawlStoreResult } from '../crawler/store-crawler.service';
import type { BulkExtractDto, CrawlStoreDto } from '../dto/bulk-import.dto';
import type { StartBulkInput } from './bulk-import.service';

/**
 * Audit result of a store scan: what was found, and how much text was pasted.
 * (The request body itself is recorded by the audit interceptor, which caps
 * every string at 2,000 characters — a pasted sitemap of up to 900 KB costs
 * the audit table only its first 2 KB.)
 */
export function crawlAuditSnapshot(dto: CrawlStoreDto, result: CrawlStoreResult): Record<string, unknown> {
  return {
    storeUrl: dto.storeUrl ?? null,
    pastedContentLength: dto.sitemapContent?.length ?? 0,
    maxProducts: dto.maxProducts ?? null,
    totalFound: result.totalFound,
    returned: result.productUrls.length,
    sitemapsScanned: result.sitemapsScanned.slice(0, 25),
  };
}

export function bulkStartInput(dto: BulkExtractDto): StartBulkInput {
  return {
    urls: dto.urls,
    storeUrl: dto.storeUrl ?? null,
    autoPublish: dto.autoPublish,
    priceUnit: dto.priceUnit,
    defaultStock: dto.defaultStock,
    defaultCategoryId: dto.defaultCategoryId,
  };
}
