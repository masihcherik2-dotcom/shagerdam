/**
 * Demo catalogue loader — 2 stores and 18 products with images, specifications,
 * variants and stock (content: `demo-catalog.data.ts`).
 *
 * Run (after the base seed):
 *   SEED_PROFILE=demo pnpm db:seed                   (base seed + this loader)
 *   production: docker compose run --rm -e SEED_PROFILE=demo migrate \
 *                 ts-node --project tsconfig.json prisma/seed.ts
 *
 * Everything goes through the real application services inside a Nest
 * application context — nothing is written around them:
 *   • stores  → VendorsService.createByAdmin (owner, APPROVED store, wallet, audit row)
 *   • images  → MediaService.uploadImage (magic-byte check, WebP, thumbnail,
 *               active storage provider: local disk in development, S3 in production)
 *   • products→ ProductsService.create (validation, variant matrix, gallery, audit row)
 * The actor of every audit row is the super admin (SUPER_ADMIN_MOBILE).
 *
 * Visibility (DEMO_VISIBILITY, default `hidden` when NODE_ENV=production, else `live`):
 *   • hidden — products are created unpublished and new owner accounts are
 *              created deactivated (nobody can sign in to a demo store, even if
 *              the placeholder mobile belongs to a real person). Nothing appears
 *              on the storefront, the sitemap or the Torob feed until an admin
 *              publishes it deliberately.
 *   • live   — products published, owners active (development / test).
 *
 * Idempotent: stores are addressed by slug and products by slug; existing rows
 * are left untouched (an operator's edits are never overwritten).
 * Owner mobiles: DEMO_VENDOR_MOBILES (2 comma-separated numbers) or the
 * development defaults +98912000002{1,2}.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/infra/prisma/prisma.service';
import { MediaService } from '../../src/modules/media/media.service';
import { ProductsService } from '../../src/modules/products/products.service';
import { VendorsService } from '../../src/modules/vendors/vendors.service';
import { toE164 } from '../../src/common/validators/iranian-mobile';
import type { CreateProductDto, CreateVariantDto } from '../../src/modules/products/dto/product-input.dto';
import { DEMO_PRODUCTS, DEMO_STORES, type DemoProduct, type DemoStore } from './demo-catalog.data';

export type DemoVisibility = 'hidden' | 'live';

export interface DemoCatalogSummary {
  visibility: DemoVisibility;
  storesCreated: number;
  storesExisting: number;
  productsCreated: number;
  productsExisting: number;
  images: number;
}

const ASSETS = join(__dirname, 'assets');
const CONTEXT = { ipAddress: null, userAgent: 'demo-catalog-loader' };

export function resolveDemoVisibility(env: NodeJS.ProcessEnv = process.env): DemoVisibility {
  const raw = (env.DEMO_VISIBILITY ?? '').trim().toLowerCase();
  if (raw === '') return env.NODE_ENV === 'production' ? 'hidden' : 'live';
  if (raw === 'hidden' || raw === 'live') return raw;
  throw new Error(`DEMO_VISIBILITY must be "hidden" or "live" (got "${raw}").`);
}

export function resolveDemoMobiles(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = (env.DEMO_VENDOR_MOBILES ?? '').trim();
  if (raw === '') return DEMO_STORES.map((store) => store.defaultMobile);
  const list = raw.split(',').map((value) => toE164(value.trim()));
  if (list.length !== DEMO_STORES.length || list.some((value) => value === null)) {
    throw new Error(`DEMO_VENDOR_MOBILES must list ${DEMO_STORES.length} Iranian mobiles separated by commas.`);
  }
  return list as string[];
}

/** Toman → Rial (the API unit). */
const rial = (toman: number): number => toman * 10;

/** Variant matrix of a demo product: colours × sizes (or one plain variant). */
export function demoVariants(product: DemoProduct, skuPrefix: string): CreateVariantDto[] {
  const colors = product.colors && product.colors.length > 0 ? product.colors : [null];
  const sizes = product.sizes && product.sizes.length > 0 ? product.sizes : [null];
  const cells = colors.flatMap((color) => sizes.map((size) => ({ color, size })));
  const perCell = Math.max(1, Math.floor(product.stock / cells.length));
  return cells.map(({ color, size }, index) => ({
    sku: `${skuPrefix}-${String(index + 1).padStart(2, '0')}`,
    colorName: color?.name ?? null,
    colorHex: color?.hex ?? null,
    size,
    guarantee: product.guarantee ?? null,
    price: rial(product.priceToman),
    compareAtPrice: product.compareAtToman === null ? null : rial(product.compareAtToman),
    stockQuantity: perCell,
    weightGrams: product.weightGrams,
    isActive: true,
  }));
}

export async function loadDemoCatalog(env: NodeJS.ProcessEnv = process.env): Promise<DemoCatalogSummary> {
  const visibility = resolveDemoVisibility(env);
  const mobiles = resolveDemoMobiles(env);
  const logger = new Logger('DemoCatalog');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const prisma = app.get(PrismaService);
    const vendors = app.get(VendorsService);
    const media = app.get(MediaService);
    const products = app.get(ProductsService);

    const adminMobile = toE164(env.SUPER_ADMIN_MOBILE ?? '');
    const admin = adminMobile
      ? await prisma.user.findUnique({ where: { mobile: adminMobile }, select: { id: true, role: true } })
      : await prisma.user.findFirst({ where: { role: UserRole.SUPER_ADMIN }, orderBy: { createdAt: 'asc' }, select: { id: true, role: true } });
    if (!admin || admin.role !== UserRole.SUPER_ADMIN) {
      throw new Error('No super admin found — run the base seed first (SUPER_ADMIN_MOBILE).');
    }

    const summary: DemoCatalogSummary = { visibility, storesCreated: 0, storesExisting: 0, productsCreated: 0, productsExisting: 0, images: 0 };
    const owners = new Map<DemoStore['key'], { userId: string; vendorId: string }>();

    for (const [index, store] of DEMO_STORES.entries()) {
      const existing = await prisma.vendor.findUnique({ where: { storeSlug: store.storeSlug }, select: { id: true, userId: true } });
      if (existing) {
        owners.set(store.key, { userId: existing.userId, vendorId: existing.id });
        summary.storesExisting += 1;
        continue;
      }
      const created = await vendors.createByAdmin({
        actorId: admin.id,
        context: CONTEXT,
        storeName: store.storeName,
        storeSlug: store.storeSlug,
        ownerMobile: mobiles[index]!,
        ownerFullName: store.ownerFullName,
        bankIban: store.bankIban,
        commissionRateOverride: store.commissionRateOverride,
        instagramHandle: store.instagramHandle,
        bio: store.bio,
        ownerActive: visibility === 'live',
      });
      const vendorId = created.profile.vendor.id;
      const userId = created.profile.vendor.userId;
      const logo = await media.uploadImage(
        { originalName: store.logo, declaredMimeType: 'image/jpeg', buffer: await readFile(join(ASSETS, 'logos', store.logo)) },
        { ownerUserId: userId, purpose: 'store_logo', isPublic: true, vendorId },
      );
      await prisma.vendor.update({ where: { id: vendorId }, data: { logoUrl: logo.url } });
      owners.set(store.key, { userId, vendorId });
      summary.storesCreated += 1;
      summary.images += 1;
    }

    const storeByKey = new Map(DEMO_STORES.map((store) => [store.key, store]));
    for (const [index, product] of DEMO_PRODUCTS.entries()) {
      if (await prisma.product.findUnique({ where: { slug: product.slug }, select: { id: true } })) {
        summary.productsExisting += 1;
        continue;
      }
      const owner = owners.get(product.store)!;
      const category = await prisma.category.findUnique({ where: { slug: product.categorySlug }, select: { id: true } });
      if (!category) {
        throw new Error(`Category "${product.categorySlug}" is missing — run the base seed first.`);
      }
      const image = await media.uploadImage(
        { originalName: product.image, declaredMimeType: 'image/jpeg', buffer: await readFile(join(ASSETS, 'products', product.image)) },
        { ownerUserId: owner.userId, purpose: 'product_image', isPublic: true, vendorId: owner.vendorId },
      );
      summary.images += 1;

      const dto: CreateProductDto = {
        title: product.title,
        slug: product.slug,
        description: product.description,
        categoryId: category.id,
        brand: storeByKey.get(product.store)!.brand,
        basePrice: rial(product.priceToman),
        mediaIds: [image.id],
        specifications: product.specs.map(([groupTitle, title, value]) => ({ groupTitle, title, value })),
        variants: demoVariants(product, `DEMO-${String(index + 1).padStart(3, '0')}`),
        isPublished: visibility === 'live',
      };
      await products.create(owner.userId, dto, { actorId: admin.id, context: CONTEXT });
      summary.productsCreated += 1;
    }

    logger.log(`demo catalogue (${visibility}): ${summary.storesCreated} stores / ${summary.productsCreated} products created`);
    return summary;
  } finally {
    await app.close();
  }
}
