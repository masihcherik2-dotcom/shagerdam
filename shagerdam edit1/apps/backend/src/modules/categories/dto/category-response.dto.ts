import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { CategoryNode } from '../category-tree';

/** Category fields shared by every public category payload. */
export class CategorySummaryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'mobile' })
  slug!: string;

  @ApiProperty({ example: 'گوشی موبایل' })
  titleFa!: string;

  @ApiProperty({ example: 'Mobile Phones', nullable: true, type: String })
  titleEn!: string | null;

  static from(node: Pick<CategoryNode, 'id' | 'slug' | 'titleFa' | 'titleEn'>): CategorySummaryDto {
    return { id: node.id, slug: node.slug, titleFa: node.titleFa, titleEn: node.titleEn };
  }
}

export class CategoryTreeNodeDto extends CategorySummaryDto {
  @ApiProperty({ format: 'uuid', nullable: true, type: String })
  parentId!: string | null;

  @ApiProperty({ example: '5.00', description: 'Platform commission in percent.' })
  defaultCommissionRate!: string;

  @ApiProperty({ example: 10 })
  sortOrder!: number;

  @ApiProperty({ example: 1, description: 'Depth from the root (roots are 0).' })
  depth!: number;

  @ApiProperty({ example: 2, description: 'Visible products placed directly in this category.' })
  productCount!: number;

  @ApiProperty({ example: 14, description: 'Visible products in this category and all of its descendants.' })
  totalProductCount!: number;

  @ApiProperty({ type: () => [CategoryTreeNodeDto] })
  children!: CategoryTreeNodeDto[];

  static fromNode(node: CategoryNode): CategoryTreeNodeDto {
    return {
      ...CategorySummaryDto.from(node),
      parentId: node.parentId,
      defaultCommissionRate: node.defaultCommissionRate,
      sortOrder: node.sortOrder,
      depth: node.depth,
      productCount: node.productCount,
      totalProductCount: node.totalProductCount,
      children: node.children.map((child) => CategoryTreeNodeDto.fromNode(child)),
    };
  }
}

export class CategoryTreeResponseDto {
  @ApiProperty({ type: () => [CategoryTreeNodeDto] })
  items!: CategoryTreeNodeDto[];

  @ApiProperty({ example: 19, description: 'Number of visible categories in the tree.' })
  totalCategories!: number;

  @ApiProperty({ example: 3, description: 'Visible products across the whole catalogue.' })
  totalProducts!: number;
}

/** A direct subcategory on the category page. */
export class SubcategoryDto extends CategorySummaryDto {
  @ApiProperty({ example: 10 })
  sortOrder!: number;

  @ApiProperty({ example: 4 })
  totalProductCount!: number;

  @ApiProperty({ example: 2, description: 'Number of direct children of this subcategory.' })
  childCount!: number;
}

export class CategoryDetailDto extends CategorySummaryDto {
  @ApiProperty({ format: 'uuid', nullable: true, type: String })
  parentId!: string | null;

  @ApiProperty({ example: '5.00' })
  defaultCommissionRate!: string;

  @ApiProperty({ example: 1 })
  depth!: number;

  @ApiProperty({ example: 2 })
  productCount!: number;

  @ApiProperty({ example: 14 })
  totalProductCount!: number;

  @ApiProperty({
    type: () => [CategorySummaryDto],
    description: 'Ancestors from the root down to this category (the last element is the category itself).',
  })
  breadcrumbs!: CategorySummaryDto[];

  @ApiProperty({ type: () => [SubcategoryDto] })
  children!: SubcategoryDto[];

  static fromNode(node: CategoryNode, breadcrumbs: CategoryNode[]): CategoryDetailDto {
    return {
      ...CategorySummaryDto.from(node),
      parentId: node.parentId,
      defaultCommissionRate: node.defaultCommissionRate,
      depth: node.depth,
      productCount: node.productCount,
      totalProductCount: node.totalProductCount,
      breadcrumbs: breadcrumbs.map((crumb) => CategorySummaryDto.from(crumb)),
      children: node.children.map((child) => ({
        ...CategorySummaryDto.from(child),
        sortOrder: child.sortOrder,
        totalProductCount: child.totalProductCount,
        childCount: child.children.length,
      })),
    };
  }
}

/** Staff view of one category row, active or not. */
export class AdminCategoryDto extends CategorySummaryDto {
  @ApiProperty({ format: 'uuid', nullable: true, type: String })
  parentId!: string | null;

  @ApiProperty({ example: '5.00' })
  defaultCommissionRate!: string;

  @ApiProperty({ example: 10 })
  sortOrder!: number;

  @ApiProperty()
  isActive!: boolean;

  @ApiProperty({ example: 3, description: 'Direct children (active or not).' })
  childCount!: number;

  @ApiProperty({ example: 12, description: 'Products placed directly in this category, whatever their status.' })
  productCount!: number;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;

  @ApiPropertyOptional({ format: 'uuid', description: 'Audit row written with the change (create/update only).' })
  auditLogId?: string;
}

export class AdminCategoryListDto {
  @ApiProperty({ type: () => [AdminCategoryDto] })
  items!: AdminCategoryDto[];

  @ApiProperty({ example: 19 })
  total!: number;
}
