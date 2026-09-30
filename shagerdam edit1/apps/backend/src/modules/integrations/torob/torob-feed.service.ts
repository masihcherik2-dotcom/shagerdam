import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, VendorStatus } from '@prisma/client';
import type { EnvironmentVariables, TorobPriceUnit } from '../../../config/env.validation';
import { badRequestWith } from '../../../common/http-errors';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { visibleProductWhere } from '../../categories/catalog-visibility';
import { CategoriesService } from '../../categories/categories.service';
import { breadcrumbOf } from '../../categories/category-tree';
import { ShippingCalculatorService } from '../../shipping/shipping-calculator.service';
import { TOROB_DEFAULT_PAGE_SIZE, type TorobFeedQueryDto, type TorobFeedResponseDto, type TorobProductDetailsQueryDto } from './dto/torob.dto';
import { TorobFeedCacheService } from './torob-feed-cache.service';
import {
  TOROB_MAX_IMAGES,
  parseProductPageUrl,
  sellableQuantity,
  toTorobItem,
  type TorobMappingContext,
  type TorobProductItem,
  type TorobVariantRow,
} from './torob-item.mapper';

/** Separator of the category path, as in the mission brief: `"کالای دیجیتال > گوشی موبایل"`. */
export const CATEGORY_PATH_SEPARATOR = ' > ';

/** Columns the mapper needs — nothing else leaves PostgreSQL. */
const torobVariantSelect = {
  sku: true,
  colorName: true,
  size: true,
  guarantee: true,
  price: true,
  compareAtPrice: true,
  stockQuantity: true,
  reservedQuantity: true,
  isActive: true,
  product: {
    select: {
      title: true,
      slug: true,
      brand: true,
      categoryId: true,
      isPublished: true,
      isBlockedByAdmin: true,
      vendor: { select: { status: true, shippingFeeOverride: true, freeShippingThreshold: true } },
      media: {
        select: { url: true, isPrimary: true, sortOrder: true },
        orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }],
        take: TOROB_MAX_IMAGES,
      },
      specifications: { select: { groupTitle: true, title: true, value: true }, orderBy: { sortOrder: 'asc' } },
    },
  },
} satisfies Prisma.ProductVariantSelect;

/**
 * Newest products first (Torob asks for new → old), then a total order so a
 * page boundary never duplicates or skips an offer between two requests.
 */
const feedOrder: Prisma.ProductVariantOrderByWithRelationInput[] = [
  { product: { createdAt: 'desc' } },
  { productId: 'asc' },
  { createdAt: 'asc' },
  { id: 'asc' },
];

/**
 * Torob price-comparison feed, read live from PostgreSQL.
 *
 * - **Listing** (`feed`): every active variant of every publicly visible product
 *   (the storefront's own visibility rule), optionally limited to one approved
 *   store. Pages are bounded (≤ 500 rows, selected columns only), so memory per
 *   request is bounded whatever the catalogue size; rendered pages are cached in
 *   Redis and invalidated by every product, price and stock change.
 * - **Details** (`details`): one offer, never cached — Torob uses it to re-check
 *   price and stock right before sending a buyer.
 */
@Injectable()
export class TorobFeedService {
  private readonly webOrigin: string;
  private readonly assetOrigin: string;
  private readonly priceUnit: TorobPriceUnit;

  constructor(
    private readonly prisma: PrismaService,
    private readonly categories: CategoriesService,
    private readonly shipping: ShippingCalculatorService,
    private readonly cache: TorobFeedCacheService,
    config: ConfigService<EnvironmentVariables, true>,
  ) {
    this.assetOrigin = config.getOrThrow<string>('PUBLIC_API_ORIGIN');
    this.webOrigin = config.get<string | undefined>('PUBLIC_WEB_ORIGIN') ?? this.assetOrigin;
    this.priceUnit = config.get('TOROB_PRICE_UNIT', { infer: true });
  }

  async feed(query: TorobFeedQueryDto): Promise<TorobFeedResponseDto> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? query.limit ?? TOROB_DEFAULT_PAGE_SIZE;
    const vendorSlug = query.vendorSlug ?? null;

    const cacheKey = `${this.priceUnit}:${vendorSlug ?? '*'}:${page}:${pageSize}`;
    // Generation first: a page built after a concurrent invalidation is stored
    // under the old generation and can never be served (see the cache service).
    const generation = await this.cache.generation();
    const cached = await this.cache.read<TorobFeedResponseDto>(cacheKey, generation);
    if (cached !== null) {
      return cached;
    }

    const vendorId = vendorSlug === null ? null : await this.approvedVendorId(vendorSlug);
    const context = await this.mappingContext();
    const where: Prisma.ProductVariantWhereInput = {
      isActive: true,
      product: {
        ...visibleProductWhere(),
        categoryId: { in: [...context.categoryPaths.keys()] },
        ...(vendorId === null ? {} : { vendorId }),
      },
    };

    const [count, rows] = await this.prisma.$transaction([
      this.prisma.productVariant.count({ where }),
      this.prisma.productVariant.findMany({
        where,
        select: torobVariantSelect,
        orderBy: feedOrder,
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    const response: TorobFeedResponseDto = {
      count,
      page,
      totalPages: Math.ceil(count / pageSize),
      products: rows.map((row) => toTorobItem(row, context)),
    };
    await this.cache.write(cacheKey, generation, response);
    return response;
  }

  /**
   * One offer by `page_unique` (SKU) or by storefront `page_url`. A variant that
   * exists but is no longer listed (unpublished, blocked, store suspended,
   * variant deactivated) is returned as `outofstock` so Torob drops the offer
   * instead of retrying a 404; an unknown identifier is 404.
   */
  async details(query: TorobProductDetailsQueryDto): Promise<TorobProductItem> {
    const hasUnique = query.page_unique !== undefined && query.page_unique !== '';
    const hasUrl = query.page_url !== undefined && query.page_url !== '';
    if (hasUnique === hasUrl) {
      throw badRequestWith('TOROB_LOOKUP_REQUIRED', 'Send exactly one of page_unique or page_url');
    }

    const row = hasUnique ? await this.findBySku(query.page_unique as string) : await this.findByPageUrl(query.page_url as string);
    if (row === null) {
      throw new NotFoundException({ statusCode: 404, error: 'Not Found', code: 'TOROB_PRODUCT_NOT_FOUND', message: 'No product matches this identifier' });
    }
    return toTorobItem(row, await this.mappingContext());
  }

  // ─── Internals ──────────────────────────────────────────────────────────

  private async approvedVendorId(storeSlug: string): Promise<string> {
    const vendor = await this.prisma.vendor.findUnique({ where: { storeSlug }, select: { id: true, status: true } });
    if (vendor === null || vendor.status !== VendorStatus.APPROVED) {
      // Unknown and not-approved stores are indistinguishable on purpose: the
      // feed must not reveal which store slugs exist.
      throw new NotFoundException({ statusCode: 404, error: 'Not Found', code: 'TOROB_VENDOR_NOT_FOUND', message: `No approved store "${storeSlug}"` });
    }
    return vendor.id;
  }

  private findBySku(sku: string): Promise<TorobVariantRow | null> {
    return this.prisma.productVariant.findUnique({ where: { sku }, select: torobVariantSelect });
  }

  private async findByPageUrl(pageUrl: string): Promise<TorobVariantRow | null> {
    const parsed = parseProductPageUrl(pageUrl, this.webOrigin);
    if (parsed === null) {
      throw badRequestWith('TOROB_INVALID_PAGE_URL', `page_url must be a product link on ${this.webOrigin} (/products/<slug>)`);
    }
    if (parsed.sku !== null) {
      const row = await this.findBySku(parsed.sku);
      // The SKU must belong to the product in the path; a mismatched pair is not a match.
      return row !== null && row.product.slug === parsed.slug ? row : null;
    }
    // No variant in the link: the offer the product page pre-selects — the first
    // active variant with sellable stock, else the first active one.
    const variants = await this.prisma.productVariant.findMany({
      where: { product: { slug: parsed.slug } },
      select: torobVariantSelect,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const active = variants.filter((variant) => variant.isActive);
    return active.find((variant) => sellableQuantity(variant) > 0) ?? active[0] ?? variants[0] ?? null;
  }

  private async mappingContext(): Promise<TorobMappingContext> {
    const [index, policy] = await Promise.all([this.categories.getIndex(), this.shipping.loadPolicy()]);
    const categoryPaths = new Map<string, string>();
    for (const id of index.byId.keys()) {
      categoryPaths.set(
        id,
        breadcrumbOf(index, id)
          .map((node) => node.titleFa)
          .join(CATEGORY_PATH_SEPARATOR),
      );
    }
    return {
      webOrigin: this.webOrigin,
      assetOrigin: this.assetOrigin,
      priceUnit: this.priceUnit,
      shippingPolicy: policy,
      categoryPaths,
    };
  }
}
