import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsNumber, IsOptional, IsString, Length, Max, Min } from 'class-validator';

/** Staff decision on a store's KYC submission. */
export enum VendorDecision {
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
}

/** Every legal decision, in the order the API documents them. */
export const VENDOR_DECISIONS = [VendorDecision.APPROVED, VendorDecision.REJECTED] as const;

/**
 * `POST /admin/vendors/:id/verify` — the reviewer's decision.
 *
 * The two decisions carry different obligations, and both are enforced here rather
 * than in the service so a malformed decision never reaches the transaction:
 * a rejection must explain itself (the text is shown to the vendor, so it has to
 * be actionable), and an approval must not carry a rejection reason — a reason
 * stored next to an approved store is a data-quality bug that surfaces later in
 * support tickets.
 */
export class VerifyVendorDto {
  @ApiProperty({ enum: VendorDecision, example: VendorDecision.APPROVED })
  @IsEnum(VendorDecision)
  status!: VendorDecision;

  @ApiPropertyOptional({
    nullable: true,
    example: 'تصویر کارت ملی خوانا نیست؛ لطفاً عکس واضح‌تری ارسال کنید.',
    minLength: 10,
    maxLength: 1000,
    description: 'Required when status is REJECTED, must be null when APPROVED. Shown verbatim to the vendor.',
  })
  @IsOptional()
  @IsString()
  @Length(10, 1000)
  rejectionReason?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    example: 7.5,
    minimum: 0,
    maximum: 100,
    description:
      'Vendor-specific commission rate in percent (up to two decimals). null clears the override so the category rate applies.',
  })
  @IsOptional()
  @Type(() => Number)
  // A rate of 7.5 is legal, 7.555 is not: the column is DECIMAL(5,2), so accepting
  // more precision would silently round money-bearing configuration.
  @IsNumber(
    { maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false },
    { message: 'commissionRateOverride must be a percentage with at most two decimal places' },
  )
  @Min(0)
  @Max(100)
  commissionRateOverride?: number | null;
}
