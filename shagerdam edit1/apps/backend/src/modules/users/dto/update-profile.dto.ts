import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsEmail, IsOptional, IsString, Length, MaxLength } from 'class-validator';
import { IsIranianNationalCode } from '../../../common/validators/is-iranian-national-code.decorator';

/**
 * Fields a user may change about themselves.
 *
 * Deliberately narrow: `mobile` is the identity key and is changed only through a
 * verified OTP flow (not implemented yet — it needs a "confirm the new number"
 * step), and `role` is never client-writable.
 */
export class UpdateProfileDto {
  @ApiPropertyOptional({ example: 'سارا محمدی', maxLength: 120, description: 'نام و نام خانوادگی' })
  @IsOptional()
  @IsString()
  @Length(2, 120)
  fullName?: string;

  @ApiPropertyOptional({ example: 'sara@example.com', maxLength: 254 })
  @IsOptional()
  @IsEmail({}, { message: 'ایمیل معتبر نیست' })
  @MaxLength(254)
  email?: string;

  @ApiPropertyOptional({
    example: '0499370899',
    description: 'کد ملی ۱۰ رقمی — با رقم کنترلی اعتبارسنجی میشود',
  })
  @IsOptional()
  @IsIranianNationalCode()
  nationalCode?: string;

  @ApiPropertyOptional({ example: '1994-05-17', description: 'تاریخ تولد (ISO 8601، فقط تاریخ)' })
  @IsOptional()
  @IsDateString({ strict: true }, { message: 'تاریخ تولد باید قالب ISO 8601 داشته باشد' })
  birthDate?: string;
}
