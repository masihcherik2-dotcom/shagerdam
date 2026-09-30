import { Module } from '@nestjs/common';
import { AdminCategoriesController } from './admin-categories.controller';
import { CategoriesController } from './categories.controller';
import { CategoriesService } from './categories.service';

/**
 * Hierarchical categories. `CategoriesService` is exported because the product
 * catalogue resolves category subtrees, breadcrumbs and the visible-category set
 * through the same cached tree the storefront navigation uses.
 */
@Module({
  controllers: [CategoriesController, AdminCategoriesController],
  providers: [CategoriesService],
  exports: [CategoriesService],
})
export class CategoriesModule {}
