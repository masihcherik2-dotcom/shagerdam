import { ApiPropertyOptional } from '@nestjs/swagger';
import { VendorStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationQueryDto } from '../../users/dto/user-query.dto';

export class VendorQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: VendorStatus, description: 'فیلتر وضعیت فروشگاه' })
  @IsOptional()
  @IsEnum(VendorStatus, { message: `status must be one of: ${Object.values(VendorStatus).join(', ')}` })
  status?: VendorStatus;

  @ApiPropertyOptional({
    description: 'جست‌وجو روی نام فروشگاه یا شناسه (slug). حساس به بزرگی/کوچکی حروف نیست.',
    example: 'sample',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  @Type(() => String)
  search?: string;
}
