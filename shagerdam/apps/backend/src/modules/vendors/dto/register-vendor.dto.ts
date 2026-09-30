import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIranianSheba } from '../../../common/validators/is-iranian-sheba.decorator';
import { IsOptionalNonNullable } from '../../../common/validators/is-optional-nonnullable';
import { Transform } from 'class-transformer';
import { IsString, Length, Matches, MaxLength } from 'class-validator';

/**
 * `POST /vendors/register` — opens a store for an existing (non-staff) account.
 *
 * The store starts as `PENDING` and cannot sell anything until a staff member
 * reviews the KYC documents submitted through `POST /vendors/verification/documents`.
 * The bank IBAN is required at registration because it is the payout destination:
 * collecting it later would mean a vendor could be approved without a place to
 * send money to.
 */

/** URL-safe store slug: lowercase words separated by single hyphens. */
export const STORE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class RegisterVendorDto {
  @ApiProperty({ example: 'دیجی‌استور پارس', maxLength: 120, description: 'Public store name' })
  @IsString()
  @Length(2, 120)
  storeName!: string;

  @ApiProperty({
    example: 'digistore-pars',
    maxLength: 140,
    description:
      'URL identifier of the store. Lowercase letters, digits and single hyphens; unique across the platform, and fully lowercased before it is stored.',
  })
  @IsString()
  @Length(3, 140)
  @Matches(STORE_SLUG_PATTERN, {
    message: 'storeSlug must contain lowercase letters, digits and single hyphens only (e.g. my-store-1)',
  })
  storeSlug!: string;

  @ApiPropertyOptional({
    example: 'digistore.pars',
    maxLength: 60,
    description: 'Instagram handle; the leading "@" and any instagram.com URL prefix are stripped before storing.',
  })
  @IsOptionalNonNullable()
  @IsString()
  @MaxLength(60)
  instagramHandle?: string;

  @ApiPropertyOptional({
    example: 'لوازم خانگی و آشپزخانه با ارسال سریع.',
    maximum: 2000,
    description: 'Short store description shown on the store page.',
  })
  @IsOptionalNonNullable()
  @IsString()
  @MaxLength(2000)
  bio?: string;

  @ApiProperty({
    example: 'IR820540102680020817909002',
    maxLength: 26,
    description:
      'Iranian IBAN (Sheba) of the store: "IR" followed by 24 digits. The ISO 13616 check digits are verified, and the value is stored canonicalised.',
  })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsIranianSheba()
  bankIban!: string;

  @ApiProperty({
    example: 'شرکت دیجی‌استور پارس',
    maxLength: 120,
    description: 'Legal name of the account holder. Payouts are only accepted by the bank when it matches the IBAN holder.',
  })
  @IsString()
  @Length(3, 120)
  bankAccountHolder!: string;
}
