import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator';

export class PublicSiteInfoDto {
  @ApiProperty({ type: String, nullable: true, example: 'شرکت فناوری شاگردم' }) legalName!: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'شناسهٔ ملی شرکت (۱۱ رقم)' }) nationalId!: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'شمارهٔ ثبت' }) registrationNumber!: string | null;
  @ApiProperty({ type: String, nullable: true, example: '021-91000000' }) supportPhone!: string | null;
  @ApiProperty({ type: String, nullable: true, example: 'support@shagerdam.ir' }) supportEmail!: string | null;
  @ApiProperty({ type: String, nullable: true }) officeAddress!: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'کد پستی ۱۰ رقمی' }) postalCode!: string | null;
  @ApiProperty({ type: String, nullable: true, example: 'شنبه تا چهارشنبه، ۹ تا ۱۷' }) workingHours!: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'نشانی تأیید نماد اعتماد الکترونیکی (trustseal.enamad.ir)' }) enamadLinkUrl!: string | null;
  @ApiProperty({ type: String, nullable: true }) enamadImageUrl!: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'نشانی تأیید نشان ساماندهی (logo.samandehi.ir)' }) samandehiLinkUrl!: string | null;
  @ApiProperty({ type: String, nullable: true }) samandehiImageUrl!: string | null;
}

export class SiteInfoHistoryEntryDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() createdAt!: string;
  @ApiProperty({ type: Object, nullable: true, example: { id: 'uuid', fullName: 'مدیر سامانه' } }) actor!: { id: string; fullName: string } | null;
  @ApiProperty({ type: [String] }) changedFields!: string[];
}

export class AdminSiteInfoDto extends PublicSiteInfoDto {
  @ApiProperty({ type: Object, description: 'زمان آخرین تغییر هر فیلد (یا null)' }) updatedAt!: Record<string, string | null>;
  @ApiProperty({ type: [SiteInfoHistoryEntryDto] }) history!: SiteInfoHistoryEntryDto[];
  @ApiPropertyOptional({ format: 'uuid' }) auditLogId?: string;
}

/**
 * Every field is optional: omitted = unchanged, `null` or `''` = clear.
 * Format rules (digits, seal hosts…) live in `site-info-rules.ts` and return
 * `SITE_INFO_INVALID_FIELD`.
 */
export class UpdateSiteInfoDto {
  @ApiPropertyOptional({ type: String, nullable: true }) @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(150) legalName?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(40) nationalId?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(40) registrationNumber?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(40) supportPhone?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(254) supportEmail?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(300) officeAddress?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(40) postalCode?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(200) workingHours?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(500) enamadLinkUrl?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(500) enamadImageUrl?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(500) samandehiLinkUrl?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(500) samandehiImageUrl?: string | null;
}
