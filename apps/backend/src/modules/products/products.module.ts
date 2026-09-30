import { Module } from '@nestjs/common';
import { CategoriesModule } from '../categories/categories.module';
import { TorobCacheModule } from '../integrations/torob/torob-cache.module';
import { AdminProductsController } from './admin-products.controller';
import { CatalogSearchService } from './catalog-search.service';
import { InventoryService } from './inventory.service';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';
import { VendorProductsController } from './vendor-products.controller';

/**
 * Product catalogue: vendor CRUD, staff moderation, public discovery and the
 * atomic inventory primitives. `InventoryService` is exported for the checkout
 * flow, which reserves and commits stock through the same guarded statements.
 */
@Module({
  imports: [CategoriesModule, TorobCacheModule],
  controllers: [ProductsController, VendorProductsController, AdminProductsController],
  providers: [ProductsService, CatalogSearchService, InventoryService],
  exports: [InventoryService, ProductsService],
})
export class ProductsModule {}
