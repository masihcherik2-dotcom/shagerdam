import { ApiProperty } from '@nestjs/swagger';
import { MediaKind, UserRole, VendorStatus } from '@prisma/client';
import type {
  MediaAssetSummaryView,
  VendorAuditEntryView,
  VendorAdminDetailView,
  VendorAdminSummaryView,
  VendorOwnerView,
  VendorProfileView,
  VendorVerificationView,
  VendorWalletView,
} from '../vendors.service';

/** Money is returned as a decimal string, never as a float. */
export class VendorWalletSummaryDto {
  @ApiProperty({ example: '0.00' })
  pendingBalance!: string;

  @ApiProperty({ example: '0.00' })
  withdrawableBalance!: string;

  @ApiProperty({ example: '0.00' })
  totalEarnedBalance!: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: Date;

  static from(view: VendorWalletView): VendorWalletSummaryDto {
    return {
      pendingBalance: view.pendingBalance,
      withdrawableBalance: view.withdrawableBalance,
      totalEarnedBalance: view.totalEarnedBalance,
      updatedAt: view.updatedAt,
    };
  }
}

export class VendorVerificationDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: '/api/v1/media/documents/…/download' })
  nationalIdCardUrl!: string;

  @ApiProperty({ nullable: true })
  businessLicenseUrl!: string | null;

  @ApiProperty({ nullable: true })
  bankAccountProofUrl!: string | null;

  @ApiProperty({
    nullable: true,
    example: 'تصویر کارت ملی خوانا نیست؛ لطفاً عکس واضح‌تری ارسال کنید.',
    description: 'متن رد؛ برای فروشنده نمایش داده می‌شود تا بتواند اصلاح کند.',
  })
  rejectionReason!: string | null;

  @ApiProperty({ nullable: true, format: 'uuid', description: 'شناسهٔ کارشناسی که بررسی کرده است' })
  reviewedByUserId!: string | null;

  @ApiProperty({ nullable: true, example: 'کارشناس احراز هویت' })
  reviewedByName!: string | null;

  @ApiProperty({ nullable: true, format: 'date-time' })
  reviewedAt!: Date | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;

  static from(view: VendorVerificationView): VendorVerificationDto {
    return {
      id: view.id,
      nationalIdCardUrl: view.nationalIdCardUrl,
      businessLicenseUrl: view.businessLicenseUrl,
      bankAccountProofUrl: view.bankAccountProofUrl,
      rejectionReason: view.rejectionReason,
      reviewedByUserId: view.reviewedByUserId,
      reviewedByName: view.reviewedByName,
      reviewedAt: view.reviewedAt,
      createdAt: view.createdAt,
    };
  }
}

export class MediaAssetSummaryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: MediaKind })
  kind!: MediaKind;

  @ApiProperty({ example: 'store_logo' })
  purpose!: string;

  @ApiProperty()
  url!: string;

  @ApiProperty({ nullable: true })
  thumbnailUrl!: string | null;

  @ApiProperty()
  isPublic!: boolean;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;

  static from(view: MediaAssetSummaryView): MediaAssetSummaryDto {
    return {
      id: view.id,
      kind: view.kind,
      purpose: view.purpose,
      url: view.url,
      thumbnailUrl: view.thumbnailUrl,
      isPublic: view.isPublic,
      createdAt: view.createdAt,
    };
  }
}

/** What the store owner sees about their own store. */
export class VendorProfileDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  userId!: string;

  @ApiProperty({ example: 'فروشگاه نمونه' })
  storeName!: string;

  @ApiProperty({ example: 'sample-store' })
  storeSlug!: string;

  @ApiProperty({ nullable: true, example: 'sample.store' })
  instagramHandle!: string | null;

  @ApiProperty({ nullable: true })
  logoUrl!: string | null;

  @ApiProperty({ nullable: true })
  bio!: string | null;

  @ApiProperty({ example: 'IR820540102680020817909002' })
  bankIban!: string;

  @ApiProperty({ nullable: true, example: 'فروشگاه نمونه پارس' })
  bankAccountHolder!: string | null;

  @ApiProperty({ nullable: true, example: '7.50', description: 'کارمزد اختصاصی؛ null یعنی نرخ دسته‌بندی' })
  commissionRateOverride!: string | null;

  @ApiProperty({ enum: VendorStatus })
  status!: VendorStatus;

  @ApiProperty({
    nullable: true,
    format: 'date-time',
    description: 'زمان تأیید؛ هنگام بازگشت به PENDING یا رد شدن پاک می‌شود.',
  })
  verifiedAt!: Date | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: Date;

  @ApiProperty({ nullable: true, type: VendorWalletSummaryDto })
  wallet!: VendorWalletSummaryDto | null;

  @ApiProperty({ nullable: true, type: VendorVerificationDto, description: 'آخرین ارسال مدارک احراز هویت' })
  verification!: VendorVerificationDto | null;

  @ApiProperty({ type: [MediaAssetSummaryDto], description: 'فایل‌های آپلودشدهٔ همین فروشگاه' })
  mediaAssets!: MediaAssetSummaryDto[];

  static from(view: VendorProfileView): VendorProfileDto {
    return {
      id: view.vendor.id,
      userId: view.vendor.userId,
      storeName: view.vendor.storeName,
      storeSlug: view.vendor.storeSlug,
      instagramHandle: view.vendor.instagramHandle,
      logoUrl: view.vendor.logoUrl,
      bio: view.vendor.bio,
      bankIban: view.vendor.bankIban,
      bankAccountHolder: view.vendor.bankAccountHolder,
      commissionRateOverride: view.vendor.commissionRateOverride,
      status: view.vendor.status,
      verifiedAt: view.vendor.verifiedAt,
      createdAt: view.vendor.createdAt,
      updatedAt: view.vendor.updatedAt,
      wallet: view.wallet === null ? null : VendorWalletSummaryDto.from(view.wallet),
      verification: view.verification === null ? null : VendorVerificationDto.from(view.verification),
      mediaAssets: view.mediaAssets.map((asset) => MediaAssetSummaryDto.from(asset)),
    };
  }
}

/** Response of `PATCH /vendors/me`: the profile plus things the vendor must be told. */
export class UpdateVendorProfileResponseDto {
  @ApiProperty({ type: VendorProfileDto })
  vendor!: VendorProfileDto;

  @ApiProperty({
    type: [String],
    example: ['شماره شبا تغییر کرد: تا تأیید مدارک جدید توسط کارشناس، وضعیت فروشگاه PENDING است.'],
    description: 'هشدارهای عملیاتی؛ خالی یعنی همهٔ تغییرات بدون نیاز به بازبینی اعمال شد.',
  })
  warnings!: string[];

  static from(profile: VendorProfileView, warnings: string[]): UpdateVendorProfileResponseDto {
    return { vendor: VendorProfileDto.from(profile), warnings };
  }
}

export class VendorOwnerDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: '+989120000010' })
  mobile!: string;

  @ApiProperty({ nullable: true })
  email!: string | null;

  @ApiProperty({ example: 'فروشنده نمونه' })
  fullName!: string;

  @ApiProperty({ enum: UserRole })
  role!: UserRole;

  @ApiProperty()
  isActive!: boolean;

  static from(view: VendorOwnerView): VendorOwnerDto {
    return {
      id: view.id,
      mobile: view.mobile,
      email: view.email,
      fullName: view.fullName,
      role: view.role,
      isActive: view.isActive,
    };
  }
}

export class VendorAdminSummaryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'فروشگاه نمونه' })
  storeName!: string;

  @ApiProperty({ example: 'sample-store' })
  storeSlug!: string;

  @ApiProperty({ nullable: true })
  instagramHandle!: string | null;

  @ApiProperty({ nullable: true })
  logoUrl!: string | null;

  @ApiProperty({ enum: VendorStatus })
  status!: VendorStatus;

  @ApiProperty({ nullable: true, format: 'date-time' })
  verifiedAt!: Date | null;

  @ApiProperty({ example: 0, description: 'تعداد محصولات ثبت‌شدهٔ فروشگاه' })
  productCount!: number;

  @ApiProperty({ nullable: true, type: VendorWalletSummaryDto })
  wallet!: VendorWalletSummaryDto | null;

  @ApiProperty({ type: VendorOwnerDto })
  owner!: VendorOwnerDto;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;

  static from(view: VendorAdminSummaryView): VendorAdminSummaryDto {
    return {
      id: view.id,
      storeName: view.storeName,
      storeSlug: view.storeSlug,
      instagramHandle: view.instagramHandle,
      logoUrl: view.logoUrl,
      status: view.status,
      verifiedAt: view.verifiedAt,
      productCount: view.productCount,
      wallet: view.wallet === null ? null : VendorWalletSummaryDto.from(view.wallet),
      owner: VendorOwnerDto.from(view.owner),
      createdAt: view.createdAt,
    };
  }
}

export class PaginatedVendorsDto {
  @ApiProperty({ type: [VendorAdminSummaryDto] })
  items!: VendorAdminSummaryDto[];

  @ApiProperty({ example: 1 })
  page!: number;

  @ApiProperty({ example: 20 })
  pageSize!: number;

  @ApiProperty({ example: 12 })
  total!: number;

  @ApiProperty({ example: 1 })
  totalPages!: number;
}

export class VendorAuditEntryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'STATUS_CHANGE' })
  action!: string;

  @ApiProperty({ example: 'Vendor' })
  entityName!: string;

  @ApiProperty({ nullable: true })
  entityId!: string | null;

  @ApiProperty({ nullable: true, format: 'uuid' })
  actorId!: string | null;

  @ApiProperty({ nullable: true, example: 'کارشناس احراز هویت' })
  actorName!: string | null;

  @ApiProperty({ nullable: true })
  ipAddress!: string | null;

  @ApiProperty({ nullable: true, description: 'وضعیت پیش از تغییر (JSON)' })
  oldValue!: unknown;

  @ApiProperty({ nullable: true, description: 'وضعیت پس از تغییر (JSON)' })
  newValue!: unknown;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;
}

export class VendorAdminDetailDto extends VendorAdminSummaryDto {
  @ApiProperty()
  bio!: string | null;

  @ApiProperty({ example: 'IR820540102680020817909002' })
  bankIban!: string;

  @ApiProperty({ nullable: true, example: 'فروشگاه نمونه پارس' })
  bankAccountHolder!: string | null;

  @ApiProperty({ nullable: true, example: '7.50' })
  commissionRateOverride!: string | null;

  @ApiProperty({ type: [VendorVerificationDto], description: 'تاریخچهٔ ارسال و بررسی مدارک، تازه‌ترین در ابتدا' })
  verifications!: VendorVerificationDto[];

  @ApiProperty({ type: [MediaAssetSummaryDto] })
  mediaAssets!: MediaAssetSummaryDto[];

  @ApiProperty({ type: [VendorAuditEntryDto], description: '۵۰ رویداد آخر مرتبط با این فروشگاه و مدارکش' })
  auditTrail!: VendorAuditEntryView[];

  static detail(view: VendorAdminDetailView): VendorAdminDetailDto {
    return {
      ...VendorAdminSummaryDto.from(view.summary),
      bio: view.bio,
      bankIban: view.bankIban,
      bankAccountHolder: view.bankAccountHolder,
      commissionRateOverride: view.commissionRateOverride,
      verifications: view.verifications.map((verification) => VendorVerificationDto.from(verification)),
      mediaAssets: view.mediaAssets.map((asset) => MediaAssetSummaryDto.from(asset)),
      auditTrail: view.auditTrail,
    };
  }
}

export class VerifyVendorResponseDto {
  @ApiProperty({ type: VendorProfileDto })
  vendor!: VendorProfileDto;

  @ApiProperty({ enum: VendorStatus, example: 'APPROVED', description: 'وضعیت پیش از این تغییر' })
  previousStatus!: VendorStatus;

  @ApiProperty({ example: true, description: 'آیا در همین تراکنش، کیف پول فروشنده ساخته شد؟' })
  walletCreated!: boolean;

  @ApiProperty({ example: true, description: 'آیا نقش کاربر در همین تراکنش به VENDOR تغییر کرد؟' })
  roleUpdated!: boolean;

  @ApiProperty({ format: 'uuid', description: 'ردیف audit_logs که در همان تراکنش نوشته شد' })
  auditLogId!: string;

  static from(view: {
    profile: VendorProfileView;
    previousStatus: VendorStatus;
    walletCreated: boolean;
    roleUpdated: boolean;
    auditLogId: string;
  }): VerifyVendorResponseDto {
    return {
      vendor: VendorProfileDto.from(view.profile),
      previousStatus: view.previousStatus,
      walletCreated: view.walletCreated,
      roleUpdated: view.roleUpdated,
      auditLogId: view.auditLogId,
    };
  }
}

export class AdminCreateVendorResponseDto {
  @ApiProperty({ type: VendorProfileDto })
  profile!: VendorProfileDto;

  @ApiProperty({ description: 'true when a new user account was created for the owner mobile; false when an existing customer account was promoted' })
  ownerCreated!: boolean;

  @ApiProperty({ format: 'uuid' })
  auditLogId!: string;
}
