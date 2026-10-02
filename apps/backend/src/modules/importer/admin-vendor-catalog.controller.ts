import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiServiceUnavailableResponse,
  ApiUnprocessableEntityResponse,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { ClientContext, CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import type { RequestContext } from '../../common/types/request-context';
import { setAuditSnapshot } from '../audit/audit-context';
import { Auditable, SkipAudit } from '../audit/audit.decorator';
import { CreateProductDto } from '../products/dto/product-input.dto';
import { VendorProductDetailDto } from '../products/dto/product-response.dto';
import { ProductsService } from '../products/products.service';
import { VendorsService } from '../vendors/vendors.service';
import { ExtractSpecDto, ExtractSpecResponseDto, IngestImagesDto, IngestImagesResponseDto } from './dto/import.dto';
import { ProductImporterService } from './product-importer.service';
import { bulkStartInput, crawlAuditSnapshot } from './bulk/bulk-audit';
import { BulkImportService, type BulkActor } from './bulk/bulk-import.service';
import {
  BulkExtractDto,
  BulkExtractResponseDto,
  BulkJobDto,
  CrawlStoreDto,
  CrawlStoreResponseDto,
  LatestBulkJobDto,
  RetryBulkJobDto,
} from './dto/bulk-import.dto';

/**
 * Staff catalogue work on behalf of a store (`SUPER_ADMIN` / `ADMIN`): the same
 * importer and product-creation logic a vendor uses, executed in the name of
 * the store owner — imported images belong to the owner's media library, the
 * product to the store — while every audit row names the administrator as the
 * actor. The store must be `APPROVED` (enforced by the reused services).
 */
@ApiTags('admin-vendor-catalog')
@ApiBearerAuth('access-token')
@Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
@ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
@ApiForbiddenResponse({ description: 'Not SUPER_ADMIN/ADMIN, or the store is not APPROVED' })
@ApiNotFoundResponse({ description: 'Vendor not found' })
@Controller('admin/vendors/:vendorId/products')
export class AdminVendorCatalogController {
  constructor(
    private readonly vendors: VendorsService,
    private readonly importer: ProductImporterService,
    private readonly products: ProductsService,
    private readonly bulk: BulkImportService,
  ) {}

  /** Staff act for the store: products/images belong to the owner, the audit actor is the admin; no store quotas. */
  private async staffActor(vendorId: string, user: AuthenticatedUser): Promise<BulkActor> {
    const ownerUserId = await this.vendors.ownerUserIdOf(vendorId);
    return { vendorId, ownerUserId, actorId: user.id, staff: true };
  }

  @Post('import/extract-spec')
  @HttpCode(HttpStatus.OK)
  @Auditable({ entityName: 'ProductImport' })
  @ApiOperation({ summary: 'Read a product page (Digikala or schema.org) into a draft for this store', description: 'Same behaviour and limits as POST /vendor/products/import/extract-spec; the quota is the store’s.' })
  @ApiOkResponse({ type: ExtractSpecResponseDto })
  @ApiBadRequestResponse({ description: 'Invalid or blocked URL' })
  async extractSpec(
    @Param('vendorId', new ParseUUIDPipe()) vendorId: string,
    @Body() dto: ExtractSpecDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: unknown,
  ): Promise<ExtractSpecResponseDto> {
    const ownerId = await this.vendors.ownerUserIdOf(vendorId);
    const draft = await this.importer.extract(ownerId, dto.url);
    setAuditSnapshot(request, {
      actorId: user.id,
      newValue: { vendorId, url: dto.url, source: draft.source, sourceUrl: draft.sourceUrl, specificationCount: draft.specifications.length, imageCount: draft.imageUrls.length },
    });
    return draft;
  }

  @Post('import/ingest-images')
  @HttpCode(HttpStatus.OK)
  @Auditable({ entityName: 'MediaAsset' })
  @ApiOperation({ summary: 'Download remote images into the store owner’s media library (WebP + thumbnail)' })
  @ApiOkResponse({ type: IngestImagesResponseDto })
  @ApiBadRequestResponse({ description: 'Validation failed, or one of the URLs is invalid/private/internal' })
  async ingestImages(
    @Param('vendorId', new ParseUUIDPipe()) vendorId: string,
    @Body() dto: IngestImagesDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: unknown,
  ): Promise<IngestImagesResponseDto> {
    const ownerId = await this.vendors.ownerUserIdOf(vendorId);
    const result = await this.importer.ingestImages(ownerId, dto.imageUrls);
    setAuditSnapshot(request, {
      actorId: user.id,
      newValue: {
        vendorId,
        purpose: 'product_image',
        imported: result.items.map((item) => ({ id: item.id, sourceUrl: item.sourceUrl })),
        failed: result.failures.map((failure) => ({ sourceUrl: failure.sourceUrl, code: failure.code })),
      },
    });
    return result;
  }

  /** `@SkipAudit()`: `ProductsService.create` writes the audit row (actor = this admin) inside its transaction. */
  @Post()
  @SkipAudit()
  @ApiOperation({
    summary: 'Create (and optionally publish) a product for this store',
    description: 'Identical validation to POST /vendor/products. mediaIds must be images of the store owner (e.g. from import/ingest-images above).',
  })
  @ApiCreatedResponse({ type: VendorProductDetailDto })
  @ApiBadRequestResponse({ description: 'Validation failed (prices, matrix, category, media, slug)' })
  @ApiConflictResponse({ description: 'SKU or slug already taken' })
  async create(
    @Param('vendorId', new ParseUUIDPipe()) vendorId: string,
    @Body() dto: CreateProductDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientContext() context: RequestContext,
  ): Promise<VendorProductDetailDto> {
    const ownerId = await this.vendors.ownerUserIdOf(vendorId);
    return this.products.create(ownerId, dto, { actorId: user.id, context });
  }

  // ─── Whole-store import on behalf of the store ──────────────────────────

  @Post('import/crawl-store')
  @HttpCode(HttpStatus.OK)
  @Auditable({ entityName: 'ProductImport' })
  @ApiOperation({ summary: 'Find the product pages of a site for this store (sitemaps or pasted text)', description: 'Same behaviour as POST /vendor/products/import/crawl-store, without the store’s hourly quota.' })
  @ApiOkResponse({ type: CrawlStoreResponseDto })
  @ApiUnprocessableEntityResponse({ description: 'No product page found (code IMPORT_NO_PRODUCTS_FOUND)' })
  async crawlStore(
    @Param('vendorId', new ParseUUIDPipe()) vendorId: string,
    @Body() dto: CrawlStoreDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: unknown,
  ): Promise<CrawlStoreResponseDto> {
    const result = await this.bulk.crawl(await this.staffActor(vendorId, user), dto);
    setAuditSnapshot(request, { actorId: user.id, newValue: { vendorId, ...crawlAuditSnapshot(dto, result) } });
    return result;
  }

  @Post('import/bulk-extract')
  @HttpCode(HttpStatus.ACCEPTED)
  @Auditable({ entityName: 'ProductImport' })
  @ApiOperation({ summary: 'Start a background bulk import for this store', description: 'Same behaviour as POST /vendor/products/import/bulk-extract; staff are not subject to the store’s daily limit.' })
  @ApiAcceptedResponse({ type: BulkExtractResponseDto })
  @ApiConflictResponse({ description: 'Another bulk job of this store is running (code BULK_JOB_RUNNING)' })
  @ApiServiceUnavailableResponse({ description: 'The importer is busy (code BULK_BUSY)' })
  async bulkExtract(
    @Param('vendorId', new ParseUUIDPipe()) vendorId: string,
    @Body() dto: BulkExtractDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: unknown,
  ): Promise<BulkExtractResponseDto> {
    const started = await this.bulk.start(await this.staffActor(vendorId, user), bulkStartInput(dto));
    setAuditSnapshot(request, { actorId: user.id, newValue: { vendorId, jobId: started.jobId, totalProducts: started.totalProducts, storeUrl: dto.storeUrl ?? null, autoPublish: dto.autoPublish ?? true } });
    return started;
  }

  @Get('import/bulk-jobs/latest')
  @ApiOperation({ summary: 'This store’s most recent bulk job' })
  @ApiOkResponse({ type: LatestBulkJobDto })
  async latestBulkJob(@Param('vendorId', new ParseUUIDPipe()) vendorId: string, @CurrentUser() user: AuthenticatedUser): Promise<LatestBulkJobDto> {
    return { job: await this.bulk.latest(await this.staffActor(vendorId, user)) };
  }

  @Get('import/bulk-jobs/:jobId')
  @ApiOperation({ summary: 'Progress and per-item result of a bulk job of this store' })
  @ApiOkResponse({ type: BulkJobDto })
  async bulkJob(
    @Param('vendorId', new ParseUUIDPipe()) vendorId: string,
    @Param('jobId', new ParseUUIDPipe()) jobId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<BulkJobDto> {
    return this.bulk.get(await this.staffActor(vendorId, user), jobId);
  }

  @Post('import/bulk-jobs/:jobId/retry')
  @HttpCode(HttpStatus.ACCEPTED)
  @Auditable({ entityName: 'ProductImport', entityIdParam: 'jobId' })
  @ApiOperation({ summary: 'Resume / retry failed items of a bulk job of this store' })
  @ApiAcceptedResponse({ type: BulkJobDto })
  async retryBulkJob(
    @Param('vendorId', new ParseUUIDPipe()) vendorId: string,
    @Param('jobId', new ParseUUIDPipe()) jobId: string,
    @Body() dto: RetryBulkJobDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: unknown,
  ): Promise<BulkJobDto> {
    const job = await this.bulk.retry(await this.staffActor(vendorId, user), jobId, dto);
    setAuditSnapshot(request, { actorId: user.id, newValue: { vendorId, jobId, itemIndexes: dto.itemIndexes ?? 'all-retryable', options: job.options } });
    return job;
  }

  @Post('import/bulk-jobs/:jobId/cancel')
  @HttpCode(HttpStatus.OK)
  @Auditable({ entityName: 'ProductImport', entityIdParam: 'jobId' })
  @ApiOperation({ summary: 'Stop a running bulk job of this store' })
  @ApiOkResponse({ type: BulkJobDto })
  async cancelBulkJob(
    @Param('vendorId', new ParseUUIDPipe()) vendorId: string,
    @Param('jobId', new ParseUUIDPipe()) jobId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: unknown,
  ): Promise<BulkJobDto> {
    const job = await this.bulk.cancel(await this.staffActor(vendorId, user), jobId);
    setAuditSnapshot(request, { actorId: user.id, newValue: { vendorId, jobId, cancelRequested: true } });
    return job;
  }
}
