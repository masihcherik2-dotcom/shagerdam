import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiServiceUnavailableResponse,
  ApiBadGatewayResponse,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiGatewayTimeoutResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { setAuditSnapshot } from '../audit/audit-context';
import { Auditable } from '../audit/audit.decorator';
import {
  ExtractSpecDto,
  ExtractSpecResponseDto,
  IngestImagesDto,
  IngestImagesResponseDto,
} from './dto/import.dto';
import { ProductImporterService } from './product-importer.service';
import { BulkImportService } from './bulk/bulk-import.service';
import {
  BulkExtractDto,
  BulkExtractResponseDto,
  BulkJobDto,
  CrawlStoreDto,
  CrawlStoreResponseDto,
  LatestBulkJobDto,
  RetryBulkJobDto,
} from './dto/bulk-import.dto';
import { bulkStartInput, crawlAuditSnapshot } from './bulk/bulk-audit';

/**
 * Product importer for vendors: read a product page into a draft, and pull its
 * images into the media pipeline. `VENDOR` role only, and the store must be
 * `APPROVED`.
 *
 * Both calls are audited with the source URL/hosts, so the origin of imported
 * text and images stays traceable (content-rights questions are answered from
 * the audit trail).
 */
@ApiTags('vendor-product-import')
@ApiBearerAuth('access-token')
@Roles(UserRole.VENDOR)
@ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
@ApiForbiddenResponse({ description: 'Not a vendor, or the store is not APPROVED' })
@ApiTooManyRequestsResponse({ description: 'Per-vendor import quota exhausted (see retryAfterSeconds)' })
@Controller('vendor/products/import')
export class VendorProductImportController {
  constructor(
    private readonly importer: ProductImporterService,
    private readonly bulk: BulkImportService,
  ) {}

  @Post('extract-spec')
  @HttpCode(HttpStatus.OK)
  @Auditable({ entityName: 'ProductImport' })
  @ApiOperation({
    summary: 'Read a product page into a draft (title, brand, description, specifications, image URLs)',
    description:
      'Digikala product URLs are read through Digikala’s public product API (full specification table and gallery); ' +
      'any other URL is parsed for schema.org Product JSON-LD, product microdata, WooCommerce attribute tables and ' +
      'OpenGraph tags. SSRF-guarded: http/https on ports 80/443, private/loopback/link-local/reserved targets are ' +
      'refused (also after DNS resolution and on every redirect); 10 s timeout; nothing is persisted.',
  })
  @ApiOkResponse({ type: ExtractSpecResponseDto })
  @ApiBadRequestResponse({ description: 'Invalid URL, or a private/internal/reserved target (code IMPORT_INVALID_URL / IMPORT_BLOCKED_TARGET)' })
  @ApiUnprocessableEntityResponse({ description: 'Not a product page, product not found, unsupported content or too large (code IMPORT_NOT_A_PRODUCT / IMPORT_NOT_FOUND / IMPORT_UNSUPPORTED_CONTENT / IMPORT_TOO_LARGE)' })
  @ApiBadGatewayResponse({ description: 'The source site failed (code IMPORT_NETWORK / IMPORT_UPSTREAM_STATUS / IMPORT_TOO_MANY_REDIRECTS)' })
  @ApiGatewayTimeoutResponse({ description: 'The source site did not answer within 10 seconds (code IMPORT_TIMEOUT)' })
  async extractSpec(
    @Body() dto: ExtractSpecDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: unknown,
  ): Promise<ExtractSpecResponseDto> {
    const draft = await this.importer.extract(user.id, dto.url);
    setAuditSnapshot(request, {
      actorId: user.id,
      newValue: {
        url: dto.url,
        source: draft.source,
        sourceUrl: draft.sourceUrl,
        strategies: draft.strategies,
        specificationCount: draft.specifications.length,
        imageCount: draft.imageUrls.length,
      },
    });
    return draft;
  }

  @Post('ingest-images')
  @HttpCode(HttpStatus.OK)
  @Auditable({ entityName: 'MediaAsset' })
  @ApiOperation({
    summary: 'Download remote images into the media pipeline (WebP + thumbnail) for a product gallery',
    description:
      'Each image is fetched (SSRF-guarded, 10 s, size-capped at the image upload limit) and processed exactly like ' +
      'POST /media/upload/image with purpose product_image. The returned ids go into mediaIds of POST /vendor/products. ' +
      'An invalid or internal URL rejects the whole request; a failing download is reported in failures while the others are stored.',
  })
  @ApiOkResponse({ type: IngestImagesResponseDto })
  @ApiBadRequestResponse({ description: 'Validation failed, or one of the URLs is invalid/private/internal' })
  async ingestImages(
    @Body() dto: IngestImagesDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: unknown,
  ): Promise<IngestImagesResponseDto> {
    const result = await this.importer.ingestImages(user.id, dto.imageUrls);
    setAuditSnapshot(request, {
      actorId: user.id,
      newValue: {
        purpose: 'product_image',
        imported: result.items.map((item) => ({ id: item.id, sourceUrl: item.sourceUrl })),
        failed: result.failures.map((failure) => ({ sourceUrl: failure.sourceUrl, code: failure.code })),
      },
    });
    return result;
  }

  // ─── Whole-store import (sitemap crawl + background bulk job) ───────────

  @Post('crawl-store')
  @HttpCode(HttpStatus.OK)
  @Auditable({ entityName: 'ProductImport' })
  @ApiOperation({
    summary: 'Find the product pages of a store from its sitemaps (or from pasted sitemap text / links)',
    description:
      'Reads robots.txt Sitemap lines, then /sitemap_index.xml, /sitemap.xml, /product-sitemap.xml and /wp-sitemap.xml; expands ' +
      'sitemap indexes (product sitemaps first) and keeps pages of the same site whose path is a product path (/product/, /products/, /dkp-) ' +
      'or that come from a product sitemap. At most 25 documents and 40 s per scan; SSRF-guarded. Geo-IP fallback: send sitemapContent ' +
      '(pasted XML or links) instead of fetching. Quota: 20 scans per store per hour.',
  })
  @ApiOkResponse({ type: CrawlStoreResponseDto })
  @ApiBadRequestResponse({ description: 'Invalid or internal address, or neither storeUrl nor sitemapContent sent' })
  @ApiUnprocessableEntityResponse({ description: 'No product page found (code IMPORT_NO_PRODUCTS_FOUND) — paste the sitemap or links instead' })
  async crawlStore(@Body() dto: CrawlStoreDto, @CurrentUser() user: AuthenticatedUser, @Req() request: unknown): Promise<CrawlStoreResponseDto> {
    const actor = await this.bulk.vendorActor(user.id);
    const result = await this.bulk.crawl(actor, dto);
    setAuditSnapshot(request, { actorId: user.id, newValue: crawlAuditSnapshot(dto, result) });
    return result;
  }

  @Post('bulk-extract')
  @HttpCode(HttpStatus.ACCEPTED)
  @Auditable({ entityName: 'ProductImport' })
  @ApiOperation({
    summary: 'Start a background job importing many product pages as products of this store',
    description:
      'Returns { jobId, totalProducts } at once; poll GET bulk-jobs/{jobId}. Pages are processed 3 at a time (≥ 0.5 s between page ' +
      'requests); each becomes a product (unpublished unless autoPublish) with up to 6 images, or is reported as SKIPPED (already imported), ' +
      'NEEDS_REVIEW (no price, unknown unit or no category) or FAILED. One running job per store; 400 products per store per 24 h.',
  })
  @ApiAcceptedResponse({ type: BulkExtractResponseDto })
  @ApiBadRequestResponse({ description: 'Validation failed, an invalid/internal URL (code BULK_INVALID_URL), or an inactive defaultCategoryId' })
  @ApiConflictResponse({ description: 'Another bulk job of this store is running (code BULK_JOB_RUNNING, jobId)' })
  @ApiServiceUnavailableResponse({ description: 'The importer is busy (code BULK_BUSY)' })
  async bulkExtract(@Body() dto: BulkExtractDto, @CurrentUser() user: AuthenticatedUser, @Req() request: unknown): Promise<BulkExtractResponseDto> {
    const actor = await this.bulk.vendorActor(user.id);
    const started = await this.bulk.start(actor, bulkStartInput(dto));
    setAuditSnapshot(request, { actorId: user.id, newValue: { jobId: started.jobId, totalProducts: started.totalProducts, storeUrl: dto.storeUrl ?? null, autoPublish: dto.autoPublish ?? false, priceUnit: dto.priceUnit ?? 'AUTO' } });
    return started;
  }

  @Get('bulk-jobs/latest')
  @ApiOperation({ summary: 'The store’s most recent bulk job (to restore the panel after the window was closed)' })
  @ApiOkResponse({ type: LatestBulkJobDto })
  async latestBulkJob(@CurrentUser() user: AuthenticatedUser): Promise<LatestBulkJobDto> {
    const actor = await this.bulk.vendorActor(user.id);
    return { job: await this.bulk.latest(actor) };
  }

  @Get('bulk-jobs/:jobId')
  @ApiOperation({ summary: 'Progress and per-item result of a bulk job (poll every 2 s while RUNNING)' })
  @ApiOkResponse({ type: BulkJobDto })
  @ApiNotFoundResponse({ description: 'No such job for this store' })
  async bulkJob(@Param('jobId', new ParseUUIDPipe()) jobId: string, @CurrentUser() user: AuthenticatedUser): Promise<BulkJobDto> {
    const actor = await this.bulk.vendorActor(user.id);
    return this.bulk.get(actor, jobId);
  }

  @Post('bulk-jobs/:jobId/retry')
  @HttpCode(HttpStatus.ACCEPTED)
  @Auditable({ entityName: 'ProductImport', entityIdParam: 'jobId' })
  @ApiOperation({
    summary: 'Resume an interrupted/cancelled job or retry its failed and needs-review items',
    description: 'Options sent here (e.g. defaultCategoryId, priceUnit) replace the job’s options for the re-run. Products already created are never duplicated.',
  })
  @ApiAcceptedResponse({ type: BulkJobDto })
  @ApiBadRequestResponse({ description: 'Nothing to retry (code BULK_NOTHING_TO_RETRY) or invalid options' })
  @ApiConflictResponse({ description: 'The job (or another job of the store) is running' })
  async retryBulkJob(
    @Param('jobId', new ParseUUIDPipe()) jobId: string,
    @Body() dto: RetryBulkJobDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: unknown,
  ): Promise<BulkJobDto> {
    const actor = await this.bulk.vendorActor(user.id);
    const job = await this.bulk.retry(actor, jobId, dto);
    setAuditSnapshot(request, { actorId: user.id, newValue: { jobId, itemIndexes: dto.itemIndexes ?? 'all-retryable', options: job.options } });
    return job;
  }

  @Post('bulk-jobs/:jobId/cancel')
  @HttpCode(HttpStatus.OK)
  @Auditable({ entityName: 'ProductImport', entityIdParam: 'jobId' })
  @ApiOperation({ summary: 'Stop a running job after the items in progress (the rest stay PENDING and can be resumed)' })
  @ApiOkResponse({ type: BulkJobDto })
  @ApiConflictResponse({ description: 'The job is not running (code BULK_JOB_NOT_RUNNING)' })
  async cancelBulkJob(@Param('jobId', new ParseUUIDPipe()) jobId: string, @CurrentUser() user: AuthenticatedUser, @Req() request: unknown): Promise<BulkJobDto> {
    const actor = await this.bulk.vendorActor(user.id);
    const job = await this.bulk.cancel(actor, jobId);
    setAuditSnapshot(request, { actorId: user.id, newValue: { jobId, cancelRequested: true } });
    return job;
  }
}
