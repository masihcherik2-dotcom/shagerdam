import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
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
import { CategoriesService } from './categories.service';
import { CreateCategoryDto, UpdateCategoryDto } from './dto/category-input.dto';
import { AdminCategoryDto, AdminCategoryListDto } from './dto/category-response.dto';

/**
 * Category management for `SUPER_ADMIN` and `ADMIN`.
 *
 * Writes are `@SkipAudit()` on purpose: the service records the audit row —
 * with the previous and new values, including the commission rate — inside the
 * same transaction as the change.
 */
@ApiTags('admin-categories')
@ApiBearerAuth('access-token')
@Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
@ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
@ApiForbiddenResponse({ description: 'Only SUPER_ADMIN and ADMIN may manage categories' })
@Controller('admin/categories')
export class AdminCategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  @Get()
  @ApiOperation({
    summary: 'All categories, flat (including inactive)',
    description: 'Staff need to see inactive categories to re-activate or move them; the public tree hides them.',
  })
  @ApiOkResponse({ type: AdminCategoryListDto })
  async list(): Promise<AdminCategoryListDto> {
    const items = await this.categories.listForAdmin();
    return { items, total: items.length };
  }

  @Post()
  @SkipAudit()
  @ApiOperation({ summary: 'Create a category' })
  @ApiCreatedResponse({ type: AdminCategoryDto })
  @ApiBadRequestResponse({ description: 'Validation failed or parentId does not exist' })
  @ApiConflictResponse({ description: 'Slug already taken' })
  create(
    @Body() dto: CreateCategoryDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientContext() context: RequestContext,
  ): Promise<AdminCategoryDto> {
    return this.categories.create(dto, { actorId: user.id, context });
  }

  @Patch(':id')
  @SkipAudit()
  @ApiOperation({
    summary: 'Update category metadata, position or commission rate',
    description:
      'Moving a category (parentId) is rejected when the new parent is the category itself or one of its descendants. ' +
      'A commission change affects future orders only: order lines snapshot the rate at checkout.',
  })
  @ApiOkResponse({ type: AdminCategoryDto })
  @ApiBadRequestResponse({ description: 'Validation failed, empty body, unknown parent or cyclic move' })
  @ApiNotFoundResponse({ description: 'Category not found' })
  @ApiConflictResponse({ description: 'Slug already taken' })
  update(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateCategoryDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientContext() context: RequestContext,
  ): Promise<AdminCategoryDto> {
    return this.categories.update(id, dto, { actorId: user.id, context });
  }
}
