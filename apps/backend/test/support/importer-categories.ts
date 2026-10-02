import type { PrismaService } from '../../src/infra/prisma/prisma.service';
import type { CategoriesService } from '../../src/modules/categories/categories.service';

/**
 * The storefront seeds four root departments only. The importer's category
 * matcher compares source labels with local category titles, so the importer
 * suites add a «گوشی موبایل» sub-category under «کالای دیجیتال» for the run
 * (exactly what an admin would do through the category admin) and remove it
 * afterwards.
 */
export interface ImporterCategoryIds {
  /** Temporary «گوشی موبایل» child of digital-goods. */
  mobile: string;
  /** The seeded «کالای دیجیتال» root (slug digital-goods). */
  digital: string;
  /** The seeded «دکوراسیون» root (slug home-decor) — matched by no fixture. */
  decor: string;
}

const TEMP_PREFIX = 'e2e-importer-mobile-';

export async function createImporterCategories(prisma: PrismaService, categories: CategoriesService, run: string): Promise<ImporterCategoryIds> {
  const roots = await prisma.category.findMany({ where: { slug: { in: ['digital-goods', 'home-decor'] }, isActive: true }, select: { id: true, slug: true } });
  const digital = roots.find((row) => row.slug === 'digital-goods')?.id;
  const decor = roots.find((row) => row.slug === 'home-decor')?.id;
  if (digital === undefined || decor === undefined) throw new Error('The seeded categories "digital-goods" and "home-decor" are required (pnpm db:seed).');
  // Leftovers of an aborted run would shadow the new row in the title matcher.
  await removeImporterCategories(prisma, categories);
  const mobile = await prisma.category.create({
    data: { slug: `${TEMP_PREFIX}${run}`.slice(0, 80), titleFa: 'گوشی موبایل', titleEn: 'Mobile Phones', parentId: digital, defaultCommissionRate: '5.00', sortOrder: 10 },
    select: { id: true },
  });
  await categories.invalidateTree();
  return { mobile: mobile.id, digital, decor };
}

/** Deletes the temporary categories (call after the suite's products are gone). */
export async function removeImporterCategories(prisma: PrismaService, categories: CategoriesService): Promise<void> {
  const stale = await prisma.category.findMany({ where: { slug: { startsWith: TEMP_PREFIX } }, select: { id: true } });
  const ids = stale.map((row) => row.id);
  if (ids.length === 0) return;
  // A product left behind by an aborted run moves to the root so the row can go.
  const digital = await prisma.category.findUnique({ where: { slug: 'digital-goods' }, select: { id: true } });
  if (digital !== null) await prisma.product.updateMany({ where: { categoryId: { in: ids } }, data: { categoryId: digital.id } });
  await prisma.category.deleteMany({ where: { id: { in: ids } } });
  await categories.invalidateTree();
}
