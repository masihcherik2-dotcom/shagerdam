import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';
import { IsIranianMobile } from '../../../common/validators/is-iranian-mobile.decorator';
import { IsOptionalNonNullable } from '../../../common/validators/is-optional-nonnullable';
import { normalizePersianParagraphs, normalizePersianText, toAsciiDigits } from '../../products/catalog-text';

/** Iranian postal codes: 10 digits, never starting with 0. */
export const POSTAL_CODE_PATTERN = /^[1-9][0-9]{9}$/;

const text = ({ value }: { value: unknown }): unknown => (typeof value === 'string' ? normalizePersianText(value) : value);
const paragraph = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? normalizePersianParagraphs(value) : value;
const digits = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? toAsciiDigits(value).replace(/[\s-]/g, '') : value;
/** Empty optional strings are stored as NULL rather than ''. */
const optionalText = ({ value }: { value: unknown }): unknown => {
  if (typeof value !== 'string') return value;
  const normalized = toAsciiDigits(normalizePersianText(value));
  return normalized === '' ? null : normalized;
};

export class CreateAddressDto {
  @ApiProperty({ example: 'تهران', maxLength: 60 })
  @Transform(text)
  @IsString()
  @Length(2, 60)
  province!: string;

  @ApiProperty({ example: 'تهران', maxLength: 60 })
  @Transform(text)
  @IsString()
  @Length(2, 60)
  city!: string;

  @ApiProperty({ example: 'خیابان ولیعصر، بالاتر از میدان ونک، کوچه نگار', maxLength: 500 })
  @Transform(paragraph)
  @IsString()
  @Length(10, 500)
  postalAddress!: string;

  @ApiProperty({ example: '1969833111', description: '10 digits; Persian digits, spaces and dashes are accepted.' })
  @Transform(digits)
  @IsString()
  @Matches(POSTAL_CODE_PATTERN, { message: 'postalCode must be a 10-digit Iranian postal code' })
  postalCode!: string;

  @ApiPropertyOptional({ example: '12', maxLength: 20, nullable: true })
  @Transform(optionalText)
  @IsOptional()
  @IsString()
  @MaxLength(20)
  buildingNumber?: string | null;

  @ApiPropertyOptional({ example: '4', maxLength: 20, nullable: true })
  @Transform(optionalText)
  @IsOptional()
  @IsString()
  @MaxLength(20)
  unitNumber?: string | null;

  @ApiProperty({ example: 'مریم احمدی', maxLength: 120 })
  @Transform(text)
  @IsString()
  @Length(2, 120)
  recipientName!: string;

  @ApiProperty({ example: '09121234567', description: 'Any common spelling; stored as E.164 (+989…).' })
  @IsString()
  @IsIranianMobile()
  recipientMobile!: string;

  @ApiPropertyOptional({
    example: true,
    description: 'Make this the default address. The first address a customer saves is always the default.',
  })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

export class UpdateAddressDto {
  @ApiPropertyOptional({ example: 'اصفهان', maxLength: 60 })
  @Transform(text)
  @IsOptionalNonNullable()
  @IsString()
  @Length(2, 60)
  province?: string;

  @ApiPropertyOptional({ example: 'اصفهان', maxLength: 60 })
  @Transform(text)
  @IsOptionalNonNullable()
  @IsString()
  @Length(2, 60)
  city?: string;

  @ApiPropertyOptional({ example: 'خیابان چهارباغ عباسی، کوچه ۱۲', maxLength: 500 })
  @Transform(paragraph)
  @IsOptionalNonNullable()
  @IsString()
  @Length(10, 500)
  postalAddress?: string;

  @ApiPropertyOptional({ example: '8174673111' })
  @Transform(digits)
  @IsOptionalNonNullable()
  @IsString()
  @Matches(POSTAL_CODE_PATTERN, { message: 'postalCode must be a 10-digit Iranian postal code' })
  postalCode?: string;

  @ApiPropertyOptional({ example: '7', maxLength: 20, nullable: true, description: 'null clears the value.' })
  @Transform(optionalText)
  @IsOptional()
  @IsString()
  @MaxLength(20)
  buildingNumber?: string | null;

  @ApiPropertyOptional({ example: '2', maxLength: 20, nullable: true, description: 'null clears the value.' })
  @Transform(optionalText)
  @IsOptional()
  @IsString()
  @MaxLength(20)
  unitNumber?: string | null;

  @ApiPropertyOptional({ example: 'علی رضایی', maxLength: 120 })
  @Transform(text)
  @IsOptionalNonNullable()
  @IsString()
  @Length(2, 120)
  recipientName?: string;

  @ApiPropertyOptional({ example: '+989351234567' })
  @IsOptionalNonNullable()
  @IsString()
  @IsIranianMobile()
  recipientMobile?: string;

  @ApiPropertyOptional({
    example: true,
    description: 'Only `true` is accepted: to change the default, mark another address as default.',
  })
  @IsOptionalNonNullable()
  @IsBoolean()
  isDefault?: boolean;
}
