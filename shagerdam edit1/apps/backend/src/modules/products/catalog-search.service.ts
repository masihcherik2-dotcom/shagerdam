import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { visibleProductSql, visibleProductWhere } from '../categories/catalog-visibility';
import { CategoriesService } from '../categories/categories.service';
import { CategorySummaryDto } from '../categories/dto/category-response.dto';
import { escapeLikePattern, searchTermVariants } from './catalog-text';
import type { ProductSort, PublicProductQueryDto } from './dto/product-query.dto';
import type { PublicProductDetailDto, PublicProductListItemDto } from './dto/product-response.dto';
import { COLOR_HEX_PATTERN } from './product-rules';
import {
  imageRef,
  maxDiscountPercent,
  startingCompareAtPrice,
  mediaSelect,
  priceRange,
  specificationOrder,
  specificationSelect,
  toPublicVariant,
  variantOptions,
  variantSelect,
  type VariantRow,
} from './product-views';

/** Sub-orders in these states did not result in a sale and do not count as "popular". */
const NON_SALE_STATUSES = Prisma.sql`('CANCELLED', 'REFUNDED')`;

const listingSelect = {
  id: true,
  slug: true,
  title: true,
  brand: true,
  createdAt: true,
  category: { select: { id: true, slug: true, titleFa: true, titleEn: true } },
  vendor: { select: { storeName: true, storeSlug: true, logoUrl: true } },
  variants: { where: { isActive: true }, select: variantSelect, orderBy: [{ createdAt: 'asc' }, { sku: 'asc' }] },
  media: { select: mediaSelect, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }], take: 1 },
} satisfies Prisma.ProductSelect;

/**
 * Public catalogue discovery.
 *
 * The listing is one parameterised SQL statement (plus a COUNT with the same
 * predicate) so that every filter is evaluated by PostgreSQL on indexed columns:
 *
 * - text search: `ILIKE '%term%'` on title / brand / description, served by the
 *   pg_trgm GIN indexes (`products_*_trgm_idx`); each term is also tried with
 *   ASCII and Persian digits;
 * - variant filters (price range, stock, colours, sizes) must hold for the
 *   **same** active variant — "red, size L, under 1,000,000" never matches a
 *   product whose only red variant is size M;
 * - category filters include every descendant, resolved from the cached tree;
 * - sorting: newest, lowest matching price asc/desc, or units sold.
 *
 * Only ids come back from the SQL; the page is then hydrated through Prisma
 * with the same visibility predicate, so the response shape is typed end to end.
 */
@Injectable()
export class CatalogSearchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly categories: CategoriesService,
  ) {}

  async search(query: PublicProductQueryDto): Promise<{ items: PublicProductListItemDto[]; total: number }> {
    if (query.categorySlug !== undefined && query.categoryId !== undefined) {
      throw new BadRequestException('Use either categorySlug or categoryId, not both');
    }
    if (query.minPrice !== undefined && query.maxPrice !== undefined && query.minPrice > query.maxPrice) {
      throw new BadRequestException('minPrice must not be greater than maxPrice');
    }

    const categoryIds = await this.scopeCategoryIds(query);
    if (categoryIds.length === 0) {
      return { items: [], total: 0 };
    }

    const where = this.buildWhere(query, categoryIds);
    const variantMatch = this.buildVariantMatch(query);
    const needsSales = query.sortBy === 'popular';

    const from = Prisma.sql`
      FROM products p
      JOIN vendors v ON v.id = p.vendor_id
      JOIN LATERAL (
        SELECT MIN(pv.price) AS min_price
          FROM product_variants pv
         WHERE ${variantMatch}
      ) mv ON mv.min_price IS NOT NULL`;

    const sales = needsSales
      ? Prisma.sql`
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(oi.quantity), 0)::int AS sold
          FROM order_items oi
          JOIN product_variants sv ON sv.id = oi.product_variant_id
          JOIN sub_orders so ON so.id = oi.sub_order_id
         WHERE sv.product_id = p.id AND so.status NOT IN ${NON_SALE_STATUSES}
      ) sales ON true`
      : Prisma.empty;

    const [pageRows, countRows] = await Promise.all([
      this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT p.id
        ${from}
        ${sales}
        WHERE ${where}
        ORDER BY ${orderBy(query.sortBy)}
        LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}`),
      this.prisma.$queryRaw<Array<{ total: number }>>(Prisma.sql`
        SELECT COUNT(*)::int AS total
        ${from}
        WHERE ${where}`),
    ]);

    const total = countRows[0]?.total ?? 0;
    const ids = pageRows.map((row) => row.id);
    if (ids.length === 0) {
      return { items: [], total };
    }

    const products = await this.prisma.product.findMany({
      where: { id: { in: ids }, ...visibleProductWhere() },
      select: listingSelect,
    });
    const byId = new Map(products.map((product) => [product.id, product]));

    const items = ids
      .map((id) => byId.get(id))
      .filter((product): product is NonNullable<typeof product> => product !== undefined)
      .map((product): PublicProductListItemDto => {
        const options = variantOptions(product.variants);
        return {
          id: product.id,
          slug: product.slug,
          title: product.title,
          brand: product.brand,
          primaryImage: imageRef(product.media[0]),
          priceRange: priceRange(product.variants) ?? { min: '0.00', max: '0.00' },
          maxDiscountPercent: maxDiscountPercent(product.variants),
          startingCompareAtPrice: startingCompareAtPrice(product.variants),
          colors: options.colors,
          sizes: options.sizes,
          inStock: product.variants.some(hasStock),
          vendor: product.vendor,
          category: CategorySummaryDto.from(product.category),
          createdAt: product.createdAt,
        };
      });

    return { items, total };
  }

  /** A publicly visible product by slug, with live stock. 404 otherwise. */
  async getBySlug(slug: string): Promise<PublicProductDetailDto> {
    const visibleIds = await this.categories.visibleCategoryIds();
    const product = await this.prisma.product.findFirst({
      where: { slug, ...visibleProductWhere(), categoryId: { in: visibleIds } },
      select: {
        id: true,
        slug: true,
        title: true,
        description: true,
        brand: true,
        categoryId: true,
        createdAt: true,
        updatedAt: true,
        vendor: {
          select: { storeName: true, storeSlug: true, logoUrl: true, bio: true, instagramHandle: true, verifiedAt: true },
        },
        variants: { where: { isActive: true }, select: variantSelect, orderBy: [{ createdAt: 'asc' }, { sku: 'asc' }] },
        media: { select: mediaSelect, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] },
        specifications: { select: specificationSelect, orderBy: specificationOrder },
      },
    });
    if (!product) {
      throw new NotFoundException(`Product "${slug}" was not found`);
    }

    const breadcrumbs = await this.categories.breadcrumbFor(product.categoryId);
    const options = variantOptions(product.variants);

    return {
      id: product.id,
      slug: product.slug,
      title: product.title,
      description: product.description,
      brand: product.brand,
      breadcrumbs: breadcrumbs.map((node) => CategorySummaryDto.from(node)),
      vendor: product.vendor,
      media: product.media.map((media) => ({ url: media.url, thumbnailUrl: media.thumbnailUrl })),
      variants: product.variants.map((variant) => toPublicVariant(variant)),
      specifications: product.specifications.map((row) => ({ ...row })),
      priceRange: priceRange(product.variants) ?? { min: '0.00', max: '0.00' },
      maxDiscountPercent: maxDiscountPercent(product.variants),
      colors: options.colors,
      sizes: options.sizes,
      inStock: product.variants.some(hasStock),
      createdAt: product.createdAt,
      updatedAt: product.updatedAt,
    };
  }

  // ---------------------------------------------------------------------------

  private async scopeCategoryIds(query: PublicProductQueryDto): Promise<string[]> {
    if (query.categorySlug !== undefined || query.categoryId !== undefined) {
      const subtree = await this.categories.visibleSubtreeIds({
        ...(query.categorySlug !== undefined ? { slug: query.categorySlug.trim().toLowerCase() } : {}),
        ...(query.categoryId !== undefined ? { id: query.categoryId } : {}),
      });
      return subtree ?? [];
    }
    return this.categories.visibleCategoryIds();
  }

  private buildWhere(query: PublicProductQueryDto, categoryIds: string[]): Prisma.Sql {
    const conditions: Prisma.Sql[] = [visibleProductSql(), Prisma.sql`p.category_id = ANY(${categoryIds}::uuid[])`];

    if (query.vendorSlug !== undefined) {
      conditions.push(Prisma.sql`v.store_slug = ${query.vendorSlug.trim().toLowerCase()}`);
    }

    if (query.search !== undefined) {
      const patterns = searchTermVariants(query.search).map((term) => `%${escapeLikePattern(term)}%`);
      if (patterns.length > 0) {
        // One ILIKE per column and pattern (not ILIKE ANY): the planner turns an
        // OR of simple ILIKEs into a BitmapOr over the trigram GIN indexes.
        const matches = patterns.flatMap((pattern) => [
          Prisma.sql`p.title ILIKE ${pattern}`,
          Prisma.sql`p.brand ILIKE ${pattern}`,
          Prisma.sql`p.description ILIKE ${pattern}`,
        ]);
        conditions.push(Prisma.sql`(${Prisma.join(matches, ' OR ')})`);
      }
    }

    return Prisma.join(conditions, ' AND ');
  }

  /** Predicate over `product_variants pv` for the variant a product must have. */
  private buildVariantMatch(query: PublicProductQueryDto): Prisma.Sql {
    const conditions: Prisma.Sql[] = [Prisma.sql`pv.product_id = p.id`, Prisma.sql`pv.is_active = true`];

    if (query.minPrice !== undefined) {
      conditions.push(Prisma.sql`pv.price >= ${query.minPrice.toFixed(2)}::numeric`);
    }
    if (query.maxPrice !== undefined) {
      conditions.push(Prisma.sql`pv.price <= ${query.maxPrice.toFixed(2)}::numeric`);
    }
    if (query.inStockOnly === true) {
      conditions.push(Prisma.sql`pv.stock_quantity - pv.reserved_quantity > 0`);
    }
    if (query.onSaleOnly === true) {
      conditions.push(Prisma.sql`pv.compare_at_price IS NOT NULL AND pv.compare_at_price > pv.price`);
    }
    if (query.colors !== undefined && query.colors.length > 0) {
      const hexes = query.colors.map((color) => color.toUpperCase()).filter((color) => COLOR_HEX_PATTERN.test(color));
      const names = query.colors
        .filter((color) => !COLOR_HEX_PATTERN.test(color.toUpperCase()))
        .flatMap((color) => searchTermVariants(color))
        .map((color) => color.toLowerCase());
      const colorMatches: Prisma.Sql[] = [];
      if (names.length > 0) colorMatches.push(Prisma.sql`lower(pv.color_name) = ANY(${names}::text[])`);
      if (hexes.length > 0) colorMatches.push(Prisma.sql`upper(pv.color_hex) = ANY(${hexes}::text[])`);
      conditions.push(colorMatches.length > 0 ? Prisma.sql`(${Prisma.join(colorMatches, ' OR ')})` : Prisma.sql`false`);
    }
    if (query.sizes !== undefined && query.sizes.length > 0) {
      const sizes = query.sizes.map((size) => size.toUpperCase());
      conditions.push(Prisma.sql`upper(pv.size) = ANY(${sizes}::text[])`);
    }

    return Prisma.join(conditions, ' AND ');
  }
}

function orderBy(sort: ProductSort): Prisma.Sql {
  switch (sort) {
    case 'price_asc':
      return Prisma.sql`mv.min_price ASC, p.created_at DESC, p.id ASC`;
    case 'price_desc':
      return Prisma.sql`mv.min_price DESC, p.created_at DESC, p.id ASC`;
    case 'popular':
      return Prisma.sql`sales.sold DESC, p.created_at DESC, p.id ASC`;
    case 'newest':
    default:
      return Prisma.sql`p.created_at DESC, p.id ASC`;
  }
}

function hasStock(variant: Pick<VariantRow, 'stockQuantity' | 'reservedQuantity'>): boolean {
  return variant.stockQuantity - variant.reservedQuantity > 0;
}
