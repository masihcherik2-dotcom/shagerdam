import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsUUID, Max, Min } from 'class-validator';

/** Largest quantity of one variant in a cart (abuse protection; stock is the real limit). */
export const MAX_LINE_QUANTITY = 100;
/** Largest number of distinct lines in one cart. */
export const MAX_CART_LINES = 50;

export class AddCartItemDto {
  @ApiProperty({ format: 'uuid', description: 'The variant (colour/size option) to buy.' })
  @IsUUID('4')
  productVariantId!: string;

  @ApiProperty({
    example: 1,
    minimum: 1,
    maximum: MAX_LINE_QUANTITY,
    description: 'Added to the quantity already in the cart for this variant.',
  })
  @IsInt()
  @Min(1)
  @Max(MAX_LINE_QUANTITY)
  quantity!: number;
}

export class UpdateCartItemDto {
  @ApiProperty({ example: 2, minimum: 1, maximum: MAX_LINE_QUANTITY, description: 'The new absolute quantity.' })
  @IsInt()
  @Min(1)
  @Max(MAX_LINE_QUANTITY)
  quantity!: number;
}
