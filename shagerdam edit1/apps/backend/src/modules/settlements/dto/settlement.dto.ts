import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SettlementStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsEnum, IsIn, IsNumber, IsOptional, IsPositive, IsString, IsUUID, Length, Matches, Max, MaxLength, MinLength, ValidateIf } from 'class-validator';
import { IsIranianSheba } from '../../../common/validators/is-iranian-sheba.decorator';
import { PaginationQueryDto } from '../../users/dto/user-query.dto';
import { MONEY } from '../../wallet/dto/wallet.dto';

const trim = ({ value }: { value: unknown }): unknown => (typeof value === 'string' ? value.trim() : value);
/** Upper bound of DECIMAL(15,2). */
const MAX_AMOUNT = 9_999_999_999_999.99;
const PAYA_REFERENCE = /^[A-Za-z0-9-]+$/;

export class CreateSettlementRequestDto {
  @ApiProperty({ example: 5000000, description: 'IRR, up to 2 decimals. At least `commerce.settlementMinimumAmount` and at most the withdrawable balance.' })
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Max(MAX_AMOUNT)
  amount!: number;

  @ApiProperty({ example: 'IR820540102680020817909002', description: 'Must be the IBAN registered on the store profile (the account holder is verified at KYC).' })
  @Transform(trim)
  @IsString()
  @IsIranianSheba()
  targetIban!: string;
}

export const SETTLEMENT_ACTIONS = ['APPROVE', 'REJECT'] as const;
export type SettlementAction = (typeof SETTLEMENT_ACTIONS)[number];

export class ProcessSettlementDto {
  @ApiProperty({ enum: SETTLEMENT_ACTIONS, description: 'APPROVE = the PAYA transfer was made (status PAID_PAYA); REJECT = the held amount returns to the vendor.' })
  @IsIn(SETTLEMENT_ACTIONS)
  action!: SettlementAction;

  @ApiPropertyOptional({ example: 'PAYA-14050707-000123', description: 'Required for APPROVE: the bank’s PAYA transfer reference.' })
  @ValidateIf((dto: ProcessSettlementDto) => dto.action === 'APPROVE' || dto.payaReferenceNumber !== undefined)
  @Transform(trim)
  @IsString()
  @Length(4, 60)
  @Matches(PAYA_REFERENCE, { message: 'payaReferenceNumber may contain only latin letters, digits and dashes' })
  payaReferenceNumber?: string;

  @ApiPropertyOptional({ maxLength: 500, description: 'Required for REJECT; shown to the vendor.' })
  @ValidateIf((dto: ProcessSettlementDto) => dto.action === 'REJECT' || dto.rejectionReason !== undefined)
  @Transform(trim)
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  rejectionReason?: string;
}

export class PayoutSettlementDto {
  @ApiProperty({ example: 'PAYA-14050707-000123', description: 'The bank’s PAYA transfer reference.' })
  @Transform(trim)
  @IsString()
  @Length(4, 60)
  @Matches(PAYA_REFERENCE, { message: 'payaReferenceNumber may contain only latin letters, digits and dashes' })
  payaReferenceNumber!: string;
}

export class VendorSettlementQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: SettlementStatus })
  @IsOptional()
  @IsEnum(SettlementStatus)
  status?: SettlementStatus;
}

export class AdminSettlementQueryDto extends VendorSettlementQueryDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  vendorId?: string;
}

export class SettlementProcessorDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ nullable: true, type: String }) fullName!: string | null;
}

export class SettlementRequestDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) vendorId!: string;
  @ApiProperty() storeName!: string;
  @ApiProperty(MONEY) amount!: string;
  @ApiProperty({ example: 'IR820540102680020817909002' }) targetIban!: string;
  @ApiProperty({ enum: SettlementStatus }) status!: SettlementStatus;
  @ApiProperty({ nullable: true, type: String }) bankPayaReference!: string | null;
  @ApiProperty({ nullable: true, type: String }) rejectionReason!: string | null;
  @ApiProperty({ nullable: true, type: Date }) processedAt!: Date | null;
  @ApiProperty({ nullable: true, type: SettlementProcessorDto }) processedBy!: SettlementProcessorDto | null;
  @ApiProperty() createdAt!: Date;
}

export class PaginatedSettlementRequestsDto {
  @ApiProperty({ type: [SettlementRequestDto] }) items!: SettlementRequestDto[];
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
  @ApiProperty() total!: number;
  @ApiProperty() totalPages!: number;
}

export class SettlementProcessResultDto extends SettlementRequestDto {
  @ApiProperty({ format: 'uuid' }) auditLogId!: string;
}
