import { Controller, Get, Param } from '@nestjs/common';
import { ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import { CategoriesService } from './categories.service';
import { CategoryDetailDto, CategoryTreeNodeDto, CategoryTreeResponseDto } from './dto/category-response.dto';

/**
 * Public category navigation. Only active categories reachable from an active
 * root are exposed; product counts use the same visibility rule as the search
 * listing, so a count always matches what the category page lists.
 */
@ApiTags('categories')
@Public()
@Controller('categories')
export class CategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  @Get('tree')
  @ApiOperation({
    summary: 'Complete nested category tree',
    description:
      'Every visible category, nested to any depth and ordered by sortOrder. Each node carries the number of ' +
      'publicly visible products placed directly in it (productCount) and in its whole subtree (totalProductCount). ' +
      'Served from a Redis cache that is invalidated on every catalogue change.',
  })
  @ApiOkResponse({ type: CategoryTreeResponseDto })
  async tree(): Promise<CategoryTreeResponseDto> {
    const { roots, totalCategories, totalProducts } = await this.categories.getTree();
    return {
      items: roots.map((root) => CategoryTreeNodeDto.fromNode(root)),
      totalCategories,
      totalProducts,
    };
  }

  @Get(':slug')
  @ApiOperation({
    summary: 'Category detail with breadcrumb and direct subcategories',
    description: 'The breadcrumb runs from the root down to the category itself.',
  })
  @ApiParam({ name: 'slug', example: 'mobile' })
  @ApiOkResponse({ type: CategoryDetailDto })
  @ApiNotFoundResponse({ description: 'Unknown category, or the category (or one of its ancestors) is inactive' })
  async detail(@Param('slug') slug: string): Promise<CategoryDetailDto> {
    const { node, breadcrumbs } = await this.categories.getBySlug(slug.trim().toLowerCase());
    return CategoryDetailDto.fromNode(node, breadcrumbs);
  }
}
