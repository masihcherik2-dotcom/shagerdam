import { ApiProperty, ApiPropertyOptional, type ApiPropertyOptions } from '@nestjs/swagger';
import { DisputeEventType, DisputeReason, DisputeStatus, DisputeVendorAction, ParentOrderPaymentStatus, PaymentMethod, SubOrderStatus, WalletBalanceBucket } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayUnique, IsArray, IsBoolean, IsDate, IsEnum, IsIn, IsOptional, IsString, IsUUID, Length, Matches } from 'class-validator';
import { DOCUMENT_URL_HINT, DOCUMENT_URL_PATTERN } from '../../media/media-urls';
import { PaginationQueryDto } from '../../users/dto/user-query.dto';
import { MONEY } from '../../wallet/dto/wallet.dto';
import { MAX_EVIDENCE_PER_REQUEST } from '../dispute-policy';

const trim = ({ value }: { value: unknown }): unknown => (typeof value === 'string' ? value.trim() : value);
const EVIDENCE_MESSAGE = `each evidenceUrls item must be the url returned by ${DOCUMENT_URL_HINT} (purpose=dispute_evidence)`;

const EVIDENCE_PROPERTY: ApiPropertyOptions & { description: string } = {
  type: [String],
  maxItems: MAX_EVIDENCE_PER_REQUEST,
  example: ['/api/v1/media/documents/7a4c3f7e-8d1b-4a45-9a61-2f1f5a0c2b10/download'],
  description:
    `Proof files (JPEG / PNG / PDF). Upload each with \`POST /media/upload/document\` and purpose \`dispute_evidence\`, then send the returned ` +
    '`url`. Only your own uploads are accepted; they stay private and are readable by the other party of the dispute and staff.',
};

// ─── input ──────────────────────────────────────────────────────────────────

export class CreateDisputeDto {
  @ApiProperty({ format: 'uuid', description: 'The package (sub-order) of one of your paid orders.' })
  @IsUUID('4')
  subOrderId!: string;

  @ApiProperty({ enum: DisputeReason })
  @IsEnum(DisputeReason)
  reason!: DisputeReason;

  @ApiProperty({ minLength: 20, maxLength: 2000, example: 'The screen arrived cracked; the box was dented on one corner.' })
  @Transform(trim)
  @IsString()
  @Length(20, 2000)
  description!: string;

  @ApiProperty({ ...EVIDENCE_PROPERTY, description: `${EVIDENCE_PROPERTY.description} May be empty (e.g. NOT_DELIVERED).` })
  @IsArray()
  @ArrayMaxSize(MAX_EVIDENCE_PER_REQUEST)
  @ArrayUnique()
  @IsString({ each: true })
  @Matches(DOCUMENT_URL_PATTERN, { each: true, message: EVIDENCE_MESSAGE })
  evidenceUrls!: string[];
}

export class CancelDisputeDto {
  @ApiPropertyOptional({ maxLength: 500, example: 'The seller sent a replacement.' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 500)
  reason?: string;
}

export class VendorRespondDisputeDto {
  @ApiProperty({
    enum: DisputeVendorAction,
    description: 'ACCEPT_RETURN resolves the dispute for the customer immediately (refund); REJECT_WITH_DEFENSE sends it to staff arbitration.',
  })
  @IsEnum(DisputeVendorAction)
  action!: DisputeVendorAction;

  @ApiProperty({ minLength: 10, maxLength: 2000, example: 'The item was photographed intact before dispatch; see the attached packing photos.' })
  @Transform(trim)
  @IsString()
  @Length(10, 2000)
  defenseNotes!: string;

  @ApiPropertyOptional(EVIDENCE_PROPERTY)
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_EVIDENCE_PER_REQUEST)
  @ArrayUnique()
  @IsString({ each: true })
  @Matches(DOCUMENT_URL_PATTERN, { each: true, message: EVIDENCE_MESSAGE })
  evidenceUrls?: string[];

  @ApiPropertyOptional({
    description:
      'ACCEPT_RETURN only: the goods physically came back to the store. Shipped/delivered stock is restocked only when true; ' +
      'goods that never shipped are always restocked.',
  })
  @IsOptional()
  @IsBoolean()
  itemReturned?: boolean;
}

export const ARBITRATION_DECISIONS = ['BUYER_FAVOR', 'VENDOR_FAVOR'] as const;
export type ArbitrationDecision = (typeof ARBITRATION_DECISIONS)[number];

export class ArbitrateDisputeDto {
  @ApiProperty({
    enum: ARBITRATION_DECISIONS,
    description:
      'BUYER_FAVOR: package REFUNDED, frozen earnings deducted (REFUND_DEDUCTION), refund owed to the customer. ' +
      'VENDOR_FAVOR: package DELIVERED, frozen earnings released to the withdrawable balance (DISPUTE_HOLD_RELEASE).',
  })
  @IsIn(ARBITRATION_DECISIONS)
  decision!: ArbitrationDecision;

  @ApiProperty({ minLength: 10, maxLength: 2000, example: 'Photos show transit damage; the carrier confirmed the dented box.' })
  @Transform(trim)
  @IsString()
  @Length(10, 2000)
  resolutionNotes!: string;

  @ApiPropertyOptional({ description: 'BUYER_FAVOR only: the goods came back to the store (restocks shipped/delivered packages).' })
  @IsOptional()
  @IsBoolean()
  itemReturned?: boolean;
}

export class CustomerDisputeQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: DisputeStatus })
  @IsOptional()
  @IsEnum(DisputeStatus)
  status?: DisputeStatus;
}

export class VendorDisputeQueryDto extends CustomerDisputeQueryDto {}

export class AdminDisputeQueryDto extends CustomerDisputeQueryDto {
  @ApiPropertyOptional({ enum: DisputeReason })
  @IsOptional()
  @IsEnum(DisputeReason)
  reason?: DisputeReason;

  @ApiPropertyOptional({ format: 'uuid', description: 'Store the disputes are against.' })
  @IsOptional()
  @IsUUID('4')
  vendorId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Customer who raised the disputes.' })
  @IsOptional()
  @IsUUID('4')
  customerId?: string;

  @ApiPropertyOptional({ type: Date, description: 'Opened at or after (ISO 8601).' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  from?: Date;

  @ApiPropertyOptional({ type: Date, description: 'Opened before (ISO 8601).' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  to?: Date;
}

// ─── output ─────────────────────────────────────────────────────────────────

export class DisputeEvidenceDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: ['CUSTOMER', 'VENDOR', 'STAFF'] }) uploadedBy!: 'CUSTOMER' | 'VENDOR' | 'STAFF';
  @ApiProperty({ example: '/api/v1/media/documents/7a4c3f7e-8d1b-4a45-9a61-2f1f5a0c2b10/download' }) fileUrl!: string;
  @ApiProperty({ nullable: true, type: String, example: 'image/jpeg' }) fileType!: string | null;
  @ApiProperty({ nullable: true, type: String }) caption!: string | null;
  @ApiProperty() createdAt!: Date;
}

export class DisputeEventDto {
  @ApiProperty({ enum: DisputeEventType }) type!: DisputeEventType;
  @ApiProperty({ enum: ['CUSTOMER', 'VENDOR', 'STAFF', 'SYSTEM'] }) actorRole!: string;
  @ApiProperty({ enum: DisputeStatus, nullable: true }) fromStatus!: DisputeStatus | null;
  @ApiProperty({ enum: DisputeStatus, nullable: true }) toStatus!: DisputeStatus | null;
  @ApiProperty({ nullable: true, type: String }) note!: string | null;
  @ApiProperty() createdAt!: Date;
}

export class DisputePackageDto {
  @ApiProperty({ format: 'uuid' }) subOrderId!: string;
  @ApiProperty({ example: 'SHP-100000001-1' }) subOrderNumber!: string;
  @ApiProperty({ example: 'SHP-100000001' }) orderNumber!: string;
  @ApiProperty({ enum: SubOrderStatus }) status!: SubOrderStatus;
  @ApiProperty({ format: 'uuid' }) vendorId!: string;
  @ApiProperty() storeName!: string;
  @ApiProperty(MONEY) itemsSubtotal!: string;
  @ApiProperty(MONEY) shippingFee!: string;
}

export class DisputeVendorResponseDto {
  @ApiProperty({ enum: DisputeVendorAction }) action!: DisputeVendorAction;
  @ApiProperty() defenseNotes!: string;
  @ApiProperty() respondedAt!: Date;
}

export class DisputeResolutionDto {
  @ApiProperty({ enum: [DisputeStatus.RESOLVED_BUYER_FAVOR, DisputeStatus.RESOLVED_VENDOR_FAVOR] }) outcome!: DisputeStatus;
  @ApiProperty({ nullable: true, type: String }) notes!: string | null;
  @ApiProperty() resolvedAt!: Date;
  @ApiProperty({ enum: ['VENDOR', 'STAFF'], description: 'VENDOR when the store accepted the return, STAFF for an arbitration.' }) decidedBy!: 'VENDOR' | 'STAFF';
  @ApiProperty({ ...MONEY, nullable: true, description: 'Buyer favour: amount owed back to the customer (items + shipping).' }) refundAmount!: string | null;
  @ApiProperty({ nullable: true, type: Boolean }) itemReturned!: boolean | null;
  @ApiProperty() restocked!: boolean;
}

export class DisputeDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: DisputeStatus }) status!: DisputeStatus;
  @ApiProperty({ enum: DisputeReason }) reason!: DisputeReason;
  @ApiProperty() description!: string;
  @ApiProperty({ type: DisputePackageDto }) package!: DisputePackageDto;
  @ApiProperty({ enum: SubOrderStatus, description: 'Package status when the dispute was opened.' }) subOrderStatusAtOpen!: SubOrderStatus;
  @ApiProperty({ type: DisputeVendorResponseDto, nullable: true }) vendorResponse!: DisputeVendorResponseDto | null;
  @ApiProperty({ type: DisputeResolutionDto, nullable: true }) resolution!: DisputeResolutionDto | null;
  @ApiProperty({ nullable: true, type: Date }) cancelledAt!: Date | null;
  @ApiProperty({ type: [DisputeEvidenceDto] }) evidence!: DisputeEvidenceDto[];
  @ApiProperty({ type: [DisputeEventDto], description: 'Timeline, oldest first.' }) timeline!: DisputeEventDto[];
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

export class DisputeHoldDto {
  @ApiProperty({ enum: [WalletBalanceBucket.PENDING, WalletBalanceBucket.WITHDRAWABLE], nullable: true, description: 'Where the frozen earnings came from.' })
  source!: WalletBalanceBucket | null;
  @ApiProperty({ ...MONEY, description: 'Earnings frozen in DISPUTE_HOLD by this dispute.' }) amount!: string;
  @ApiProperty({ ...MONEY, description: 'Delivered packages: earnings the vendor had already withdrawn when the dispute was opened.' }) shortfall!: string;
  @ApiProperty({ ...MONEY, description: 'Buyer favour: earnings that could not be recovered at all (vendor debt).' }) unrecovered!: string;
}

export class VendorDisputeDto extends DisputeDto {
  @ApiProperty({ description: 'Customer name as shown to the store; the mobile is masked.' }) customerName!: string;
  @ApiProperty({ example: '+98912***4567' }) customerMobileMasked!: string;
  @ApiProperty({ type: DisputeHoldDto }) hold!: DisputeHoldDto;
}

export class DisputePartyDto {
  @ApiProperty({ format: 'uuid' }) userId!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ example: '+989121234567' }) mobile!: string;
}

export class DossierOrderDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() orderNumber!: string;
  @ApiProperty({ enum: ParentOrderPaymentStatus }) paymentStatus!: ParentOrderPaymentStatus;
  @ApiProperty({ enum: PaymentMethod }) paymentMethod!: PaymentMethod;
  @ApiProperty(MONEY) finalPayableAmount!: string;
  @ApiProperty() createdAt!: Date;
}

export class DossierItemDto {
  @ApiProperty() productTitle!: string;
  @ApiProperty() sku!: string;
  @ApiProperty() quantity!: number;
  @ApiProperty(MONEY) unitPrice!: string;
  @ApiProperty(MONEY) totalLineAmount!: string;
}

export class DossierStatusChangeDto {
  @ApiProperty({ enum: SubOrderStatus, nullable: true }) fromStatus!: SubOrderStatus | null;
  @ApiProperty({ enum: SubOrderStatus }) toStatus!: SubOrderStatus;
  @ApiProperty() actorRole!: string;
  @ApiProperty({ nullable: true, type: String }) note!: string | null;
  @ApiProperty() createdAt!: Date;
}

export class DossierPaymentDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() gatewayName!: string;
  @ApiProperty({ enum: PaymentMethod }) paymentMethod!: PaymentMethod;
  @ApiProperty() status!: string;
  @ApiProperty(MONEY) cashAmount!: string;
  @ApiProperty(MONEY) creditAmount!: string;
  @ApiProperty({ nullable: true, type: String }) bankRrn!: string | null;
  @ApiProperty({ nullable: true, type: Date }) paidAt!: Date | null;
}

export class DossierWalletDto {
  @ApiProperty(MONEY) pendingBalance!: string;
  @ApiProperty(MONEY) withdrawableBalance!: string;
  @ApiProperty(MONEY) settlementHoldBalance!: string;
  @ApiProperty(MONEY) disputeHoldBalance!: string;
  @ApiProperty(MONEY) totalEarnedBalance!: string;
  @ApiProperty(MONEY) totalWithdrawnAmount!: string;
}

export class AdminDisputeDossierDto extends DisputeDto {
  @ApiProperty({ type: DisputePartyDto }) customer!: DisputePartyDto;
  @ApiProperty({ type: DisputeHoldDto }) hold!: DisputeHoldDto;
  @ApiProperty({ type: DossierOrderDto }) order!: DossierOrderDto;
  @ApiProperty({ type: [DossierItemDto] }) items!: DossierItemDto[];
  @ApiProperty({ type: [DossierStatusChangeDto], description: 'Package status history, oldest first.' }) packageHistory!: DossierStatusChangeDto[];
  @ApiProperty({ type: [DossierPaymentDto] }) payments!: DossierPaymentDto[];
  @ApiProperty({ type: DossierWalletDto, description: "The store's wallet right now." }) vendorWallet!: DossierWalletDto;
  @ApiProperty(MONEY) vendorEarningsAmount!: string;
}

export class DisputePageDto {
  @ApiProperty({ type: [DisputeDto] }) items!: DisputeDto[];
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
  @ApiProperty() total!: number;
  @ApiProperty() totalPages!: number;
}

export class VendorDisputePageDto {
  @ApiProperty({ type: [VendorDisputeDto] }) items!: VendorDisputeDto[];
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
  @ApiProperty() total!: number;
  @ApiProperty() totalPages!: number;
}

export class AdminDisputeSummaryDto extends DisputeDto {
  @ApiProperty({ type: DisputePartyDto }) customer!: DisputePartyDto;
  @ApiProperty({ type: DisputeHoldDto }) hold!: DisputeHoldDto;
}

export class AdminDisputePageDto {
  @ApiProperty({ type: [AdminDisputeSummaryDto] }) items!: AdminDisputeSummaryDto[];
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
  @ApiProperty() total!: number;
  @ApiProperty() totalPages!: number;
}

/** Result of every state-changing dispute call. */
export class DisputeActionResultDto {
  @ApiProperty({ type: DisputeDto }) dispute!: DisputeDto;
  @ApiProperty({
    enum: ['FROZEN', 'REFUNDED', 'RELEASED_TO_WITHDRAWABLE', 'RETURNED_TO_ESCROW', 'NONE'],
    description:
      'Wallet consequence: FROZEN (opened: earnings moved to DISPUTE_HOLD), REFUNDED (buyer favour: REFUND_DEDUCTION), ' +
      'RELEASED_TO_WITHDRAWABLE (vendor favour, or a cancelled dispute on a delivered package), RETURNED_TO_ESCROW (cancelled before delivery), NONE.',
  })
  walletAction!: 'FROZEN' | 'REFUNDED' | 'RELEASED_TO_WITHDRAWABLE' | 'RETURNED_TO_ESCROW' | 'NONE';
  @ApiProperty({ enum: SubOrderStatus }) subOrderStatus!: SubOrderStatus;
  @ApiProperty({ enum: ['RESTOCKED', 'NONE'] }) stockAction!: 'RESTOCKED' | 'NONE';
}
