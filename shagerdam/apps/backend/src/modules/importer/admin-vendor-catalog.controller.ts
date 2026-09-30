import { Body, Controller, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import {
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
  ) {}

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
}
