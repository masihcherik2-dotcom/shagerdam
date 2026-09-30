import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ParentOrderPaymentStatus, SubOrderStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsDateString, IsIn, IsOptional, IsString, IsUUID, Length, Matches, MaxLength, MinLength, ValidateIf } from 'class-validator';
import { IsOptionalNonNullable } from '../../../common/validators/is-optional-nonnullable';
import { PaginationQueryDto } from '../../users/dto/user-query.dto';
import { STAFF_FORCE_STATUSES, VENDOR_TARGET_STATUSES, type StaffForceStatus, type VendorTargetStatus } from '../sub-order-state-machine';

const trim = ({ value }: { value: unknown }): unknown => (typeof value === 'string' ? value.trim() : value);
const trimToUndefined = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? (value.trim() === '' ? undefined : value.trim()) : value;

export class CheckoutDto {
  @ApiProperty({ format: 'uuid', description: 'One of the caller’s saved addresses; it is copied into the order.' })
  @IsUUID('4')
  addressId!: string;

  @ApiPropertyOptional({ maxLength: 500, example: 'لطفاً قبل از ارسال تماس بگیرید' })
  @IsOptionalNonNullable()
  @Transform(trimToUndefined)
  @IsString()
  @MaxLength(500)
  customerNote?: string;
}

export class CancelOrderDto {
  @ApiPropertyOptional({ maxLength: 500, example: 'از خرید منصرف شدم' })
  @IsOptionalNonNullable()
  @Transform(trimToUndefined)
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class VendorUpdateSubOrderStatusDto {
  @ApiProperty({ enum: VENDOR_TARGET_STATUSES })
  @IsIn(VENDOR_TARGET_STATUSES)
  status!: VendorTargetStatus;

  @ApiPropertyOptional({ description: 'Required for SHIPPED.', maxLength: 40, example: '123456789012345678901234' })
  @ValidateIf((dto: VendorUpdateSubOrderStatusDto) => dto.status === SubOrderStatus.SHIPPED || dto.trackingCode !== undefined)
  @Transform(trim)
  @IsString()
  @Length(4, 40)
  @Matches(/^[A-Za-z0-9-]+$/, { message: 'trackingCode may contain only latin letters, digits and dashes' })
  trackingCode?: string;

  @ApiPropertyOptional({ description: 'Required for SHIPPED.', maxLength: 80, example: 'پست پیشتاز' })
  @ValidateIf((dto: VendorUpdateSubOrderStatusDto) => dto.status === SubOrderStatus.SHIPPED || dto.shippingCarrier !== undefined)
  @Transform(trim)
  @IsString()
  @Length(2, 80)
  shippingCarrier?: string;

  @ApiPropertyOptional({ description: 'Required for CANCELLED; shown to the customer.', maxLength: 500 })
  @ValidateIf((dto: VendorUpdateSubOrderStatusDto) => dto.status === SubOrderStatus.CANCELLED || dto.reason !== undefined)
  @Transform(trim)
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  reason?: string;
}

export class ForceSubOrderStatusDto {
  @ApiProperty({ enum: STAFF_FORCE_STATUSES })
  @IsIn(STAFF_FORCE_STATUSES)
  status!: StaffForceStatus;

  @ApiProperty({ minLength: 5, maxLength: 500, description: 'Why staff overrode the normal flow (kept in history and audit).' })
  @Transform(trim)
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  reason!: string;
}

export class CustomerOrderQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ParentOrderPaymentStatus })
  @IsOptional()
  @IsIn(Object.values(ParentOrderPaymentStatus))
  paymentStatus?: ParentOrderPaymentStatus;
}

export class VendorOrderQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: SubOrderStatus })
  @IsOptional()
  @IsIn(Object.values(SubOrderStatus))
  status?: SubOrderStatus;

  @ApiPropertyOptional({ description: 'Order or package number, or its beginning', example: 'SHP-100000001' })
  @IsOptional()
  @Transform(trimToUndefined)
  @IsString()
  @MaxLength(24)
  search?: string;
}

export class AdminOrderQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ParentOrderPaymentStatus })
  @IsOptional()
  @IsIn(Object.values(ParentOrderPaymentStatus))
  paymentStatus?: ParentOrderPaymentStatus;

  @ApiPropertyOptional({ enum: SubOrderStatus, description: 'Orders having at least one package in this status' })
  @IsOptional()
  @IsIn(Object.values(SubOrderStatus))
  subOrderStatus?: SubOrderStatus;

  @ApiPropertyOptional({ format: 'uuid', description: 'Orders containing a package of this store' })
  @IsOptional()
  @IsUUID('4')
  vendorId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  customerId?: string;

  @ApiPropertyOptional({ description: 'Order/package number prefix or customer mobile (+98… or 09…)', example: 'SHP-1000' })
  @IsOptional()
  @Transform(trimToUndefined)
  @IsString()
  @MaxLength(24)
  search?: string;

  @ApiPropertyOptional({ format: 'date-time', description: 'Placed at or after' })
  @IsOptional()
  @IsDateString()
  createdFrom?: string;

  @ApiPropertyOptional({ format: 'date-time', description: 'Placed before' })
  @IsOptional()
  @IsDateString()
  createdTo?: string;
}
