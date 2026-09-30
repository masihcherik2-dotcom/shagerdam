import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Query } from '@nestjs/common';
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
import { AdminProductQueryDto } from './dto/product-query.dto';
import { AdminProductStatusResponseDto, PaginatedAdminProductsDto } from './dto/product-response.dto';
import { ProductsService } from './products.service';

/**
 * Staff product review. SUPPORT may browse (to answer tickets); only SUPER_ADMIN
 * and ADMIN may block, unblock, publish or unpublish.
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
