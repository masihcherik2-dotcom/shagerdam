import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction, MediaKind, Prisma, VendorStatus } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import type { RequestContext } from '../../common/types/request-context';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { sanitize } from '../audit/audit-log.service';
import { CategoriesService } from '../categories/categories.service';
import { normalizePersianParagraphs, normalizePersianText, PRODUCT_SLUG_MAX_LENGTH, slugify } from './catalog-text';
import type {
  AdminProductStatusDto,
  CreateProductDto,
  CreateVariantDto,
  UpdateProductDto,
  UpdateVariantDto,
} from './dto/product-input.dto';
import type { AdminProductQueryDto, VendorProductQueryDto } from './dto/product-query.dto';
import type {
  AdminProductDto,
  AdminProductStatusResponseDto,
  ArchiveProductResponseDto,
  VendorProductDetailDto,
  VendorProductSummaryDto,
  VendorVariantDto,
  DraftPublishSummaryDto,
  PublishDraftsResponseDto,
} from './dto/product-response.dto';
import { TorobFeedCacheService } from '../integrations/torob/torob-feed-cache.service';
import { InventoryService, type StockLevel } from './inventory.service';
import {
  matrixProblems,
  MAX_VARIANTS_PER_PRODUCT,
  normalizeSpecifications,
  toMoney,
  variantFieldProblems,
  variantMatrixKey,
} from './product-rules';
import {
  productDetailSelect,
  productSummarySelect,
  toAdminProduct,
  toVendorDetail,
  toVendorSummary,
  toVendorVariant,
  variantSelect,
} from './product-views';

/** Only images uploaded for this purpose can be attached to a product gallery. */
export const PRODUCT_IMAGE_PURPOSE = 'product_image';

interface ActorParams {
  actorId: string;
  context: RequestContext;
}

interface StoreRef {
  id: string;
  storeSlug: string;
  status: VendorStatus;
}

interface NormalizedVariant {
  sku: string;
  colorName: string | null;
  colorHex: string | null;
  size: string | null;
  guarantee: string | null;
  price: number;
  compareAtPrice: number | null;
  stockQuantity: number;
  weightGrams: number | null;
  isActive: boolean;
}

interface GalleryEntry {
  mediaAssetId: string;
  url: string;
  thumbnailUrl: string | null;
  isPrimary: boolean;
  sortOrder: number;
}

type Tx = Prisma.TransactionClient;

/** Products a bulk publish may touch: one store, or every store (staff only). */
export interface DraftScope {
  vendorId?: string;
}

/** Rows published (and audited) per transaction by a bulk publish. */
export const PUBLISH_DRAFTS_BATCH = 500;


/**
 * Vendor catalogue management and staff moderation.
 *
 * Ownership model: every vendor route resolves the caller's store from the
 * authenticated user id — never from the request — and every product/variant
 * lookup is scoped to that store. A product of another store is therefore
 * indistinguishable from a missing one (404), which also avoids leaking which
 * ids exist.
 *
 * Invariants maintained here (with database CHECK constraints as backstop):
 * - only `APPROVED` stores write; a `SUSPENDED` store can still read its catalogue;
 * - `price > 0`, `compareAtPrice > price`, SKU globally unique, one variant per
 *   colour/size/guarantee cell;
 * - a published product always has at least one active variant (publishing and
 *   deactivating are serialised per product with `SELECT … FOR UPDATE`);
 * - a product blocked by staff cannot be published by its vendor;
 * - every write records its audit row inside the same transaction.
 */
@Injectable()
export class ProductsService {
  private readonly logger = new Logger(ProductsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly categories: CategoriesService,
    private readonly torobFeedCache: TorobFeedCacheService,
  ) {}

  /**
   * After a committed catalogue write: the category tree counts and the Torob
   * feed pages may be stale. Both invalidations are best-effort and never throw.
   */
  private async catalogChanged(): Promise<void> {
    await Promise.all([this.categories.invalidateTree(), this.torobFeedCache.invalidate()]);
  }

  // ===========================================================================
  // Vendor: products
  // ===========================================================================

  async create(userId: string, dto: CreateProductDto, params: ActorParams): Promise<VendorProductDetailDto> {
    const store = await this.requireStore(userId, 'write');
    await this.requireActiveCategory(dto.categoryId);

    const title = normalizePersianText(dto.title);
    const variants = dto.variants.map((variant) => normalizeVariant(variant));
    const problems = matrixProblems(variants);
    if (problems.length > 0) {
      throw new BadRequestException(problems);
    }
    if (dto.isPublished === true && !variants.some((variant) => variant.isActive)) {
      throw new BadRequestException('Publishing requires at least one active variant');
    }
    await this.assertSkusAvailable(variants.map((variant) => variant.sku));
    const gallery = await this.resolveGallery(userId, dto.mediaIds ?? []);
    const specifications = normalizeSpecifications(dto.specifications ?? []);

    const baseSlug = dto.slug ?? slugify(title);
    if (baseSlug.length === 0) {
      throw new BadRequestException('A slug cannot be derived from this title; send a custom slug');
    }
    if (dto.slug !== undefined) {
      await this.assertSlugAvailable(dto.slug);
    }

    const productData = {
      vendorId: store.id,
      categoryId: dto.categoryId,
      title,
      description: dto.description ? normalizePersianParagraphs(dto.description) : null,
      brand: dto.brand ? normalizePersianText(dto.brand) : null,
      basePrice: toMoney(dto.basePrice),
      isPublished: dto.isPublished ?? false,
    };

    // A generated slug may collide with a concurrent insert between the check
    // and the write; retry with a random suffix. A custom slug is never altered.
    for (let attempt = 0; ; attempt += 1) {
      const slug =
        dto.slug ?? (attempt === 0 ? await this.nextFreeSlug(baseSlug) : withSuffix(baseSlug, randomSuffix()));
      try {
        const productId = await this.prisma.$transaction(async (tx) => {
          const created = await tx.product.create({
            data: {
              ...productData,
              slug,
              variants: {
                create: variants.map((variant) => ({
                  ...variant,
                  price: toMoney(variant.price),
                  compareAtPrice: variant.compareAtPrice === null ? null : toMoney(variant.compareAtPrice),
                })),
              },
              media: { create: gallery },
              specifications: { create: specifications },
            },
            select: { id: true },
          });

          if (gallery.length > 0) {
            await tx.mediaAsset.updateMany({
              where: { id: { in: gallery.map((entry) => entry.mediaAssetId) }, vendorId: null },
              data: { vendorId: store.id },
            });
          }

          await this.audit(tx, {
            ...params,
            action: AuditAction.CREATE,
            entityId: created.id,
            newValue: {
              slug,
              title,
              categoryId: dto.categoryId,
              basePrice: productData.basePrice.toFixed(2),
              isPublished: productData.isPublished,
              skus: variants.map((variant) => variant.sku),
              mediaIds: gallery.map((entry) => entry.mediaAssetId),
              specificationCount: specifications.length,
            },
          });
          return created.id;
        });

        this.logger.log(`Product ${productId} (${slug}) created by store ${store.storeSlug}`);
        await this.catalogChanged();
        return this.requireOwnDetail(store.id, productId);
      } catch (error) {
        const target = uniqueViolationTarget(error);
        if (target === 'sku') {
          throw new ConflictException('One of the SKUs was taken by another product in the meantime; retry with unique SKUs');
        }
        if (target === 'slug') {
          if (dto.slug !== undefined) {
            throw new ConflictException(`Slug "${dto.slug}" is already taken`);
          }
          if (attempt < 3) {
            continue;
          }
        }
        throw translateCheckViolation(error);
      }
    }
  }

  async listOwn(userId: string, query: VendorProductQueryDto): Promise<{ rows: VendorProductSummaryDto[]; total: number }> {
    const store = await this.requireStore(userId, 'read');
    const where: Prisma.ProductWhereInput = {
      vendorId: store.id,
      ...statusFilter(query.status),
      ...searchFilter(query.search),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.product.findMany({
        where,
        select: productSummarySelect,
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.product.count({ where }),
    ]);
    return { rows: rows.map((row) => toVendorSummary(row)), total };
  }

  async getOwn(userId: string, productId: string): Promise<VendorProductDetailDto> {
    const store = await this.requireStore(userId, 'read');
    return this.requireOwnDetail(store.id, productId);
  }

  async update(
    userId: string,
    productId: string,
    dto: UpdateProductDto,
    params: ActorParams,
  ): Promise<VendorProductDetailDto> {
    assertNotEmpty(dto);
    const store = await this.requireStore(userId, 'write');
    const current = await this.requireOwnProduct(store.id, productId);

    if (dto.categoryId !== undefined && dto.categoryId !== current.categoryId) {
      await this.requireActiveCategory(dto.categoryId);
    }
    if (dto.slug !== undefined && dto.slug !== current.slug) {
      await this.assertSlugAvailable(dto.slug);
    }
    if (dto.isPublished === true && current.isBlockedByAdmin) {
      throw new ForbiddenException(
        `This product is blocked by staff and cannot be published${current.blockedReason ? `: ${current.blockedReason}` : ''}`,
      );
    }
    const gallery = dto.mediaIds !== undefined ? await this.resolveGallery(userId, dto.mediaIds) : undefined;
    const specifications = dto.specifications !== undefined ? normalizeSpecifications(dto.specifications) : undefined;

    const data: Prisma.ProductUncheckedUpdateInput = {};
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    const change = (key: keyof Prisma.ProductUncheckedUpdateInput, previous: unknown, next: unknown, stored: unknown = next): void => {
      (data as Record<string, unknown>)[key] = stored;
      before[key] = previous;
      after[key] = next;
    };

    if (dto.title !== undefined) change('title', current.title, normalizePersianText(dto.title));
    if (dto.slug !== undefined) change('slug', current.slug, dto.slug);
    if (dto.description !== undefined)
      change('description', current.description, dto.description === null ? null : normalizePersianParagraphs(dto.description));
    if (dto.categoryId !== undefined) change('categoryId', current.categoryId, dto.categoryId);
    if (dto.brand !== undefined) change('brand', current.brand, dto.brand === null ? null : normalizePersianText(dto.brand));
    if (dto.basePrice !== undefined) {
      const basePrice = toMoney(dto.basePrice);
      change('basePrice', current.basePrice.toFixed(2), basePrice.toFixed(2), basePrice);
    }
    if (dto.isPublished !== undefined) change('isPublished', current.isPublished, dto.isPublished);

    try {
      await this.prisma.$transaction(async (tx) => {
        await lockProduct(tx, productId);

        if (dto.isPublished === true) {
          const locked = await tx.product.findUniqueOrThrow({
            where: { id: productId },
            select: { isBlockedByAdmin: true, _count: { select: { variants: { where: { isActive: true } } } } },
          });
          if (locked.isBlockedByAdmin) {
            throw new ForbiddenException('This product is blocked by staff and cannot be published');
          }
          if (locked._count.variants === 0) {
            throw new ConflictException('Publishing requires at least one active variant');
          }
        }

        await tx.product.update({ where: { id: productId }, data, select: { id: true } });

        if (gallery !== undefined) {
          before.mediaIds = current.media.map((media) => media.mediaAssetId);
          after.mediaIds = gallery.map((entry) => entry.mediaAssetId);
          await tx.productMedia.deleteMany({ where: { productId } });
          if (gallery.length > 0) {
            await tx.productMedia.createMany({ data: gallery.map((entry) => ({ ...entry, productId })) });
            await tx.mediaAsset.updateMany({
              where: { id: { in: gallery.map((entry) => entry.mediaAssetId) }, vendorId: null },
              data: { vendorId: store.id },
            });
          }
        }

        if (specifications !== undefined) {
          before.specificationCount = await tx.productSpecification.count({ where: { productId } });
          after.specificationCount = specifications.length;
          await tx.productSpecification.deleteMany({ where: { productId } });
          if (specifications.length > 0) {
            await tx.productSpecification.createMany({ data: specifications.map((row) => ({ ...row, productId })) });
          }
        }

        await this.audit(tx, { ...params, action: AuditAction.UPDATE, entityId: productId, oldValue: before, newValue: after });
      });
    } catch (error) {
      if (uniqueViolationTarget(error) === 'slug') {
        throw new ConflictException(`Slug "${dto.slug ?? ''}" is already taken`);
      }
      throw translateCheckViolation(error);
    }

    await this.catalogChanged();
    return this.requireOwnDetail(store.id, productId);
  }

  /** Archives a product: it is unpublished and leaves the storefront; data and history are kept. */
  async archive(userId: string, productId: string, params: ActorParams): Promise<ArchiveProductResponseDto> {
    const store = await this.requireStore(userId, 'write');
    const current = await this.requireOwnProduct(store.id, productId);

    if (!current.isPublished) {
      return { id: current.id, slug: current.slug, isPublished: false, wasPublished: false, auditLogId: null };
    }

    const auditLogId = await this.prisma.$transaction(async (tx) => {
      await tx.product.update({ where: { id: productId }, data: { isPublished: false }, select: { id: true } });
      return this.audit(tx, {
        ...params,
        action: AuditAction.STATUS_CHANGE,
        entityId: productId,
        oldValue: { isPublished: true },
        newValue: { isPublished: false, reason: 'archived by vendor' },
      });
    });

    await this.catalogChanged();
    return { id: current.id, slug: current.slug, isPublished: false, wasPublished: true, auditLogId };
  }

  // ===========================================================================
  // Vendor: variants
  // ===========================================================================

  async addVariant(userId: string, productId: string, dto: CreateVariantDto, params: ActorParams): Promise<VendorVariantDto> {
    const store = await this.requireStore(userId, 'write');
    await this.requireOwnProduct(store.id, productId);

    const variant = normalizeVariant(dto);
    const problems = variantFieldProblems(variant);
    if (problems.length > 0) {
      throw new BadRequestException(problems);
    }
    await this.assertSkusAvailable([variant.sku]);

    try {
      const created = await this.prisma.$transaction(async (tx) => {
        await lockProduct(tx, productId);
        const siblings = await tx.productVariant.findMany({
          where: { productId },
          select: { colorName: true, size: true, guarantee: true },
        });
        if (siblings.length >= MAX_VARIANTS_PER_PRODUCT) {
          throw new ConflictException(`A product can have at most ${MAX_VARIANTS_PER_PRODUCT} variants`);
        }
        const key = variantMatrixKey(variant);
        if (siblings.some((sibling) => variantMatrixKey(sibling) === key)) {
          throw new ConflictException('A variant with the same colour, size and guarantee already exists on this product');
        }

        const row = await tx.productVariant.create({
          data: {
            ...variant,
            productId,
            price: toMoney(variant.price),
            compareAtPrice: variant.compareAtPrice === null ? null : toMoney(variant.compareAtPrice),
          },
          select: variantSelect,
        });
        await this.audit(tx, {
          ...params,
          action: AuditAction.CREATE,
          entityName: 'ProductVariant',
          entityId: row.id,
          newValue: { productId, ...variant },
        });
        return row;
      });

      await this.catalogChanged();
      return toVendorVariant(created);
    } catch (error) {
      if (uniqueViolationTarget(error) === 'sku') {
        throw new ConflictException(`SKU ${variant.sku} is already used by another variant`);
      }
      throw translateCheckViolation(error);
    }
  }

  async updateVariant(
    userId: string,
    variantId: string,
    dto: UpdateVariantDto,
    params: ActorParams,
  ): Promise<VendorVariantDto> {
    assertNotEmpty(dto);
    if (dto.stockQuantity !== undefined && dto.stockDelta !== undefined) {
      throw new BadRequestException('Send either stockQuantity (absolute) or stockDelta (relative), not both');
    }

    const store = await this.requireStore(userId, 'write');
    const current = await this.prisma.productVariant.findFirst({
      where: { id: variantId, product: { vendorId: store.id } },
      select: { ...variantSelect, productId: true },
    });
    if (!current) {
      throw new NotFoundException('Variant not found');
    }

    const nextPrice = dto.price ?? current.price.toNumber();
    const nextCompareAt =
      dto.compareAtPrice !== undefined ? dto.compareAtPrice : (current.compareAtPrice?.toNumber() ?? null);
    const problems = variantFieldProblems({ sku: current.sku, price: nextPrice, compareAtPrice: nextCompareAt });
    if (problems.length > 0) {
      throw new BadRequestException(problems);
    }

    const scalar: Prisma.ProductVariantUpdateInput = {};
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    if (dto.price !== undefined) {
      scalar.price = toMoney(dto.price);
      before.price = current.price.toFixed(2);
      after.price = toMoney(dto.price).toFixed(2);
    }
    if (dto.compareAtPrice !== undefined) {
      scalar.compareAtPrice = dto.compareAtPrice === null ? null : toMoney(dto.compareAtPrice);
      before.compareAtPrice = current.compareAtPrice?.toFixed(2) ?? null;
      after.compareAtPrice = dto.compareAtPrice === null ? null : toMoney(dto.compareAtPrice).toFixed(2);
    }
    if (dto.isActive !== undefined) {
      scalar.isActive = dto.isActive;
      before.isActive = current.isActive;
      after.isActive = dto.isActive;
    }

    try {
      const updated = await this.prisma.$transaction(async (tx) => {
        await lockProduct(tx, current.productId);

        if (dto.isActive === false && current.isActive) {
          const product = await tx.product.findUniqueOrThrow({
            where: { id: current.productId },
            select: {
              isPublished: true,
              _count: { select: { variants: { where: { isActive: true, id: { not: variantId } } } } },
            },
          });
          if (product.isPublished && product._count.variants === 0) {
            throw new ConflictException(
              'This is the last active variant of a published product; unpublish the product first or activate another variant',
            );
          }
        }

        if (Object.keys(scalar).length > 0) {
          await tx.productVariant.update({ where: { id: variantId }, data: scalar, select: { id: true } });
        }

        let level: StockLevel | undefined;
        if (dto.stockQuantity !== undefined) {
          level = await this.inventory.setStock(variantId, dto.stockQuantity, tx);
        } else if (dto.stockDelta !== undefined) {
          level = await this.inventory.adjustStock(variantId, dto.stockDelta, tx);
        }
        if (level) {
          before.stockQuantity = current.stockQuantity;
          after.stockQuantity = level.stockQuantity;
          if (dto.stockDelta !== undefined) after.stockDelta = dto.stockDelta;
        }

        await this.audit(tx, {
          ...params,
          action: AuditAction.UPDATE,
          entityName: 'ProductVariant',
          entityId: variantId,
          oldValue: before,
          newValue: after,
        });
        return tx.productVariant.findUniqueOrThrow({ where: { id: variantId }, select: variantSelect });
      });

      await this.catalogChanged();
      return toVendorVariant(updated);
    } catch (error) {
      throw translateCheckViolation(error);
    }
  }

  // ===========================================================================
  // Staff
  // ===========================================================================

  async listForAdmin(query: AdminProductQueryDto): Promise<{ rows: AdminProductDto[]; total: number }> {
    const where: Prisma.ProductWhereInput = {
      ...searchFilter(query.search),
      ...(query.vendorSlug !== undefined ? { vendor: { storeSlug: query.vendorSlug.trim().toLowerCase() } } : {}),
      ...(query.isBlockedByAdmin !== undefined ? { isBlockedByAdmin: query.isBlockedByAdmin } : {}),
      ...(query.isPublished !== undefined ? { isPublished: query.isPublished } : {}),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.product.findMany({
        where,
        select: productSummarySelect,
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.product.count({ where }),
    ]);
    return { rows: rows.map((row) => toAdminProduct(row)), total };
  }

  async setStatus(productId: string, dto: AdminProductStatusDto, params: ActorParams): Promise<AdminProductStatusResponseDto> {
    if (dto.isBlockedByAdmin === undefined && dto.isPublished === undefined) {
      throw new BadRequestException('Send isBlockedByAdmin and/or isPublished');
    }
    if (dto.isBlockedByAdmin === true && !dto.blockedReason) {
      throw new BadRequestException('blockedReason is required when blocking a product');
    }
    if (dto.isBlockedByAdmin !== true && dto.blockedReason) {
      throw new BadRequestException('blockedReason is only accepted together with isBlockedByAdmin: true');
    }

    const { auditLogId, changed } = await this.prisma.$transaction(async (tx) => {
      await lockProduct(tx, productId);
      const current = await tx.product.findUnique({
        where: { id: productId },
        select: {
          isPublished: true,
          isBlockedByAdmin: true,
          blockedReason: true,
          blockedAt: true,
          vendor: { select: { status: true } },
          _count: { select: { variants: { where: { isActive: true } } } },
        },
      });
      if (!current) {
        throw new NotFoundException('Product not found');
      }

      const data: Prisma.ProductUncheckedUpdateInput = {};
      const willBeBlocked = dto.isBlockedByAdmin ?? current.isBlockedByAdmin;

      if (dto.isBlockedByAdmin === true) {
        // Blocking also unpublishes, so lifting the block later never makes the
        // product reappear without the vendor deciding to publish it again.
        Object.assign(data, {
          isBlockedByAdmin: true,
          blockedReason: dto.blockedReason,
          blockedAt: new Date(),
          blockedByUserId: params.actorId,
          isPublished: false,
        });
      } else if (dto.isBlockedByAdmin === false) {
        Object.assign(data, { isBlockedByAdmin: false, blockedReason: null, blockedAt: null, blockedByUserId: null });
      }

      if (dto.isPublished === true) {
        if (willBeBlocked) {
          throw new ConflictException('A blocked product cannot be published; lift the block first');
        }
        if (current.vendor.status !== VendorStatus.APPROVED) {
          throw new ConflictException(`The store is ${current.vendor.status}; only products of APPROVED stores can be published`);
        }
        if (current._count.variants === 0) {
          throw new ConflictException('Publishing requires at least one active variant');
        }
        data.isPublished = true;
      } else if (dto.isPublished === false) {
        data.isPublished = false;
      }

      const before = {
        isPublished: current.isPublished,
        isBlockedByAdmin: current.isBlockedByAdmin,
        blockedReason: current.blockedReason,
      };
      const after = {
        isPublished: (data.isPublished as boolean | undefined) ?? current.isPublished,
        isBlockedByAdmin: (data.isBlockedByAdmin as boolean | undefined) ?? current.isBlockedByAdmin,
        blockedReason: data.blockedReason !== undefined ? (data.blockedReason as string | null) : current.blockedReason,
      };
      const changedKeys = (Object.keys(after) as Array<keyof typeof after>).filter((key) => after[key] !== before[key]);

      await tx.product.update({ where: { id: productId }, data, select: { id: true } });
      const auditId = await this.audit(tx, {
        ...params,
        action: AuditAction.STATUS_CHANGE,
        entityId: productId,
        oldValue: before,
        newValue: { ...after, changed: changedKeys, by: 'staff' },
      });
      return { auditLogId: auditId, changed: changedKeys };
    });

    this.logger.log(`Product ${productId} moderated by ${params.actorId}: ${changed.join(', ') || 'no change'}`);
    await this.catalogChanged();

    const product = await this.prisma.product.findUniqueOrThrow({ where: { id: productId }, select: productSummarySelect });
    return { product: toAdminProduct(product), auditLogId, changed };
  }

  // ===========================================================================
  // Bulk publish of drafts (vendor: own store; staff: all stores or one)
  // ===========================================================================

  async draftSummaryForVendor(userId: string): Promise<DraftPublishSummaryDto> {
    const store = await this.requireStore(userId, 'write');
    return this.draftSummary({ vendorId: store.id });
  }

  async publishDraftsForVendor(userId: string, params: ActorParams): Promise<PublishDraftsResponseDto> {
    const store = await this.requireStore(userId, 'write');
    return this.publishDrafts({ vendorId: store.id }, params, 'vendor');
  }

  async draftSummaryForAdmin(vendorSlug: string | undefined): Promise<DraftPublishSummaryDto> {
    return this.draftSummary(await this.adminDraftScope(vendorSlug));
  }

  async publishDraftsForAdmin(vendorSlug: string | undefined, params: ActorParams): Promise<PublishDraftsResponseDto> {
    return this.publishDrafts(await this.adminDraftScope(vendorSlug), params, 'staff');
  }

  /**
   * Counts the unpublished products of the scope by what publishing them
   * would need. Uses exactly the rules of single-product publishing: not
   * blocked by staff, store APPROVED, at least one active variant.
   */
  async draftSummary(scope: DraftScope): Promise<DraftPublishSummaryDto> {
    const drafts = draftScopeWhere(scope);
    const [blocked, storeNotApproved, noActiveVariant, publishable] = await this.prisma.$transaction([
      this.prisma.product.count({ where: { AND: [drafts, { isBlockedByAdmin: true }] } }),
      this.prisma.product.count({ where: { AND: [drafts, { isBlockedByAdmin: false, vendor: { status: { not: VendorStatus.APPROVED } } }] } }),
      this.prisma.product.count({
        where: { AND: [drafts, { isBlockedByAdmin: false, vendor: { status: VendorStatus.APPROVED }, variants: { none: { isActive: true } } }] },
      }),
      this.prisma.product.count({ where: publishableDraftWhere(scope) }),
    ]);
    return { publishable, blocked, noActiveVariant, storeNotApproved };
  }

  /**
   * Publishes every draft of the scope that meets the publishing rules.
   * Works in batches: each batch locks its rows (same row lock as single
   * edits, taken in id order), re-checks the rules under the lock, flips
   * `isPublished` and writes one STATUS_CHANGE audit row per product, all in
   * one transaction. Drafts that do not qualify are left untouched and
   * reported in `remaining`.
   */
  async publishDrafts(scope: DraftScope, params: ActorParams, by: 'vendor' | 'staff'): Promise<PublishDraftsResponseDto> {
    const where = publishableDraftWhere(scope);
    let published = 0;
    // Each pass either publishes its candidates or finds none; the bound only guards against a runaway loop.
    for (let pass = 0; pass < 10_000; pass += 1) {
      const outcome = await this.prisma.$transaction(async (tx) => {
        const candidates = await tx.product.findMany({ where, select: { id: true }, orderBy: { id: 'asc' }, take: PUBLISH_DRAFTS_BATCH });
        if (candidates.length === 0) return { found: 0, published: 0 };
        const ids = candidates.map((candidate) => candidate.id);
        await tx.$queryRaw(Prisma.sql`SELECT id FROM products WHERE id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))}) ORDER BY id FOR UPDATE`);
        const still = await tx.product.findMany({ where: { AND: [where, { id: { in: ids } }] }, select: { id: true } });
        const confirmed = still.map((row) => row.id);
        if (confirmed.length > 0) {
          await tx.product.updateMany({ where: { id: { in: confirmed } }, data: { isPublished: true } });
          await tx.auditLog.createMany({
            data: confirmed.map((id) => ({
              userId: params.actorId,
              action: AuditAction.STATUS_CHANGE,
              entityName: 'Product',
              entityId: id,
              ipAddress: params.context.ipAddress,
              userAgent: params.context.userAgent,
              oldValue: { isPublished: false },
              newValue: { isPublished: true, changed: ['isPublished'], by, bulk: 'publish-drafts' },
            })),
          });
        }
        return { found: candidates.length, published: confirmed.length };
      });
      published += outcome.published;
      if (outcome.found === 0) break;
    }

    if (published > 0) {
      this.logger.log(`Bulk publish by ${params.actorId} (${by}, ${scope.vendorId !== undefined ? `store ${scope.vendorId}` : 'all stores'}): ${published} product(s)`);
      await this.catalogChanged();
    }
    return { published, remaining: await this.draftSummary(scope) };
  }

  private async adminDraftScope(vendorSlug: string | undefined): Promise<DraftScope> {
    const slug = vendorSlug?.trim().toLowerCase();
    if (!slug) return {};
    const store = await this.prisma.vendor.findUnique({ where: { storeSlug: slug }, select: { id: true } });
    if (!store) throw new NotFoundException('No store with this slug');
    return { vendorId: store.id };
  }

  // ===========================================================================
  // Internals
  // ===========================================================================

  /**
   * The caller's store. Reads are allowed for APPROVED and SUSPENDED stores (a
   * suspended vendor may still see what it sells); writes only for APPROVED.
   */
  private async requireStore(userId: string, mode: 'read' | 'write'): Promise<StoreRef> {
    const store = await this.prisma.vendor.findUnique({
      where: { userId },
      select: { id: true, storeSlug: true, status: true },
    });
    if (!store) {
      throw new ForbiddenException('This account has no store; register one with POST /vendors/register');
    }
    const allowed =
      store.status === VendorStatus.APPROVED || (mode === 'read' && store.status === VendorStatus.SUSPENDED);
    if (!allowed) {
      throw new ForbiddenException(
        `The store is ${store.status}; only APPROVED stores can ${mode === 'write' ? 'manage' : 'view'} products`,
      );
    }
    return store;
  }

  private async requireOwnProduct(
    vendorId: string,
    productId: string,
  ): Promise<
    Prisma.ProductGetPayload<{ include: { media: { select: { mediaAssetId: true } } } }>
  > {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, vendorId },
      include: { media: { select: { mediaAssetId: true }, orderBy: { sortOrder: 'asc' } } },
    });
    if (!product) {
      throw new NotFoundException('Product not found');
    }
    return product;
  }

  private async requireOwnDetail(vendorId: string, productId: string): Promise<VendorProductDetailDto> {
    const product = await this.prisma.product.findFirst({ where: { id: productId, vendorId }, select: productDetailSelect });
    if (!product) {
      throw new NotFoundException('Product not found');
    }
    return toVendorDetail(product);
  }

  private async requireActiveCategory(categoryId: string): Promise<void> {
    const category = await this.prisma.category.findUnique({ where: { id: categoryId }, select: { isActive: true } });
    if (!category || !category.isActive) {
      throw new BadRequestException('categoryId does not reference an active category');
    }
  }

  private async assertSkusAvailable(skus: string[]): Promise<void> {
    const taken = await this.prisma.productVariant.findMany({ where: { sku: { in: skus } }, select: { sku: true } });
    if (taken.length > 0) {
      throw new ConflictException(`SKU already in use: ${taken.map((row) => row.sku).sort().join(', ')}`);
    }
  }

  private async assertSlugAvailable(slug: string): Promise<void> {
    const taken = await this.prisma.product.findUnique({ where: { slug }, select: { id: true } });
    if (taken) {
      throw new ConflictException(`Slug "${slug}" is already taken`);
    }
  }

  /** `base`, or `base-2`, `base-3`… — the first one not taken. */
  private async nextFreeSlug(base: string): Promise<string> {
    const rows = await this.prisma.product.findMany({
      where: { slug: { startsWith: base } },
      select: { slug: true },
    });
    const taken = new Set(rows.map((row) => row.slug));
    if (!taken.has(base)) {
      return base;
    }
    for (let n = 2; n < 1000; n += 1) {
      const candidate = withSuffix(base, String(n));
      if (!taken.has(candidate)) {
        return candidate;
      }
    }
    return withSuffix(base, randomSuffix());
  }

  /**
   * Resolves an ordered list of media ids into gallery rows. Each id must be a
   * public image uploaded by the caller with purpose `product_image`; anything
   * else (another user's file, a KYC document, a store logo) is refused.
   */
  private async resolveGallery(ownerUserId: string, mediaIds: string[]): Promise<GalleryEntry[]> {
    if (mediaIds.length === 0) {
      return [];
    }
    const assets = await this.prisma.mediaAsset.findMany({
      where: { id: { in: mediaIds } },
      select: { id: true, ownerUserId: true, kind: true, purpose: true, isPublic: true, url: true, thumbnailUrl: true },
    });
    const byId = new Map(assets.map((asset) => [asset.id, asset]));
    const unusable = mediaIds.filter((id) => {
      const asset = byId.get(id);
      return (
        !asset ||
        asset.ownerUserId !== ownerUserId ||
        asset.kind !== MediaKind.IMAGE ||
        !asset.isPublic ||
        asset.purpose !== PRODUCT_IMAGE_PURPOSE
      );
    });
    if (unusable.length > 0) {
      throw new BadRequestException(
        `mediaIds must be images uploaded by this account with purpose "${PRODUCT_IMAGE_PURPOSE}": ${unusable.join(', ')}`,
      );
    }
    return mediaIds.map((id, index) => {
      const asset = byId.get(id) as NonNullable<ReturnType<typeof byId.get>>;
      return {
        mediaAssetId: asset.id,
        url: asset.url,
        thumbnailUrl: asset.thumbnailUrl,
        isPrimary: index === 0,
        sortOrder: (index + 1) * 10,
      };
    });
  }

  private async audit(
    tx: Tx,
    entry: ActorParams & {
      action: AuditAction;
      entityId: string;
      entityName?: string;
      oldValue?: Record<string, unknown>;
      newValue: Record<string, unknown>;
    },
  ): Promise<string> {
    const row = await tx.auditLog.create({
      data: {
        userId: entry.actorId,
        action: entry.action,
        entityName: entry.entityName ?? 'Product',
        entityId: entry.entityId,
        ipAddress: entry.context.ipAddress,
        userAgent: entry.context.userAgent,
        ...(entry.oldValue !== undefined ? { oldValue: sanitize(entry.oldValue) as Prisma.InputJsonValue } : {}),
        newValue: sanitize(entry.newValue) as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    return row.id;
  }
}

// =============================================================================
// Helpers
// =============================================================================

function normalizeVariant(dto: CreateVariantDto): NormalizedVariant {
  const text = (value: string | null | undefined): string | null =>
    value === null || value === undefined ? null : normalizePersianText(value) || null;
  return {
    sku: dto.sku,
    colorName: text(dto.colorName),
    colorHex: dto.colorHex ?? null,
    size: text(dto.size),
    guarantee: text(dto.guarantee),
    price: dto.price,
    compareAtPrice: dto.compareAtPrice ?? null,
    stockQuantity: dto.stockQuantity,
    weightGrams: dto.weightGrams ?? null,
    isActive: dto.isActive ?? true,
  };
}

/** Row-locks a product for the rest of the transaction (serialises publish/deactivate races). */
/** Unpublished products of the scope. */
function draftScopeWhere(scope: DraftScope): Prisma.ProductWhereInput {
  return {
    isPublished: false,
    ...(scope.vendorId !== undefined ? { vendorId: scope.vendorId } : {}),
  };
}

/** Drafts of the scope that may be published: the single-product publishing rules, as a filter. */
export function publishableDraftWhere(scope: DraftScope): Prisma.ProductWhereInput {
  return {
    AND: [draftScopeWhere(scope), { isBlockedByAdmin: false, vendor: { status: VendorStatus.APPROVED }, variants: { some: { isActive: true } } }],
  };
}

async function lockProduct(tx: Tx, productId: string): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`SELECT id FROM products WHERE id = ${productId}::uuid FOR UPDATE`,
  );
  if (rows.length === 0) {
    throw new NotFoundException('Product not found');
  }
}

function assertNotEmpty(dto: object): void {
  if (!Object.values(dto).some((value) => value !== undefined)) {
    throw new BadRequestException('Send at least one field to update');
  }
}

function statusFilter(status: VendorProductQueryDto['status']): Prisma.ProductWhereInput {
  switch (status) {
    case 'published':
      return { isPublished: true, isBlockedByAdmin: false };
    case 'draft':
      return { isPublished: false, isBlockedByAdmin: false };
    case 'blocked':
      return { isBlockedByAdmin: true };
    default:
      return {};
  }
}

function searchFilter(search: string | undefined): Prisma.ProductWhereInput {
  const term = search === undefined ? '' : normalizePersianText(search);
  if (term.length === 0) {
    return {};
  }
  return {
    OR: [
      { title: { contains: term, mode: 'insensitive' } },
      { slug: { contains: term.toLowerCase() } },
      { variants: { some: { sku: { contains: term.toUpperCase() } } } },
    ],
  };
}

function withSuffix(base: string, suffix: string): string {
  const room = PRODUCT_SLUG_MAX_LENGTH - suffix.length - 1;
  return `${base.slice(0, room).replace(/-+$/, '')}-${suffix}`;
}

function randomSuffix(): string {
  return randomBytes(3).toString('hex');
}

/** `'sku' | 'slug' | null` for a unique-constraint violation on products/variants. */
function uniqueViolationTarget(error: unknown): 'sku' | 'slug' | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return null;
  }
  const target: unknown = error.meta?.target;
  const fields = Array.isArray(target) ? target.filter((item): item is string => typeof item === 'string') : typeof target === 'string' ? [target] : [];
  if (fields.some((field) => field.includes('sku'))) return 'sku';
  if (fields.some((field) => field.includes('slug'))) return 'slug';
  return null;
}

/** A CHECK constraint fired (a path the service did not pre-validate): report it as a 400. */
function translateCheckViolation(error: unknown): unknown {
  const message = error instanceof Error ? error.message : '';
  if (message.includes('23514') || message.includes('violates check constraint')) {
    const constraint = /constraint "([^"]+)"/.exec(message)?.[1];
    return new BadRequestException(
      `The change violates a catalogue invariant${constraint ? ` (${constraint})` : ''}: price must be > 0, ` +
        'compareAtPrice > price, and 0 <= reserved <= stock',
    );
  }
  return error;
}
