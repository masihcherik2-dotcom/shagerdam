import { Prisma, VendorStatus } from '@prisma/client';

/**
 * The single definition of "a product the public may see". Every public read —
 * the category tree counts, the search listing and the product page — goes
 * through these predicates so the three can never disagree.
 *
 * A product is publicly visible when:
 * 1. the vendor published it (`is_published`);
 * 2. staff have not blocked it (`NOT is_blocked_by_admin`);
 * 3. its store is `APPROVED` (a suspended store disappears with its catalogue);
 * 4. its category is reachable in the active category tree (checked by the
 *    caller against the cached tree, see `CategoriesService.visibleCategoryIds`);
 * 5. it has at least one active variant — a product without a sellable variant
 *    is not sellable, so it is not listed.
 */

/** SQL predicate over `products p` joined to `vendors v`. Excludes rule 4. */
export function visibleProductSql(): Prisma.Sql {
  return Prisma.sql`p.is_published = true
    AND p.is_blocked_by_admin = false
    AND v.status = 'APPROVED'
    AND EXISTS (SELECT 1 FROM product_variants av WHERE av.product_id = p.id AND av.is_active = true)`;
}

/** The same rule for the Prisma query builder. Rule 4 is added by the caller. */
export function visibleProductWhere(): Prisma.ProductWhereInput {
  return {
    isPublished: true,
    isBlockedByAdmin: false,
    vendor: { status: VendorStatus.APPROVED },
    variants: { some: { isActive: true } },
  };
}
