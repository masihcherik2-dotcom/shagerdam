import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIranianSheba } from '../../../common/validators/is-iranian-sheba.decorator';
import { IsOptionalNonNullable } from '../../../common/validators/is-optional-nonnullable';
import { DOCUMENT_URL_HINT, DOCUMENT_URL_PATTERN } from '../../media/media-urls';
import { Transform } from 'class-transformer';
import { IsString, Length, Matches, MaxLength } from 'class-validator';

/**
 * `PATCH /vendors/me` — the store owner edits their own store.
 *
 * `storeSlug`, `status` and `commissionRateOverride` are deliberately absent: the
 * slug is the public identifier customers link to, and status/commission are
 * staff decisions. Changing the bank IBAN is allowed but drags the store back into
 * review, and the request has to carry a fresh proof of account ownership — see
 * `VendorsService.updateMyProfile`.
 */
export class UpdateVendorProfileDto {
  @ApiPropertyOptional({ example: 'دیجی‌استور پارس (شعبه ۲)', maxLength: 120 })
  @IsOptionalNonNullable()
  @IsString()
  @Length(2, 120)
  storeName?: string;

  @ApiPropertyOptional({ example: 'ارسال رایگان بالای ۵۰۰ هزار تومان.', maximum: 2000 })
  @IsOptionalNonNullable()
  @IsString()
  @MaxLength(2000)
  bio?: string;

  @ApiPropertyOptional({
    example: 'digistore.pars',
    maxLength: 60,
    description: 'Instagram handle; a leading "@" or instagram.com link is normalised away.',
  })
  @IsOptionalNonNullable()
  @IsString()
  @MaxLength(60)
  instagramHandle?: string;

  @ApiPropertyOptional({
    example: '/api/v1/media/files/images/store_logo/2026/09/0f2c1a9e-6b1d-4f0c-9c1a-2b3c4d5e6f70.webp',
    description: 'Public URL of a logo uploaded through POST /media/upload/image with purpose "store_logo".',
  })
  @IsOptionalNonNullable()
  @IsString()
  @MaxLength(512)
  logoUrl?: string;

  @ApiPropertyOptional({
    example: 'IR062960000000100324200001',
    maxLength: 26,
    description:
      'New payout IBAN. Requires bankAccountProofUrl in the same request; the store returns to PENDING until staff verify it.',
  })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsOptionalNonNullable()
  @IsString()
  @IsIranianSheba()
  bankIban?: string;

  @ApiPropertyOptional({
    example: '/api/v1/media/documents/2b8f0c11-7a6d-4f39-b0a5-9c8e7d6f5a44/download',
    description: `Proof of ownership of the new IBAN, uploaded through ${DOCUMENT_URL_HINT}.`,
  })
  @IsOptionalNonNullable()
  @IsString()
  @MaxLength(512)
  @Matches(DOCUMENT_URL_PATTERN, {
    message: `bankAccountProofUrl must be the URL returned by ${DOCUMENT_URL_HINT} for a document uploaded by this account`,
  })
  bankAccountProofUrl?: string;
}
