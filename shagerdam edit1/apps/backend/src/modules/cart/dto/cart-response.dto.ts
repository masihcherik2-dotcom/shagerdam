import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export const CART_ISSUE_CODES = [
  'VARIANT_INACTIVE',
  'PRODUCT_UNPUBLISHED',
  'PRODUCT_BLOCKED',
  'STORE_UNAVAILABLE',
  'CATEGORY_UNAVAILABLE',
  'OUT_OF_STOCK',
  'INSUFFICIENT_STOCK',
  'PRICE_CHANGED',
] as const;
export type CartIssueCode = (typeof CART_ISSUE_CODES)[number];

export const MERGE_DROP_REASONS = [...CART_ISSUE_CODES, 'CART_FULL'] as const;
export type MergeDropReason = (typeof MERGE_DROP_REASONS)[number];

export class CartIssueDto {
  @ApiProperty({ enum: CART_ISSUE_CODES })
  code!: CartIssueCode;

  @ApiProperty({ example: 'Only 2 left in stock' })
  message!: string;
}

export class CartImageDto {
  @ApiProperty()
  url!: string;

  @ApiProperty({ nullable: true, type: String })
  thumbnailUrl!: string | null;
}

export class CartLineDto {
  @ApiProperty({ format: 'uuid', description: 'Cart line id (use it for PATCH/DELETE /cart/items/:id).' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  productVariantId!: string;

  @ApiProperty({ example: 'SHP-X1-256-BLK' })
  sku!: string;

  @ApiProperty({ format: 'uuid' })
  productId!: string;

  @ApiProperty({ example: 'shopino-sample-smartphone-x1' })
  productSlug!: string;

  @ApiProperty({ example: 'گوشی موبایل نمونه X1' })
  productTitle!: string;

  @ApiProperty({ nullable: true, type: String })
  colorName!: string | null;

  @ApiProperty({ nullable: true, type: String })
  colorHex!: string | null;

  @ApiProperty({ nullable: true, type: String })
  size!: string | null;

  @ApiProperty({ nullable: true, type: String })
  guarantee!: string | null;

  @ApiProperty({ type: CartImageDto, nullable: true })
  image!: CartImageDto | null;

  @ApiProperty({ example: 1 })
  quantity!: number;

  @ApiProperty({ example: '42500000.00', description: 'Live selling price of the variant.' })
  unitPrice!: string;

  @ApiProperty({ example: '42000000.00', description: 'Price the customer last saw for this line.' })
  priceWhenAdded!: string;

  @ApiProperty({ example: '45000000.00', nullable: true, type: String })
  compareAtPrice!: string | null;

  @ApiProperty({ example: '42500000.00', description: 'unitPrice × quantity.' })
  lineTotal!: string;

  @ApiProperty({ example: 12, description: 'Units that can still be bought right now.' })
  availableQuantity!: number;

  @ApiProperty({ description: 'False when the variant cannot be bought at all (see issues).' })
  isPurchasable!: boolean;

  @ApiProperty({ type: [CartIssueDto] })
  issues!: CartIssueDto[];

  @ApiProperty()
  addedAt!: Date;
}

export class CartVendorDto {
  @ApiProperty({ example: 'فروشگاه نمونه شاگردم' })
  storeName!: string;

  @ApiProperty({ example: 'shopino-sample-store' })
  storeSlug!: string;
}

export class CartShippingDto {
  @ApiProperty({ example: '500000.00' })
  fee!: string;

  @ApiProperty()
  isFree!: boolean;

  @ApiProperty({ example: '10000000.00', description: 'Free-shipping threshold for this store ("0.00" = none).' })
  freeThreshold!: string;

  @ApiProperty({ example: '1500000.00', nullable: true, type: String, description: 'Missing amount for free shipping.' })
  remainingForFreeShipping!: string | null;
}

export class CartVendorGroupDto {
  @ApiProperty({ type: CartVendorDto })
  vendor!: CartVendorDto;

  @ApiProperty({ type: [CartLineDto] })
  lines!: CartLineDto[];

  @ApiProperty({ example: '85000000.00', description: 'Sum of line totals of purchasable lines.' })
  itemsSubtotal!: string;

  @ApiProperty({ type: CartShippingDto, description: 'Estimate for this store package with the current policy.' })
  shipping!: CartShippingDto;

  @ApiProperty({ example: '85500000.00' })
  packageTotal!: string;
}

export class CartDto {
  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'Guest cart token, returned only in the response that created the guest cart. Send it back in the X-Cart-Token header.',
  })
  cartToken!: string | null;

  @ApiProperty({ enum: ['user', 'guest', 'none'], description: '"none": no cart exists yet.' })
  owner!: 'user' | 'guest' | 'none';

  @ApiProperty({ type: [CartVendorGroupDto], description: 'Lines grouped by store, in the order stores were added.' })
  groups!: CartVendorGroupDto[];

  @ApiProperty({ example: 3, description: 'Total units.' })
  itemCount!: number;

  @ApiProperty({ example: 2 })
  lineCount!: number;

  @ApiProperty({ example: '85000000.00' })
  itemsSubtotal!: string;

  @ApiProperty({ example: '500000.00' })
  shippingTotal!: string;

  @ApiProperty({ example: '85500000.00' })
  payableAmount!: string;

  @ApiProperty({ description: 'True when at least one line has a changed price.' })
  hasPriceChanges!: boolean;

  @ApiProperty({ description: 'True when the cart is non-empty and no line has an issue.' })
  canCheckout!: boolean;
}

export class MergeAdjustmentDto {
  @ApiProperty({ format: 'uuid' })
  productVariantId!: string;

  @ApiProperty({ example: 'SHP-X1-256-BLK' })
  sku!: string;

  @ApiPropertyOptional({ example: 5, description: 'Quantity the merge wanted to place.' })
  requested?: number;

  @ApiPropertyOptional({ example: 3, description: 'Quantity actually placed (limited by stock).' })
  applied?: number;

  @ApiPropertyOptional({ enum: MERGE_DROP_REASONS, description: 'Why the line was dropped.' })
  reason?: MergeDropReason;
}

export class MergeReportDto {
  @ApiProperty({ example: 2, description: 'Guest lines moved into the account cart (new or combined).' })
  mergedLines!: number;

  @ApiProperty({ type: [MergeAdjustmentDto], description: 'Lines whose combined quantity exceeded stock.' })
  clampedLines!: MergeAdjustmentDto[];

  @ApiProperty({ type: [MergeAdjustmentDto], description: 'Lines that could not be merged (unavailable, no stock, cart full).' })
  droppedLines!: MergeAdjustmentDto[];
}

export class MergeCartResponseDto {
  @ApiProperty({ type: CartDto })
  cart!: CartDto;

  @ApiProperty({ type: MergeReportDto })
  report!: MergeReportDto;
}
