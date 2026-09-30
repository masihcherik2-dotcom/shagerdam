/**
 * Pure functions that turn the flat `categories` table into the nested tree the
 * storefront renders. Kept free of Prisma/Nest so the recursion rules (ordering,
 * orphan handling, cycle safety, subtree counts) are unit-testable in isolation.
 */

/** One row of the `categories` table, as the tree builder needs it. */
export interface CategoryRow {
  id: string;
  parentId: string | null;
  slug: string;
  titleFa: string;
  titleEn: string | null;
  /** Percentage with two decimals, e.g. `"5.00"`. */
  defaultCommissionRate: string;
  sortOrder: number;
}

export interface CategoryNode extends CategoryRow {
  /** Distance from the root: roots are depth 0. */
  depth: number;
  /** Publicly visible products placed directly in this category. */
  productCount: number;
  /** Publicly visible products in this category and every descendant. */
  totalProductCount: number;
  children: CategoryNode[];
}

/** Flat lookup over a built tree: every reachable node by id and by slug. */
export interface CategoryIndex {
  roots: CategoryNode[];
  byId: ReadonlyMap<string, CategoryNode>;
  bySlug: ReadonlyMap<string, CategoryNode>;
}

const PERSIAN_COLLATOR = new Intl.Collator('fa');

function compareSiblings(left: CategoryRow, right: CategoryRow): number {
  return (
    left.sortOrder - right.sortOrder ||
    PERSIAN_COLLATOR.compare(left.titleFa, right.titleFa) ||
    left.slug.localeCompare(right.slug)
  );
}

/**
 * Builds the nested tree.
 *
 * Rules:
 * - roots are rows with `parentId === null`;
 * - a row whose parent is not in `rows` (e.g. the parent is inactive and was
 *   filtered out by the caller) is **not** promoted to a root: hiding a category
 *   hides its whole subtree, exactly as the storefront expects;
 * - siblings are ordered by `sortOrder`, then Persian title, then slug, so the
 *   output is deterministic;
 * - traversal starts from the roots and never revisits a node, so a corrupt
 *   parent cycle can neither loop forever nor surface in the output (a cycle has
 *   no root, therefore it is unreachable).
 */
export function buildCategoryTree(
  rows: readonly CategoryRow[],
  directProductCounts: ReadonlyMap<string, number> = new Map(),
): CategoryNode[] {
  const childrenByParent = new Map<string, CategoryRow[]>();
  const roots: CategoryRow[] = [];

  for (const row of rows) {
    if (row.parentId === null) {
      roots.push(row);
      continue;
    }
    const siblings = childrenByParent.get(row.parentId);
    if (siblings) {
      siblings.push(row);
    } else {
      childrenByParent.set(row.parentId, [row]);
    }
  }

  const visited = new Set<string>();

  const toNode = (row: CategoryRow, depth: number): CategoryNode => {
    visited.add(row.id);
    const children = (childrenByParent.get(row.id) ?? [])
      .filter((child) => !visited.has(child.id))
      .sort(compareSiblings)
      .map((child) => toNode(child, depth + 1));

    const productCount = directProductCounts.get(row.id) ?? 0;
    const totalProductCount =
      productCount + children.reduce((sum, child) => sum + child.totalProductCount, 0);

    return { ...row, depth, productCount, totalProductCount, children };
  };

  return [...roots].sort(compareSiblings).map((root) => toNode(root, 0));
}

/** Indexes every node of a built tree by id and slug. */
export function indexCategoryTree(roots: CategoryNode[]): CategoryIndex {
  const byId = new Map<string, CategoryNode>();
  const bySlug = new Map<string, CategoryNode>();

  const stack = [...roots];
  while (stack.length > 0) {
    const node = stack.pop() as CategoryNode;
    byId.set(node.id, node);
    bySlug.set(node.slug, node);
    stack.push(...node.children);
  }

  return { roots, byId, bySlug };
}

/**
 * Ancestors of a node from the root down to — and including — the node itself.
 * Returns an empty array when the node is not part of the index.
 */
export function breadcrumbOf(index: CategoryIndex, categoryId: string): CategoryNode[] {
  const path: CategoryNode[] = [];
  const seen = new Set<string>();
  let current = index.byId.get(categoryId);

  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    path.unshift(current);
    current = current.parentId === null ? undefined : index.byId.get(current.parentId);
  }

  return path;
}

/** Ids of a node and all of its descendants (pre-order). */
export function subtreeIds(node: CategoryNode): string[] {
  const ids: string[] = [];
  const stack: CategoryNode[] = [node];
  while (stack.length > 0) {
    const current = stack.pop() as CategoryNode;
    ids.push(current.id);
    for (let i = current.children.length - 1; i >= 0; i -= 1) {
      stack.push(current.children[i] as CategoryNode);
    }
  }
  return ids;
}

/**
 * Ids of every category below `rootId` in the *raw* parent graph (active or not).
 * Used to reject a parent change that would create a cycle: a category may not
 * be moved under itself or under one of its own descendants.
 */
export function descendantIdsInGraph(
  rows: ReadonlyArray<Pick<CategoryRow, 'id' | 'parentId'>>,
  rootId: string,
): Set<string> {
  const childrenByParent = new Map<string, string[]>();
  for (const row of rows) {
    if (row.parentId === null) {
      continue;
    }
    const list = childrenByParent.get(row.parentId);
    if (list) {
      list.push(row.id);
    } else {
      childrenByParent.set(row.parentId, [row.id]);
    }
  }

  const result = new Set<string>();
  const stack = [...(childrenByParent.get(rootId) ?? [])];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (result.has(id) || id === rootId) {
      continue;
    }
    result.add(id);
    stack.push(...(childrenByParent.get(id) ?? []));
  }
  return result;
}
