import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBadRequestResponse, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import { CatalogSearchService } from './catalog-search.service';
import { PublicProductQueryDto } from './dto/product-query.dto';
import { PaginatedPublicProductsDto, PublicProductDetailDto } from './dto/product-response.dto';

/**
 * Public catalogue: guests and customers. Only products that are published, not
 * blocked, sold by an APPROVED store, placed in a visible category and backed by
 * at least one active variant are ever returned.
 */
@ApiTags('products')
@Public()
@Controller('products')
export class ProductsController {
  constructor(private readonly search: CatalogSearchService) {}

  @Get()
  @ApiOperation({
    summary: 'Search and browse the catalogue',
    description:
      'Filters: search (title/brand/description, trigram-indexed), categorySlug/categoryId (includes descendants), ' +
      'vendorSlug, minPrice/maxPrice, inStockOnly, colors, sizes. Variant filters must hold for the same variant. ' +
      'Sorts: newest, price_asc, price_desc, popular.',
  })
  @ApiOkResponse({ type: PaginatedPublicProductsDto })
  @ApiBadRequestResponse({ description: 'Invalid filter (e.g. minPrice > maxPrice, both categorySlug and categoryId)' })
  async list(@Query() query: PublicProductQueryDto): Promise<PaginatedPublicProductsDto> {
    const { items, total } = await this.search.search(query);
    return {
      items,
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
    };
  }

  @Get(':slug')
  @ApiOperation({
    summary: 'Product page',
    description: 'Description, category breadcrumb, store, full gallery and every active variant with live availability.',
  })
  @ApiParam({ name: 'slug', example: 'shopino-sample-smartphone-x1' })
  @ApiOkResponse({ type: PublicProductDetailDto })
  @ApiNotFoundResponse({ description: 'Unknown slug, or the product is not publicly visible' })
  detail(@Param('slug') slug: string): Promise<PublicProductDetailDto> {
    return this.search.getBySlug(decodeURIComponent(slug).trim().toLowerCase());
  }
}
