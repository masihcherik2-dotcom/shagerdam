import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
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
import { SkipAudit } from '../audit/audit.decorator';
import { CreateProductDto, CreateVariantDto, UpdateProductDto, UpdateVariantDto } from './dto/product-input.dto';
import { VendorProductQueryDto } from './dto/product-query.dto';
import {
  ArchiveProductResponseDto,
  PaginatedVendorProductsDto,
  VendorProductDetailDto,
  VendorVariantDto,
} from './dto/product-response.dto';
import { ProductsService } from './products.service';

const UUID = new ParseUUIDPipe({ version: '4' });

/**
 * The vendor's own catalogue. `VENDOR` role only (granted when staff approve the
 * store); the service additionally requires the store itself to be `APPROVED`
 * for writes, so a suspended store keeps read access but cannot change anything.
 *
 * Writes are `@SkipAudit()`: the service writes a richer audit row (previous and
 * new values) inside each transaction.
 */
@ApiTags('vendor-products')
@ApiBearerAuth('access-token')
@Roles(UserRole.VENDOR)
@ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
@ApiForbiddenResponse({ description: 'Not a vendor, or the store is not APPROVED (SUSPENDED stores may read only)' })
@Controller('vendor/products')
export class VendorProductsController {
  constructor(private readonly products: ProductsService) {}

  @Post()
  @SkipAudit()
  @ApiOperation({
    summary: 'Create a product with its variant matrix and gallery',
    description:
      'Product, variants and gallery entries are written in one transaction. SKUs must be globally unique; ' +
      'compareAtPrice (strike-through) must be greater than price (selling price); two variants cannot share the ' +
      'same colour/size/guarantee. mediaIds are images uploaded by the caller with purpose "product_image".',
  })
  @ApiCreatedResponse({ type: VendorProductDetailDto })
  @ApiBadRequestResponse({ description: 'Validation failed (prices, matrix, category, media, slug)' })
  @ApiConflictResponse({ description: 'SKU or slug already taken' })
  create(
    @Body() dto: CreateProductDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientContext() context: RequestContext,
  ): Promise<VendorProductDetailDto> {
    return this.products.create(user.id, dto, { actorId: user.id, context });
  }

  @Get()
  @ApiOperation({
    summary: 'List own products',
    description: 'Paginated, newest change first; search matches title, slug or SKU. Includes stock summaries per product.',
  })
  @ApiOkResponse({ type: PaginatedVendorProductsDto })
  async list(@Query() query: VendorProductQueryDto, @CurrentUser() user: AuthenticatedUser): Promise<PaginatedVendorProductsDto> {
    const { rows, total } = await this.products.listOwn(user.id, query);
    return {
      items: rows,
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
    };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Own product with all variants (active or not) and the full gallery' })
  @ApiOkResponse({ type: VendorProductDetailDto })
  @ApiNotFoundResponse({ description: 'No such product in this store' })
  detail(@Param('id', UUID) id: string, @CurrentUser() user: AuthenticatedUser): Promise<VendorProductDetailDto> {
    return this.products.getOwn(user.id, id);
  }

  @Patch('variants/:variantId')
  @SkipAudit()
  @ApiOperation({
    summary: 'Quick update of a variant: price, compareAtPrice, stock or active flag',
    description:
      'stockQuantity sets an absolute value, stockDelta adjusts atomically (a single guarded UPDATE, safe under ' +
      'concurrency). Stock can never drop below the units reserved by open checkouts.',
  })
  @ApiOkResponse({ type: VendorVariantDto })
  @ApiBadRequestResponse({ description: 'Validation failed, empty body, or compareAtPrice ≤ price' })
  @ApiNotFoundResponse({ description: 'No such variant in this store' })
  @ApiConflictResponse({ description: 'Stock below reserved, or last active variant of a published product' })
  updateVariant(
    @Param('variantId', UUID) variantId: string,
    @Body() dto: UpdateVariantDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientContext() context: RequestContext,
  ): Promise<VendorVariantDto> {
    return this.products.updateVariant(user.id, variantId, dto, { actorId: user.id, context });
  }

  @Patch(':id')
  @SkipAudit()
  @ApiOperation({
    summary: 'Update product details, category, gallery order or publication',
    description:
      'mediaIds replaces the whole gallery in the given order. Publishing is refused while the product is blocked by staff ' +
      '(403) or has no active variant (409).',
  })
  @ApiOkResponse({ type: VendorProductDetailDto })
  @ApiBadRequestResponse({ description: 'Validation failed or empty body' })
  @ApiNotFoundResponse({ description: 'No such product in this store' })
  @ApiConflictResponse({ description: 'Slug taken, or publishing without an active variant' })
  update(
    @Param('id', UUID) id: string,
    @Body() dto: UpdateProductDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientContext() context: RequestContext,
  ): Promise<VendorProductDetailDto> {
    return this.products.update(user.id, id, dto, { actorId: user.id, context });
  }

  @Post(':id/variants')
  @SkipAudit()
  @ApiOperation({ summary: 'Add a variant to an own product' })
  @ApiCreatedResponse({ type: VendorVariantDto })
  @ApiBadRequestResponse({ description: 'Validation failed' })
  @ApiNotFoundResponse({ description: 'No such product in this store' })
  @ApiConflictResponse({ description: 'SKU taken, duplicate colour/size/guarantee, or variant limit reached' })
  addVariant(
    @Param('id', UUID) id: string,
    @Body() dto: CreateVariantDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientContext() context: RequestContext,
  ): Promise<VendorVariantDto> {
    return this.products.addVariant(user.id, id, dto, { actorId: user.id, context });
  }

  @Delete(':id')
  @SkipAudit()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Archive a product',
    description:
      'Soft delete: the product is unpublished and leaves the storefront; variants, gallery, order history and audit ' +
      'trail are kept. Idempotent. Re-publish with PATCH { isPublished: true }.',
  })
  @ApiOkResponse({ type: ArchiveProductResponseDto })
  @ApiNotFoundResponse({ description: 'No such product in this store' })
  archive(
    @Param('id', UUID) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @ClientContext() context: RequestContext,
  ): Promise<ArchiveProductResponseDto> {
    return this.products.archive(user.id, id, { actorId: user.id, context });
  }
}
