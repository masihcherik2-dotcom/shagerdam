import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  NotEquals,
  ValidateIf,
} from 'class-validator';
import { IsOptionalNonNullable } from '../../../common/validators/is-optional-nonnullable';

/** Latin, lowercase, hyphen-separated: category slugs appear in storefront URLs. */
export const CATEGORY_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Slugs that would shadow a static route under `/categories/*`. `tree` is the
 * only one today; the list lives next to the pattern so a new static route adds
 * its name here.
 */
export const RESERVED_CATEGORY_SLUGS: ReadonlySet<string> = new Set(['tree']);

const trim = ({ value }: { value: unknown }): unknown => (typeof value === 'string' ? value.trim() : value);
const trimLower = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

export class CreateCategoryDto {
  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    description: 'Parent category. Omit or send null for a root category.',
  })
  @ValidateIf((_object, value) => value !== null && value !== undefined)
  @IsUUID('4', { message: 'parentId must be a UUID' })
  parentId?: string | null;

  @ApiProperty({ example: 'gaming-consoles', maxLength: 80, pattern: CATEGORY_SLUG_PATTERN.source })
  @Transform(trimLower)
  @IsString()
  @MaxLength(80)
  @Matches(CATEGORY_SLUG_PATTERN, {
    message: 'slug must contain lowercase latin letters, digits and single hyphens only (e.g. gaming-consoles)',
  })
  @NotEquals('tree', { message: 'slug "tree" is reserved' })
  slug!: string;

  @ApiProperty({ example: 'کنسول بازی', minLength: 2, maxLength: 120 })
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  titleFa!: string;

  @ApiPropertyOptional({ example: 'Gaming Consoles', maxLength: 120, nullable: true })
  @Transform(trim)
  @ValidateIf((_object, value) => value !== null && value !== undefined)
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  titleEn?: string | null;

  @ApiProperty({
    example: 8.5,
    minimum: 0,
    maximum: 100,
    description: 'Platform commission in percent (two decimals) for products in this category.',
  })
  @IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(100)
  defaultCommissionRate!: number;

  @ApiPropertyOptional({ example: 10, default: 0, minimum: -10000, maximum: 10000 })
  @IsOptional()
  @IsInt()
  @Min(-10000)
  @Max(10000)
  sortOrder?: number;

  @ApiPropertyOptional({ default: true, description: 'Inactive categories (and their subtrees) are hidden from the storefront.' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/** Every field optional; `parentId: null` moves the category to the root. */
export class UpdateCategoryDto {
  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    description: 'New parent; null makes the category a root. A category cannot be moved under itself or its descendants.',
  })
  @ValidateIf((_object, value) => value !== null && value !== undefined)
  @IsUUID('4', { message: 'parentId must be a UUID' })
  parentId?: string | null;

  @ApiPropertyOptional({ example: 'gaming-consoles', maxLength: 80, pattern: CATEGORY_SLUG_PATTERN.source })
  @Transform(trimLower)
  @IsOptionalNonNullable()
  @IsString()
  @MaxLength(80)
  @Matches(CATEGORY_SLUG_PATTERN, {
    message: 'slug must contain lowercase latin letters, digits and single hyphens only (e.g. gaming-consoles)',
  })
  @NotEquals('tree', { message: 'slug "tree" is reserved' })
  slug?: string;

  @ApiPropertyOptional({ example: 'کنسول بازی', minLength: 2, maxLength: 120 })
  @Transform(trim)
  @IsOptionalNonNullable()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  titleFa?: string;

  @ApiPropertyOptional({ example: 'Gaming Consoles', maxLength: 120, nullable: true })
  @Transform(trim)
  @ValidateIf((_object, value) => value !== null && value !== undefined)
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  titleEn?: string | null;

  @ApiPropertyOptional({ example: 9, minimum: 0, maximum: 100 })
  @IsOptionalNonNullable()
  @IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(100)
  defaultCommissionRate?: number;

  @ApiPropertyOptional({ example: 20, minimum: -10000, maximum: 10000 })
  @IsOptionalNonNullable()
  @IsInt()
  @Min(-10000)
  @Max(10000)
  sortOrder?: number;

  @ApiPropertyOptional()
  @IsOptionalNonNullable()
  @IsBoolean()
  isActive?: boolean;
}
