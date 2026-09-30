import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction, Prisma } from '@prisma/client';
import type { RequestContext } from '../../common/types/request-context';
import { errorMessage } from '../../common/utils';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { RedisService } from '../../infra/redis/redis.service';
import { sanitize } from '../audit/audit-log.service';
import { visibleProductSql } from './catalog-visibility';
import {
  breadcrumbOf,
  buildCategoryTree,
  descendantIdsInGraph,
  indexCategoryTree,
  subtreeIds,
  type CategoryIndex,
  type CategoryNode,
  type CategoryRow,
} from './category-tree';
import type { CreateCategoryDto, UpdateCategoryDto } from './dto/category-input.dto';
import type { AdminCategoryDto } from './dto/category-response.dto';

/**
 * Redis key of the cached public tree (rows + visible product counts).
 *
 * The tree is read on every storefront page, while categories change rarely.
 * Counts change whenever a product becomes (in)visible, so every write that can
 * change visibility calls `invalidateTree()`; the TTL is only a safety net for a
 * missed invalidation (e.g. Redis unavailable at the time of the write).
 */
export const CATEGORY_TREE_CACHE_KEY = 'catalog:category-tree:v1';
const CATEGORY_TREE_TTL_SECONDS = 300;

interface CachedTree {
  rows: CategoryRow[];
  counts: Array<[string, number]>;
}

export interface CategoryMutationParams {
  actorId: string;
  context: RequestContext;
}

@Injectable()
export class CategoriesService {
  private readonly logger = new Logger(CategoriesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  // ---------------------------------------------------------------------------
  // Public reads
  // ---------------------------------------------------------------------------

  /** The visible tree, indexed. Served from Redis when warm. */
  async getIndex(): Promise<CategoryIndex> {
    const cached = await this.readCache();
    const source = cached ?? (await this.loadTreeSource());
    if (cached === null) {
      await this.writeCache(source);
    }
    return indexCategoryTree(buildCategoryTree(source.rows, new Map(source.counts)));
  }

  async getTree(): Promise<{ roots: CategoryNode[]; totalCategories: number; totalProducts: number }> {
    const index = await this.getIndex();
    return {
      roots: index.roots,
      totalCategories: index.byId.size,
      totalProducts: index.roots.reduce((sum, root) => sum + root.totalProductCount, 0),
    };
  }

  /** A visible category with its breadcrumb; 404 for unknown or hidden slugs. */
  async getBySlug(slug: string): Promise<{ node: CategoryNode; breadcrumbs: CategoryNode[] }> {
    const index = await this.getIndex();
    const node = index.bySlug.get(slug);
    if (!node) {
      throw new NotFoundException(`Category "${slug}" was not found`);
    }
    return { node, breadcrumbs: breadcrumbOf(index, node.id) };
  }

  /** Every category id reachable in the active tree (rule 4 of catalogue visibility). */
  async visibleCategoryIds(): Promise<string[]> {
    const index = await this.getIndex();
    return [...index.byId.keys()];
  }

  /**
   * Ids of a visible category and all its visible descendants, resolved by slug
   * or id. `null` when the category does not exist or is hidden.
   */
  async visibleSubtreeIds(ref: { slug?: string; id?: string }): Promise<string[] | null> {
    const index = await this.getIndex();
    const node = ref.id !== undefined ? index.byId.get(ref.id) : ref.slug !== undefined ? index.bySlug.get(ref.slug) : undefined;
    return node ? subtreeIds(node) : null;
  }

  async breadcrumbFor(categoryId: string): Promise<CategoryNode[]> {
    return breadcrumbOf(await this.getIndex(), categoryId);
  }

  /** Drops the cached tree. Never throws: a stale cache must not fail a write. */
  async invalidateTree(): Promise<void> {
    try {
      await this.redis.client.del(CATEGORY_TREE_CACHE_KEY);
    } catch (error) {
      this.logger.warn(`Category tree cache invalidation failed: ${errorMessage(error)}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Staff management
  // ---------------------------------------------------------------------------

  async listForAdmin(): Promise<AdminCategoryDto[]> {
    const rows = await this.prisma.category.findMany({
      orderBy: [{ parentId: 'asc' }, { sortOrder: 'asc' }, { slug: 'asc' }],
      include: { _count: { select: { children: true, products: true } } },
    });
    return rows.map((row) => toAdminDto(row, row._count));
  }

  async create(dto: CreateCategoryDto, params: CategoryMutationParams): Promise<AdminCategoryDto> {
    if (dto.parentId) {
      await this.requireCategory(dto.parentId, 'parentId');
    }

    const data = {
      parentId: dto.parentId ?? null,
      slug: dto.slug,
      titleFa: dto.titleFa,
      titleEn: dto.titleEn ?? null,
      defaultCommissionRate: new Prisma.Decimal(dto.defaultCommissionRate.toFixed(2)),
      sortOrder: dto.sortOrder ?? 0,
      isActive: dto.isActive ?? true,
    };

    try {
      const { row, auditLogId } = await this.prisma.$transaction(async (tx) => {
        const created = await tx.category.create({
          data,
          include: { _count: { select: { children: true, products: true } } },
        });
        const audit = await tx.auditLog.create({
          data: {
            userId: params.actorId,
            action: AuditAction.CREATE,
            entityName: 'Category',
            entityId: created.id,
            ipAddress: params.context.ipAddress,
            userAgent: params.context.userAgent,
            newValue: sanitize({ ...data, defaultCommissionRate: data.defaultCommissionRate.toFixed(2) }) as Prisma.InputJsonValue,
          },
          select: { id: true },
        });
        return { row: created, auditLogId: audit.id };
      });

      await this.invalidateTree();
      return { ...toAdminDto(row, row._count), auditLogId };
    } catch (error) {
      throw translateUniqueSlug(error, dto.slug);
    }
  }

  async update(id: string, dto: UpdateCategoryDto, params: CategoryMutationParams): Promise<AdminCategoryDto> {
    const changedKeys = Object.keys(dto).filter((key) => dto[key as keyof UpdateCategoryDto] !== undefined);
    if (changedKeys.length === 0) {
      throw new BadRequestException('Send at least one field to update');
    }

    const current = await this.requireCategory(id, 'id', true);

    if (dto.parentId !== undefined && dto.parentId !== null) {
      if (dto.parentId === id) {
        throw new BadRequestException('A category cannot be its own parent');
      }
      await this.requireCategory(dto.parentId, 'parentId');
      const graph = await this.prisma.category.findMany({ select: { id: true, parentId: true } });
      if (descendantIdsInGraph(graph, id).has(dto.parentId)) {
        throw new BadRequestException('A category cannot be moved under one of its own descendants');
      }
    }

    const data: Prisma.CategoryUncheckedUpdateInput = {};
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    const track = (key: string, previous: unknown, next: unknown): void => {
      before[key] = previous;
      after[key] = next;
    };

    if (dto.parentId !== undefined) {
      data.parentId = dto.parentId;
      track('parentId', current.parentId, dto.parentId);
    }
    if (dto.slug !== undefined) {
      data.slug = dto.slug;
      track('slug', current.slug, dto.slug);
    }
    if (dto.titleFa !== undefined) {
      data.titleFa = dto.titleFa;
      track('titleFa', current.titleFa, dto.titleFa);
    }
    if (dto.titleEn !== undefined) {
      data.titleEn = dto.titleEn;
      track('titleEn', current.titleEn, dto.titleEn);
    }
    if (dto.defaultCommissionRate !== undefined) {
      const rate = new Prisma.Decimal(dto.defaultCommissionRate.toFixed(2));
      data.defaultCommissionRate = rate;
      track('defaultCommissionRate', current.defaultCommissionRate.toFixed(2), rate.toFixed(2));
    }
    if (dto.sortOrder !== undefined) {
      data.sortOrder = dto.sortOrder;
      track('sortOrder', current.sortOrder, dto.sortOrder);
    }
    if (dto.isActive !== undefined) {
      data.isActive = dto.isActive;
      track('isActive', current.isActive, dto.isActive);
    }

    try {
      const { row, auditLogId } = await this.prisma.$transaction(async (tx) => {
        const updated = await tx.category.update({
          where: { id },
          data,
          include: { _count: { select: { children: true, products: true } } },
        });
        const audit = await tx.auditLog.create({
          data: {
            userId: params.actorId,
            action: AuditAction.UPDATE,
            entityName: 'Category',
            entityId: id,
            ipAddress: params.context.ipAddress,
            userAgent: params.context.userAgent,
            oldValue: sanitize(before) as Prisma.InputJsonValue,
            newValue: sanitize(after) as Prisma.InputJsonValue,
          },
          select: { id: true },
        });
        return { row: updated, auditLogId: audit.id };
      });

      await this.invalidateTree();
      return { ...toAdminDto(row, row._count), auditLogId };
    } catch (error) {
      throw translateUniqueSlug(error, dto.slug ?? current.slug);
    }
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async requireCategory(
    id: string,
    field: string,
    asResource = false,
  ): Promise<Prisma.CategoryGetPayload<Record<string, never>>> {
    const row = await this.prisma.category.findUnique({ where: { id } });
    if (!row) {
      if (asResource) {
        throw new NotFoundException('Category not found');
      }
      throw new BadRequestException(`${field} does not reference an existing category`);
    }
    return row;
  }

  private async loadTreeSource(): Promise<CachedTree> {
    const [rows, counts] = await Promise.all([
      this.prisma.category.findMany({
        where: { isActive: true },
        select: {
          id: true,
          parentId: true,
          slug: true,
          titleFa: true,
          titleEn: true,
          defaultCommissionRate: true,
          sortOrder: true,
        },
      }),
      this.prisma.$queryRaw<Array<{ categoryId: string; count: number }>>(Prisma.sql`
        SELECT p.category_id AS "categoryId", COUNT(*)::int AS "count"
        FROM products p
        JOIN vendors v ON v.id = p.vendor_id
        WHERE ${visibleProductSql()}
        GROUP BY p.category_id`),
    ]);

    return {
      rows: rows.map((row) => ({ ...row, defaultCommissionRate: row.defaultCommissionRate.toFixed(2) })),
      counts: counts.map((entry) => [entry.categoryId, entry.count]),
    };
  }

  private async readCache(): Promise<CachedTree | null> {
    try {
      const raw = await this.redis.client.get(CATEGORY_TREE_CACHE_KEY);
      if (raw === null) {
        return null;
      }
      const parsed = JSON.parse(raw) as Partial<CachedTree>;
      return Array.isArray(parsed.rows) && Array.isArray(parsed.counts)
        ? { rows: parsed.rows, counts: parsed.counts }
        : null;
    } catch (error) {
      this.logger.warn(`Category tree cache read failed, loading from PostgreSQL: ${errorMessage(error)}`);
      return null;
    }
  }

  private async writeCache(source: CachedTree): Promise<void> {
    try {
      await this.redis.client.set(CATEGORY_TREE_CACHE_KEY, JSON.stringify(source), 'EX', CATEGORY_TREE_TTL_SECONDS);
    } catch (error) {
      this.logger.warn(`Category tree cache write failed: ${errorMessage(error)}`);
    }
  }
}

function toAdminDto(
  row: {
    id: string;
    parentId: string | null;
    slug: string;
    titleFa: string;
    titleEn: string | null;
    defaultCommissionRate: Prisma.Decimal;
    sortOrder: number;
    isActive: boolean;
    createdAt: Date;
    updatedAt: Date;
  },
  counts: { children: number; products: number },
): AdminCategoryDto {
  return {
    id: row.id,
    parentId: row.parentId,
    slug: row.slug,
    titleFa: row.titleFa,
    titleEn: row.titleEn,
    defaultCommissionRate: row.defaultCommissionRate.toFixed(2),
    sortOrder: row.sortOrder,
    isActive: row.isActive,
    childCount: counts.children,
    productCount: counts.products,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function translateUniqueSlug(error: unknown, slug: string): unknown {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    return new ConflictException(`Category slug "${slug}" is already taken`);
  }
  return error;
}
