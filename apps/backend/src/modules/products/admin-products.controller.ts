import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
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
import { AdminProductStatusDto } from './dto/product-input.dto';
import { AdminProductQueryDto, PublishDraftsQueryDto } from './dto/product-query.dto';
import { AdminProductStatusResponseDto, DraftPublishSummaryDto, PaginatedAdminProductsDto, PublishDraftsResponseDto } from './dto/product-response.dto';
import { ProductsService } from './products.service';

/**
 * Staff product review. SUPPORT may browse (to answer tickets); only SUPER_ADMIN
 * and ADMIN may block, unblock, publish or unpublish (one by one or all drafts at once).
 */
@ApiTags('admin-products')
@ApiBearerAuth('access-token')
@ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
@Controller('admin/products')
export class AdminProductsController {
  constructor(private readonly products: ProductsService) {}

  @Get()
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.SUPPORT)
  @ApiOperation({ summary: 'All products across stores, for review', description: 'Filters: search, vendorSlug, isBlockedByAdmin, isPublished.' })
  @ApiOkResponse({ type: PaginatedAdminProductsDto })
  @ApiForbiddenResponse({ description: 'Staff only' })
  async list(@Query() query: AdminProductQueryDto): Promise<PaginatedAdminProductsDto> {
    const { rows, total } = await this.products.listForAdmin(query);
    return {
      items: rows,
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
    };
  }

  @Get('publish-drafts')
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
  @ApiOperation({ summary: 'Preview the bulk publish of drafts', description: 'Counts for every store, or for the store with vendorSlug.' })
  @ApiOkResponse({ type: DraftPublishSummaryDto })
  @ApiNotFoundResponse({ description: 'No store with this slug' })
  draftSummary(@Query() query: PublishDraftsQueryDto): Promise<DraftPublishSummaryDto> {
    return this.products.draftSummaryForAdmin(query.vendorSlug);
  }

  @Post('publish-drafts')
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @SkipAudit()
  @ApiOperation({
    summary: 'Publish all draft products at once (every store, or one)',
    description:
      'Publishes every unpublished product that meets the publishing rules: not blocked by staff, store APPROVED and at least one ' +
      'active variant. The rest stay unpublished and are counted in `remaining`. One audit row per published product.',
  })
  @ApiOkResponse({ type: PublishDraftsResponseDto })
  @ApiForbiddenResponse({ description: 'Only SUPER_ADMIN and ADMIN' })
  @ApiNotFoundResponse({ description: 'No store with this slug' })
  publishDrafts(@Query() query: PublishDraftsQueryDto, @CurrentUser() user: AuthenticatedUser, @ClientContext() context: RequestContext): Promise<PublishDraftsResponseDto> {
    return this.products.publishDraftsForAdmin(query.vendorSlug, { actorId: user.id, context });
  }

  @Patch(':id/status')
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
  @SkipAudit()
  @ApiOperation({
    summary: 'Moderate a product: block/unblock and publish/unpublish',
    description:
      'Blocking requires a reason (shown to the vendor) and unpublishes the product; while blocked, the vendor cannot ' +
      'publish it. Lifting the block does not re-publish. The change and its audit row are written in one transaction.',
  })
  @ApiOkResponse({ type: AdminProductStatusResponseDto })
  @ApiBadRequestResponse({ description: 'Nothing to change, or reason missing/unexpected' })
  @ApiForbiddenResponse({ description: 'Only SUPER_ADMIN and ADMIN may moderate products' })
  @ApiNotFoundResponse({ description: 'Product not found' })
  @ApiConflictResponse({ description: 'Publishing a blocked product, a product of a non-approved store, or one without an active variant' })
  setStatus(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: AdminProductStatusDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientContext() context: RequestContext,
  ): Promise<AdminProductStatusResponseDto> {
    return this.products.setStatus(id, dto, { actorId: user.id, context });
  }
}
