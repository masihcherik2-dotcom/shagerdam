import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CreditAccountStatus, CreditApplicationStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsEnum, IsInt, IsOptional, IsPositive, IsString, IsUUID, Matches, Max, MaxLength } from 'class-validator';
import { IsIranianNationalCode } from '../../../common/validators/is-iranian-national-code.decorator';
import { PaginationQueryDto } from '../../users/dto/user-query.dto';
import { MONEY } from '../../wallet/dto/wallet.dto';

const upperTrim = ({ value }: { value: unknown }): unknown => (typeof value === 'string' ? value.trim().toUpperCase() : value);
/** Whole rials that fit DECIMAL(15,2). */
const MAX_WHOLE_RIALS = 9_999_999_999_999;
const PROVIDER_CODE = /^[A-Z0-9_]{2,40}$/;

// ─── input ──────────────────────────────────────────────────────────────────

export class CreateCreditApplicationDto {
  @ApiProperty({ example: 200000000, description: 'Requested credit limit in whole IRR (Shaparak has no fractional unit).' })
  @IsInt()
  @IsPositive()
  @Max(MAX_WHOLE_RIALS)
  requestedLimit!: number;

  @ApiProperty({
    example: '0499370899',
    description: 'Applicant national code (10 digits, checksum-validated). Must match the profile if one is set; otherwise it is saved to the profile on approval.',
  })
  @IsIranianNationalCode()
  nationalCode!: string;

  @ApiProperty({ example: 'SANDBOX_BANK', description: 'Code of the credit provider; must be the active provider (`GET /credit/plans`).' })
  @Transform(upperTrim)
  @IsString()
  @Matches(PROVIDER_CODE, { message: 'providerCode must be an upper-case provider code' })
  providerCode!: string;

  @ApiPropertyOptional({
    type: [String],
    format: 'uuid',
    maxItems: 10,
    description: 'Supporting documents the customer uploaded with `POST /media/upload/document` (forwarded to the provider).',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsUUID('4', { each: true })
  documentIds?: string[];
}

export class AdminCreditApplicationsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: CreditApplicationStatus })
  @IsOptional()
  @IsEnum(CreditApplicationStatus)
  status?: CreditApplicationStatus;

  @ApiPropertyOptional({ example: 'SANDBOX_BANK' })
  @IsOptional()
  @Transform(upperTrim)
  @Matches(PROVIDER_CODE)
  providerCode?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  userId?: string;
}

export class AdminCreditAccountsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: CreditAccountStatus })
  @IsOptional()
  @IsEnum(CreditAccountStatus)
  status?: CreditAccountStatus;

  @ApiPropertyOptional({ example: 'SANDBOX_BANK' })
  @IsOptional()
  @Transform(upperTrim)
  @Matches(PROVIDER_CODE)
  providerCode?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  userId?: string;

  @ApiPropertyOptional({ description: 'Search by mobile or full name', maxLength: 60 })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  search?: string;
}

// ─── output ─────────────────────────────────────────────────────────────────

export class CreditProviderSummaryDto {
  @ApiProperty({ example: 'SANDBOX_BANK' }) code!: string;
  @ApiProperty({ example: 'بانک آزمایشی (Sandbox)' }) name!: string;
  @ApiProperty({ description: 'True for a development/test provider: no real credit, no money moves.' }) isSandbox!: boolean;
}

export class OutstandingInstallmentsDto {
  @ApiProperty({ description: 'Unpaid instalments (PENDING or OVERDUE).' }) count!: number;
  @ApiProperty({ description: 'Of which OVERDUE.' }) overdueCount!: number;
  @ApiProperty({ ...MONEY, description: 'Unpaid principal (equals usedAmount).' }) principal!: string;
  @ApiProperty({ ...MONEY, description: 'Unpaid interest (financing fee).' }) interest!: string;
  @ApiProperty({ nullable: true, type: String, example: '2026-10-27', description: 'Earliest unpaid due date.' }) nextDueDate!: string | null;
}

export class CreditAccountDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ type: CreditProviderSummaryDto }) provider!: CreditProviderSummaryDto;
  @ApiProperty({ enum: CreditAccountStatus }) status!: CreditAccountStatus;
  @ApiProperty({ ...MONEY, description: 'Invariant: totalLimit = usedAmount + reservedAmount + availableAmount.' }) totalLimit!: string;
  @ApiProperty({ ...MONEY, description: 'Principal of committed credit purchases not repaid yet.' }) usedAmount!: string;
  @ApiProperty({ ...MONEY, description: 'Held by checkouts awaiting completion.' }) reservedAmount!: string;
  @ApiProperty(MONEY) availableAmount!: string;
  @ApiProperty({ example: 'IRR' }) currency!: string;
  @ApiProperty({ nullable: true, type: Date }) expiresAt!: Date | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty({ type: OutstandingInstallmentsDto }) outstanding!: OutstandingInstallmentsDto;
}

export class CreditApplicationDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: CreditApplicationStatus }) status!: CreditApplicationStatus;
  @ApiProperty({ type: CreditProviderSummaryDto }) provider!: CreditProviderSummaryDto;
  @ApiProperty(MONEY) requestedLimit!: string;
  @ApiProperty({ ...MONEY, nullable: true }) approvedLimit!: string | null;
  @ApiProperty({ nullable: true, type: String, example: 'SBXA-1F2E3D4C5B6A7980' }) trackingCode!: string | null;
  @ApiProperty({ nullable: true, type: Number, example: 712, description: 'Credit score reported by the provider (if disclosed).' }) score!: number | null;
  @ApiProperty({ nullable: true, type: String, example: 'SCORE_BELOW_THRESHOLD' }) decisionReason!: string | null;
  @ApiProperty({ nullable: true, type: Date }) decidedAt!: Date | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty({ type: CreditAccountDto, nullable: true, description: 'The credit line opened by an APPROVED application.' })
  account!: CreditAccountDto | null;
}

export class InstallmentPlanDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'خرید اعتباری ۶ ماهه' }) title!: string;
  @ApiProperty({ example: 6 }) durationMonths!: number;
  @ApiProperty({ example: '9.00', description: 'Total interest rate of the whole plan duration (%). totalInterest = floor(creditAmount × rate / 100).' })
  interestRatePercent!: string;
  @ApiProperty({ example: '2.00', description: 'Late-payment penalty rate per month (%). Not applied automatically in this phase.' })
  penaltyRatePercentPerMonth!: string;
  @ApiProperty({ example: 30, description: 'Days between instalments.' }) installmentIntervalDays!: number;
}

export class CreditPlansResponseDto {
  @ApiProperty({ description: '`credit.enabled`: when false no credit purchase can start and `items` is empty.' }) creditEnabled!: boolean;
  @ApiProperty({ type: CreditProviderSummaryDto, nullable: true }) provider!: CreditProviderSummaryDto | null;
  @ApiProperty({ type: [InstallmentPlanDto] }) items!: InstallmentPlanDto[];
}

export class CreditUserSummaryDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() fullName!: string;
  @ApiProperty({ example: '+989121234567' }) mobile!: string;
  @ApiProperty({ nullable: true, type: String, example: '******0899', description: 'Masked national code (last 4 digits).' }) nationalCodeMasked!: string | null;
}

export class AdminCreditApplicationDto extends CreditApplicationDto {
  @ApiProperty({ type: CreditUserSummaryDto }) user!: CreditUserSummaryDto;
}

export class AdminCreditApplicationPageDto {
  @ApiProperty({ type: [AdminCreditApplicationDto] }) items!: AdminCreditApplicationDto[];
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
  @ApiProperty() total!: number;
  @ApiProperty() totalPages!: number;
}

export class AdminCreditAccountDto extends CreditAccountDto {
  @ApiProperty({ type: CreditUserSummaryDto }) user!: CreditUserSummaryDto;
}

export class CreditExposureDto {
  @ApiProperty({ description: 'Accounts matching the filters.' }) accounts!: number;
  @ApiProperty(MONEY) totalLimit!: string;
  @ApiProperty({ ...MONEY, description: 'Outstanding principal (sum of usedAmount).' }) used!: string;
  @ApiProperty(MONEY) reserved!: string;
  @ApiProperty(MONEY) available!: string;
  @ApiProperty({ ...MONEY, description: 'Unpaid principal + interest of all unpaid instalments.' }) outstandingInstallments!: string;
  @ApiProperty() overdueInstallments!: number;
  @ApiProperty({ ...MONEY, description: 'Amount due of OVERDUE instalments.' }) overdueAmount!: string;
  @ApiProperty({ description: 'True when every account satisfies totalLimit = used + reserved + available and equals the replay of its ledger.' })
  ledgerConsistent!: boolean;
  @ApiProperty({ description: 'Accounts whose balances do not match their ledger (should always be 0).' }) inconsistentAccounts!: number;
}

export class AdminCreditAccountPageDto {
  @ApiProperty({ type: [AdminCreditAccountDto] }) items!: AdminCreditAccountDto[];
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
  @ApiProperty() total!: number;
  @ApiProperty() totalPages!: number;
  @ApiProperty({ type: CreditExposureDto, description: 'Aggregated exposure over all accounts matching the filters (not only this page).' })
  exposure!: CreditExposureDto;
}
