import {
  breadcrumbOf,
  buildCategoryTree,
  descendantIdsInGraph,
  indexCategoryTree,
  subtreeIds,
  type CategoryNode,
  type CategoryRow,
} from './category-tree';

function row(id: string, parentId: string | null, sortOrder = 0, titleFa = id): CategoryRow {
  return { id, parentId, slug: `slug-${id}`, titleFa, titleEn: null, defaultCommissionRate: '5.00', sortOrder };
}

function ids(nodes: CategoryNode[]): string[] {
  return nodes.map((node) => node.id);
}

describe('buildCategoryTree', () => {
  it('returns an empty forest for no rows', () => {
    expect(buildCategoryTree([])).toEqual([]);
  });

  it('keeps a root without children as a leaf at depth 0', () => {
    const [root] = buildCategoryTree([row('a', null)]);
    expect(root).toMatchObject({ id: 'a', depth: 0, children: [], productCount: 0, totalProductCount: 0 });
  });

  it('nests deep chains recursively with the right depth on every level', () => {
    const rows = [row('l4', 'l3'), row('l2', 'l1'), row('root', null), row('l3', 'l2'), row('l1', 'root')];
    const [root] = buildCategoryTree(rows);

    let node = root as CategoryNode;
    const chain: Array<[string, number]> = [];
    for (;;) {
      chain.push([node.id, node.depth]);
      if (node.children.length === 0) break;
      expect(node.children).toHaveLength(1);
      node = node.children[0] as CategoryNode;
    }
    expect(chain).toEqual([
      ['root', 0],
      ['l1', 1],
      ['l2', 2],
      ['l3', 3],
      ['l4', 4],
    ]);
  });

  it('orders siblings by sortOrder, then Persian title', () => {
    const rows = [
      row('root', null),
      row('c', 'root', 20, 'ب'),
      row('b', 'root', 10, 'ی'),
      row('a', 'root', 20, 'الف'),
    ];
    const [root] = buildCategoryTree(rows);
    expect(ids(root?.children ?? [])).toEqual(['b', 'a', 'c']);
  });

  it('orders several roots deterministically', () => {
    const tree = buildCategoryTree([row('r2', null, 2), row('r1', null, 1), row('r3', null, 3)]);
    expect(ids(tree)).toEqual(['r1', 'r2', 'r3']);
  });

  it('does not promote an orphan (parent filtered out) to a root', () => {
    const tree = buildCategoryTree([row('root', null), row('orphan', 'inactive-parent'), row('grandchild', 'orphan')]);
    expect(ids(tree)).toEqual(['root']);
    expect(indexCategoryTree(tree).byId.has('orphan')).toBe(false);
    expect(indexCategoryTree(tree).byId.has('grandchild')).toBe(false);
  });

  it('never loops or surfaces nodes that sit on a parent cycle', () => {
    const tree = buildCategoryTree([row('root', null), row('x', 'y'), row('y', 'x')]);
    expect(ids(tree)).toEqual(['root']);
  });

  it('aggregates direct counts into subtree totals at every level', () => {
    const rows = [row('root', null), row('a', 'root'), row('a1', 'a'), row('a2', 'a'), row('b', 'root')];
    const counts = new Map([
      ['root', 1],
      ['a', 2],
      ['a1', 3],
      ['a2', 4],
      ['b', 5],
    ]);
    const index = indexCategoryTree(buildCategoryTree(rows, counts));

    expect(index.byId.get('a1')).toMatchObject({ productCount: 3, totalProductCount: 3 });
    expect(index.byId.get('a')).toMatchObject({ productCount: 2, totalProductCount: 9 });
    expect(index.byId.get('root')).toMatchObject({ productCount: 1, totalProductCount: 15 });
  });
});

describe('indexCategoryTree / breadcrumbOf / subtreeIds', () => {
  const rows = [row('root', null), row('mid', 'root'), row('leaf', 'mid'), row('other', null)];
  const index = indexCategoryTree(buildCategoryTree(rows));

  it('indexes every reachable node by id and slug', () => {
    expect([...index.byId.keys()].sort()).toEqual(['leaf', 'mid', 'other', 'root']);
    expect(index.bySlug.get('slug-leaf')?.id).toBe('leaf');
  });

  it('builds the breadcrumb from the root down to the node itself', () => {
    expect(breadcrumbOf(index, 'leaf').map((node) => node.id)).toEqual(['root', 'mid', 'leaf']);
    expect(breadcrumbOf(index, 'root').map((node) => node.id)).toEqual(['root']);
  });

  it('returns an empty breadcrumb for an unknown node', () => {
    expect(breadcrumbOf(index, 'missing')).toEqual([]);
  });

  it('collects a node and all its descendants', () => {
    const root = index.byId.get('root') as CategoryNode;
    expect(subtreeIds(root)).toEqual(['root', 'mid', 'leaf']);
    expect(subtreeIds(index.byId.get('leaf') as CategoryNode)).toEqual(['leaf']);
  });
});

describe('descendantIdsInGraph', () => {
  it('finds every descendant in the raw graph, including inactive branches', () => {
    const graph = [
      { id: 'root', parentId: null },
      { id: 'a', parentId: 'root' },
      { id: 'a1', parentId: 'a' },
      { id: 'b', parentId: 'root' },
    ];
    expect([...descendantIdsInGraph(graph, 'root')].sort()).toEqual(['a', 'a1', 'b']);
    expect([...descendantIdsInGraph(graph, 'a')]).toEqual(['a1']);
    expect(descendantIdsInGraph(graph, 'a1').size).toBe(0);
  });

  it('terminates on a corrupt cycle', () => {
    const graph = [
      { id: 'x', parentId: 'y' },
      { id: 'y', parentId: 'x' },
    ];
    expect([...descendantIdsInGraph(graph, 'x')]).toEqual(['y']);
  });
});
