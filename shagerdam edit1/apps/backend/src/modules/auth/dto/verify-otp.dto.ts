import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, Matches } from 'class-validator';
import { IsIranianMobile } from '../../../common/validators/is-iranian-mobile.decorator';
import { toAsciiDigits, toE164 } from '../../../common/validators/iranian-mobile';

export class VerifyOtpDto {
  @ApiProperty({
    example: '09120000001',
    description: 'همان شمارهای که کد برای آن درخواست شده است',
  })
  @Transform(({ value }): unknown => (typeof value === 'string' ? (toE164(value) ?? value) : value))
  @IsIranianMobile()
  mobile!: string;

  @ApiProperty({ example: '48213', description: 'کد یکبارمصرف ۵ رقمی' })
  @Transform(({ value }): unknown => (typeof value === 'string' ? toAsciiDigits(value).trim() : value))
  @IsString()
  @Matches(/^[0-9]{4,8}$/, { message: 'کد یکبارمصرف باید فقط رقم باشد' })
  code!: string;
}
