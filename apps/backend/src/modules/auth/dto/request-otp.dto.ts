import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIranianMobile } from '../../../common/validators/is-iranian-mobile.decorator';
import { toE164 } from '../../../common/validators/iranian-mobile';

export class RequestOtpDto {
  @ApiProperty({
    example: '09120000001',
    description:
      'شماره موبایل ایران — قالبهای 09XXXXXXXXX و +989XXXXXXXXX پذیرفته و به E.164 نرمال میشوند',
  })
  @Transform(({ value }): unknown => (typeof value === 'string' ? (toE164(value) ?? value) : value))
  @IsIranianMobile()
  mobile!: string;
}
