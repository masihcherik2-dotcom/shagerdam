import { ApiPropertyOptional } from '@nestjs/swagger';
import { AuditAction } from '@prisma/client';
import { IsDateString, IsEnum, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { PaginationQueryDto } from '../../users/dto/user-query.dto';

export class AuditLogQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'شناسهٔ کنشگر' })
  @IsOptional()
  @IsUUID()
  userId?: string;

  @ApiPropertyOptional({ example: 'User', description: 'نام موجودیت ثبتشده' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  entityName?: string;

  @ApiPropertyOptional({ description: 'شناسهٔ ردیف هدف' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  entityId?: string;

  @ApiPropertyOptional({ enum: AuditAction })
  @IsOptional()
  @IsEnum(AuditAction)
  action?: AuditAction;

  @ApiPropertyOptional({ format: 'date-time', description: 'از تاریخ (ISO 8601)' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ format: 'date-time', description: 'تا تاریخ (ISO 8601)' })
  @IsOptional()
  @IsDateString()
  to?: string;
}
