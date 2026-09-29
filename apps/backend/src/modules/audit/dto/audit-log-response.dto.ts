import { ApiProperty } from '@nestjs/swagger';
import { AuditAction } from '@prisma/client';

/** One immutable row of the audit trail. */
export class AuditLogEntryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid', nullable: true, description: 'کنشگر؛ null برای رویدادهای بینام' })
  userId!: string | null;

  @ApiProperty({ enum: AuditAction })
  action!: AuditAction;

  @ApiProperty({ example: 'User' })
  entityName!: string;

  @ApiProperty({ nullable: true })
  entityId!: string | null;

  @ApiProperty({ nullable: true, example: '203.0.113.10' })
  ipAddress!: string | null;

  @ApiProperty({ nullable: true })
  userAgent!: string | null;

  @ApiProperty({
    nullable: true,
    type: Object,
    description: 'وضعیت پیش از تغییر (در بهروزرسانیها). مقادیر حساس حذف شدهاند.',
  })
  oldValue!: unknown;

  @ApiProperty({
    nullable: true,
    type: Object,
    description: 'درخواست و نتیجهٔ تغییر. مقادیر حساس حذف شدهاند.',
  })
  newValue!: unknown;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;
}

export class PaginatedAuditLogsDto {
  @ApiProperty({ type: [AuditLogEntryDto] })
  items!: AuditLogEntryDto[];

  @ApiProperty({ example: 1 })
  page!: number;

  @ApiProperty({ example: 20 })
  pageSize!: number;

  @ApiProperty({ example: 137 })
  total!: number;

  @ApiProperty({ example: 7 })
  totalPages!: number;
}
