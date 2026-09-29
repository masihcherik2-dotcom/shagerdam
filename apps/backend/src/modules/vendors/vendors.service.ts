import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction, MediaKind, Prisma, UserRole, VendorStatus } from '@prisma/client';
import { normalizeSheba, maskSheba } from '../../common/validators/iranian-sheba';
import type { RequestContext } from '../../common/types/request-context';
import { errorMessage } from '../../common/utils';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { TorobFeedCacheService } from '../integrations/torob/torob-feed-cache.service';
import { sanitize } from '../audit/audit-log.service';
import { VENDOR_DECISIONS, VendorDecision } from './dto/verify-vendor.dto';

/** Roles that must never own a store: payouts and reviews need separation. */
const STAFF_ROLES: ReadonlySet<UserRole> = new Set([
  UserRole.SUPER_ADMIN,
  UserRole.ADMIN,
  UserRole.SUPPORT,
  UserRole.FINANCIAL_OFFICER,
]);

/** Roles that may act as a store owner (a pending store is still a CUSTOMER). */
export const VENDOR_SELF_ROLES: readonly UserRole[] = [UserRole.CUSTOMER, UserRole.VENDOR];

/**
 * Store slugs that would collide with platform routes. Blocking them at
 * registration keeps `/api/v1/<slug>` style storefront URLs unambiguous later.
 */
const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  'api',
  'admin',
  'auth',
  'media',
  'storage',
  'vendors',
  'vendor',
  'health',
  'docs',
  'swagger',
  'login',
  'register',
  'shopino',
  'static',
  'assets',
  'uploads',
  'www',
]);

/**
 * Instagram handles arrive in every shape a human can type: `@shop`, `shop`,
 * `instagram.com/shop`, a full URL with a trailing slash or query string. The store
 * profile ends up in a link, so it is normalised once, on the way in, instead of
 * being re-normalised by every consumer.
 */
const INSTAGRAM_PREFIX = /^(?:https?:\/\/)?(?:www\.)?instagram\.com\//i;
const INSTAGRAM_HANDLE = /^[a-z0-9._]{1,30}$/;

/** Canonical handle (lowercase, no `@`, no URL), or `null` when it cannot be one. */
function normalizeInstagramHandle(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }

  const handle = value
    .trim()
    .replace(INSTAGRAM_PREFIX, '')
    .replace(/^@+/, '')
    .split(/[/?#]/)[0]
    ?.replace(/\/+$/, '')
    .toLowerCase();

  if (handle === undefined || handle.length === 0) {
    return null;
  }
  if (!INSTAGRAM_HANDLE.test(handle)) {
    throw new BadRequestException(
      `instagramHandle "${value}" is not a valid Instagram handle (letters, digits, dots and underscores, up to 30 characters)`,
    );
  }
  return handle;
}

const AUDIT_TRAIL_LIMIT = 50;
const MEDIA_ASSET_LIMIT = 50;

// ─── Read models ────────────────────────────────────────────────────────────

export interface VendorRecord {
  id: string;
  userId: string;
  storeName: string;
  storeSlug: string;
  instagramHandle: string | null;
  logoUrl: string | null;
  bio: string | null;
  bankIban: string;
  bankAccountHolder: string | null;
  /** Decimal serialized as a string so money never travels as a float. */
  commissionRateOverride: string | null;
  status: VendorStatus;
  verifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface VendorWalletView {
  pendingBalance: string;
  withdrawableBalance: string;
  totalEarnedBalance: string;
  updatedAt: Date;
}

export interface VendorVerificationView {
  id: string;
  nationalIdCardUrl: string;
  businessLicenseUrl: string | null;
  bankAccountProofUrl: string | null;
  rejectionReason: string | null;
  reviewedByUserId: string | null;
  reviewedByName: string | null;
  reviewedAt: Date | null;
  createdAt: Date;
}

export interface MediaAssetSummaryView {
  id: string;
  kind: MediaKind;
  purpose: string;
  url: string;
  thumbnailUrl: string | null;
  isPublic: boolean;
  createdAt: Date;
}

export interface VendorOwnerView {
  id: string;
  mobile: string;
  email: string | null;
  fullName: string;
  role: UserRole;
  isActive: boolean;
}

export interface VendorProfileView {
  vendor: VendorRecord;
  wallet: VendorWalletView | null;
  verification: VendorVerificationView | null;
  mediaAssets: MediaAssetSummaryView[];
}

export interface VendorAdminSummaryView {
  id: string;
  storeName: string;
  storeSlug: string;
  instagramHandle: string | null;
  logoUrl: string | null;
  status: VendorStatus;
  verifiedAt: Date | null;
  productCount: number;
  wallet: VendorWalletView | null;
  owner: VendorOwnerView;
  createdAt: Date;
}

export interface VendorAuditEntryView {
  id: string;
  action: string;
  entityName: string;
  entityId: string | null;
  actorId: string | null;
  actorName: string | null;
  ipAddress: string | null;
  oldValue: unknown;
  newValue: unknown;
  createdAt: Date;
}

export interface VendorAdminDetailView {
  summary: VendorAdminSummaryView;
  bio: string | null;
  bankIban: string;
  bankAccountHolder: string | null;
  commissionRateOverride: string | null;
  verifications: VendorVerificationView[];
  mediaAssets: MediaAssetSummaryView[];
  auditTrail: VendorAuditEntryView[];
}

// ─── Request shapes ─────────────────────────────────────────────────────────

export interface RegisterVendorParams {
  userId: string;
  storeName: string;
  storeSlug: string;
  instagramHandle?: string;
  bio?: string;
  bankIban: string;
  bankAccountHolder: string;
}

export interface SubmitVerificationParams {
  userId: string;
  nationalIdCardUrl: string;
  businessLicenseUrl?: string;
  bankAccountProofUrl?: string;
}

export interface UpdateVendorProfileParams {
  userId: string;
  storeName?: string;
  bio?: string;
  instagramHandle?: string;
  logoUrl?: string;
  bankIban?: string;
  bankAccountProofUrl?: string;
}

export interface VerifyVendorParams {
  vendorId: string;
  reviewerId: string;
  status: VendorDecision;
  rejectionReason: string | null;
  commissionRateOverride: number | null;
  context: RequestContext;
}

/**
 * Vendor lifecycle: registration, KYC submission, storefront profile and the
 * admin verification decision.
 *
 * Two invariants are enforced in the database layer, because an application-level
 * check alone would not survive concurrent requests:
 *
 * 1. **A store always has a wallet.** `vendors.user_id` and
 *    `vendor_wallets.vendor_id` are unique, and every path that creates a store or
 *    approves one writes the wallet in the same transaction. A vendor can
 *    therefore never appear without the account that will hold its money.
 * 2. **Approval grants the vendor role.** `users.role` is updated inside the
 *    approval transaction (or the hashing of the decision is meaningless), and the
 *    audit row is written in that same transaction, so the trail cannot disagree
 *    with the state.
 */
@Injectable()
export class VendorsService {
  private readonly logger = new Logger(VendorsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly torobFeedCache: TorobFeedCacheService,
  ) {}

  // ─── Registration ─────────────────────────────────────────────────────────

  /**
   * Creates the store and its wallet in one transaction.
   *
   * The owner keeps the `CUSTOMER` role until an admin approves the store: a
   * self-declared vendor that could immediately publish products would make the
   * verification workflow decorative.
   */
  async register(params: RegisterVendorParams): Promise<VendorProfileView> {
    const storeSlug = params.storeSlug.trim().toLowerCase();
    if (RESERVED_SLUGS.has(storeSlug)) {
      throw new BadRequestException(`The store slug "${storeSlug}" is reserved by the platform`);
    }

    const user = await this.prisma.user.findUnique({
      where: { id: params.userId },
      select: { id: true, role: true, isActive: true },
    });
    if (user === null) {
      throw new NotFoundException('User account not found');
    }
    if (!user.isActive) {
      throw new ForbiddenException('A deactivated account cannot open a store');
    }
    if (STAFF_ROLES.has(user.role)) {
      throw new ForbiddenException(
        'Staff accounts cannot open a store: reviewing and being reviewed must stay separate',
      );
    }

    const existing = await this.prisma.vendor.findUnique({
      where: { userId: params.userId },
      select: { id: true, status: true },
    });
    if (existing !== null) {
      throw new ConflictException(
        `This account already has a store (status ${existing.status}); use GET /vendors/me to follow it`,
      );
    }

    try {
      const vendorId = await this.prisma.$transaction(async (tx) => {
        // Read inside the transaction as well: two simultaneous registrations would
        // both pass the check above, and only the unique constraints would catch
        // them. Doing it here turns that race into a clean conflict.
        const slugTaken = await tx.vendor.findUnique({
          where: { storeSlug },
          select: { id: true },
        });
        if (slugTaken !== null) {
          throw new ConflictException(`The store slug "${storeSlug}" is already taken`);
        }

        const vendor = await tx.vendor.create({
          data: {
            userId: params.userId,
            storeName: params.storeName,
            storeSlug,
            instagramHandle: normalizeInstagramHandle(params.instagramHandle),
            bio: params.bio ?? null,
            bankIban: normalizeSheba(params.bankIban),
            bankAccountHolder: params.bankAccountHolder,
            status: VendorStatus.PENDING,
          },
          select: { id: true },
        });

        // Invariant: the wallet exists from the first second of the store's life.
        await tx.vendorWallet.create({ data: { vendorId: vendor.id }, select: { id: true } });

        return vendor.id;
      });

      this.logger.log(`Vendor ${vendorId} registered by user ${params.userId} (slug "${storeSlug}")`);
      return await this.requireProfileByVendorId(vendorId);
    } catch (error) {
      throw this.translateUniqueViolation(error, storeSlug);
    }
  }

  // ─── KYC documents ────────────────────────────────────────────────────────

  /**
   * Creates or refreshes the store's verification submission.
   *
   * A submission that has not been reviewed yet is *replaced* (the vendor is
   * fixing their own file). Once reviewed, it is history: a resubmission creates a
   * new row, so the admin sees what was rejected and what changed — which is
   * exactly what the `vendor_verifications` history table exists for.
   */
  async submitVerificationDocuments(params: SubmitVerificationParams): Promise<{
    profile: VendorProfileView;
    replacedPendingSubmission: boolean;
    status: VendorStatus;
  }> {
    const vendor = await this.requireVendorByUser(params.userId);

    const documentIds = [
      await this.assertOwnedDocument(params.userId, vendor.id, params.nationalIdCardUrl, 'nationalIdCardUrl'),
    ];
    if (params.businessLicenseUrl !== undefined) {
      documentIds.push(
        await this.assertOwnedDocument(params.userId, vendor.id, params.businessLicenseUrl, 'businessLicenseUrl'),
      );
    }
    if (params.bankAccountProofUrl !== undefined) {
      documentIds.push(
        await this.assertOwnedDocument(params.userId, vendor.id, params.bankAccountProofUrl, 'bankAccountProofUrl'),
      );
    }

    const { verificationId, replacedPendingSubmission } = await this.prisma.$transaction(async (tx) => {
      await this.linkAssetsToVendor(tx, vendor.id, documentIds);

      const pending = await tx.vendorVerification.findFirst({
        where: { vendorId: vendor.id, reviewedAt: null },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });

      const data = {
        nationalCardDocUrl: params.nationalIdCardUrl,
        businessDocUrl: params.businessLicenseUrl ?? null,
        bankAccountProofUrl: params.bankAccountProofUrl ?? null,
        // A new submission invalidates a previous rejection: the reason belongs to
        // the old file, not to the new one.
        rejectionReason: null,
      };

      const verification =
        pending === null
          ? await tx.vendorVerification.create({
              data: { vendorId: vendor.id, ...data },
              select: { id: true },
            })
          : await tx.vendorVerification.update({
              where: { id: pending.id },
              data,
              select: { id: true },
            });

      // A rejected store becomes reviewable again once new documents arrive.
      if (vendor.status === VendorStatus.REJECTED) {
        await tx.vendor.update({
          where: { id: vendor.id },
          data: { status: VendorStatus.PENDING, verifiedAt: null },
          select: { id: true },
        });
      }

      return { verificationId: verification.id, replacedPendingSubmission: pending !== null };
    });

    this.logger.log(
      `Vendor ${vendor.id} submitted verification documents (${verificationId}, replaced pending: ${String(replacedPendingSubmission)})`,
    );

    const profile = await this.requireProfileByVendorId(vendor.id);
    return { profile, replacedPendingSubmission, status: profile.vendor.status };
  }

  // ─── Storefront profile ───────────────────────────────────────────────────

  async getMyProfile(userId: string): Promise<VendorProfileView> {
    const vendor = await this.prisma.vendor.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (vendor === null) {
      throw new NotFoundException('No store is linked to this account; register one with POST /vendors/register');
    }
    return this.requireProfileByVendorId(vendor.id);
  }

  /**
   * Applies a partial profile update.
   *
   * Returns the warnings that must be shown to the vendor — currently the IBAN
   * change, which is the only field whose update has a consequence beyond the
   * profile itself.
   */
  async updateMyProfile(params: UpdateVendorProfileParams): Promise<{
    profile: VendorProfileView;
    warnings: string[];
  }> {
    const vendor = await this.requireVendorByUser(params.userId);
    const warnings: string[] = [];

    const touchesProfile =
      params.storeName !== undefined ||
      params.bio !== undefined ||
      params.instagramHandle !== undefined ||
      params.logoUrl !== undefined;
    const changesIban =
      params.bankIban !== undefined && normalizeSheba(params.bankIban) !== vendor.bankIban;
    const submitsBankProof = params.bankAccountProofUrl !== undefined;

    if (!touchesProfile && !changesIban && !submitsBankProof) {
      throw new BadRequestException(
        'No updatable field was provided (storeName, bio, instagramHandle, logoUrl, bankIban, bankAccountProofUrl)',
      );
    }

    // A stored URL must belong to this vendor: otherwise a storefront could point
    // at any file on the platform, including another vendor's private document.
    let logoAssetId: string | null = null;
    if (params.logoUrl !== undefined) {
      logoAssetId = await this.assertOwnedImage(params.userId, vendor.id, params.logoUrl, 'logoUrl');
    }
    if (submitsBankProof && !changesIban) {
      await this.assertOwnedDocument(params.userId, vendor.id, params.bankAccountProofUrl ?? '', 'bankAccountProofUrl');
    }

    if (changesIban && !submitsBankProof) {
      throw new BadRequestException(
        'Changing the bank IBAN requires a new proof of account ownership: send bankAccountProofUrl from POST /media/upload/document in the same request',
      );
    }

    await this.prisma.$transaction(async (tx) => {
      if (logoAssetId !== null) {
        await this.linkAssetsToVendor(tx, vendor.id, [logoAssetId]);
      }

      if (touchesProfile) {
        await tx.vendor.update({
          where: { id: vendor.id },
          data: {
            ...(params.storeName !== undefined ? { storeName: params.storeName } : {}),
            ...(params.bio !== undefined ? { bio: params.bio } : {}),
            ...(params.instagramHandle !== undefined
              ? { instagramHandle: normalizeInstagramHandle(params.instagramHandle) }
              : {}),
            ...(params.logoUrl !== undefined ? { logoUrl: params.logoUrl } : {}),
          },
          select: { id: true },
        });
      }

      if (changesIban) {
        const bankProofAssetId = await this.assertOwnedDocument(
          params.userId,
          vendor.id,
          params.bankAccountProofUrl ?? '',
          'bankAccountProofUrl',
          tx,
        );
        await this.linkAssetsToVendor(tx, vendor.id, [bankProofAssetId]);

        const previous = await tx.vendorVerification.findFirst({
          where: { vendorId: vendor.id },
          orderBy: { createdAt: 'desc' },
          select: { nationalCardDocUrl: true, businessDocUrl: true },
        });

        // The IBAN moves, the verification record does not: the store goes back to
        // PENDING with a fresh record that carries the new bank proof, so a reviewer
        // can compare the new IBAN against the document that justifies it.
        await tx.vendor.update({
          where: { id: vendor.id },
          data: {
            bankIban: normalizeSheba(params.bankIban ?? ''),
            status: VendorStatus.PENDING,
            verifiedAt: null,
          },
          select: { id: true },
        });

        await tx.vendorVerification.create({
          data: {
            vendorId: vendor.id,
            nationalCardDocUrl: previous?.nationalCardDocUrl ?? params.bankAccountProofUrl ?? '',
            businessDocUrl: previous?.businessDocUrl ?? null,
            bankAccountProofUrl: params.bankAccountProofUrl ?? null,
            rejectionReason: null,
          },
          select: { id: true },
        });

        warnings.push(
          `Bank account changed to ${maskSheba(normalizeSheba(params.bankIban ?? ''))}: ` +
            'the store returns to PENDING review until staff verify the new IBAN. Payouts stay on hold until then.',
        );
      }
    });

    const profile = await this.requireProfileByVendorId(vendor.id);
    return { profile, warnings };
  }

  // ─── Admin: listing, detail, decision ─────────────────────────────────────

  async listForAdmin(params: {
    status?: VendorStatus;
    search?: string;
    page: number;
    pageSize: number;
  }): Promise<{ rows: VendorAdminSummaryView[]; total: number }> {
    const search = params.search?.trim();
    const where: Prisma.VendorWhereInput = {
      ...(params.status !== undefined ? { status: params.status } : {}),
      ...(search !== undefined && search.length > 0
        ? {
            OR: [
              { storeName: { contains: search, mode: 'insensitive' } },
              { storeSlug: { contains: search.toLowerCase(), mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.vendor.findMany({
        where,
        orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
        select: VENDOR_SUMMARY_SELECT,
      }),
      this.prisma.vendor.count({ where }),
    ]);

    return { rows: rows.map((row) => this.toSummaryView(row)), total };
  }

  async getForAdmin(vendorId: string): Promise<VendorAdminDetailView> {
    const row = await this.prisma.vendor.findUnique({
      where: { id: vendorId },
      select: {
        ...VENDOR_SUMMARY_SELECT,
        bio: true,
        bankIban: true,
        bankAccountHolder: true,
        commissionRateOverride: true,
        verifications: {
          orderBy: { createdAt: 'desc' },
          select: VERIFICATION_SELECT,
        },
      },
    });
    if (row === null) {
      throw new NotFoundException('Vendor not found');
    }

    const verificationIds = row.verifications.map((verification) => verification.id);
    const auditRows = await this.prisma.auditLog.findMany({
      where: {
        OR: [
          { entityName: 'Vendor', entityId: vendorId },
          ...(verificationIds.length > 0
            ? [{ entityName: 'VendorVerification', entityId: { in: verificationIds } }]
            : []),
        ],
      },
      orderBy: { createdAt: 'desc' },
      take: AUDIT_TRAIL_LIMIT,
      select: {
        id: true,
        action: true,
        entityName: true,
        entityId: true,
        userId: true,
        ipAddress: true,
        oldValue: true,
        newValue: true,
        createdAt: true,
      },
    });

    const actorIds = [...new Set(auditRows.map((entry) => entry.userId).filter((id): id is string => id !== null))];
    const actors =
      actorIds.length === 0
        ? []
        : await this.prisma.user.findMany({
            where: { id: { in: actorIds } },
            select: { id: true, fullName: true },
          });
    const actorNames = new Map(actors.map((actor) => [actor.id, actor.fullName]));

    const assetById = new Map(
      [...row.mediaAssets, ...row.user.mediaAssets].map((asset) => [asset.id, asset]),
    );

    return {
      summary: this.toSummaryView(row),
      bio: row.bio,
      bankIban: row.bankIban,
      bankAccountHolder: row.bankAccountHolder,
      commissionRateOverride: row.commissionRateOverride?.toFixed(2) ?? null,
      verifications: row.verifications.map((verification) => this.toVerificationView(verification)),
      mediaAssets: [...assetById.values()]
        .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
        .slice(0, MEDIA_ASSET_LIMIT)
        .map((asset) => this.toMediaAssetView(asset)),
      auditTrail: auditRows.map((entry) => ({
        id: entry.id,
        action: entry.action,
        entityName: entry.entityName,
        entityId: entry.entityId,
        actorId: entry.userId,
        actorName: entry.userId === null ? null : (actorNames.get(entry.userId) ?? null),
        ipAddress: entry.ipAddress,
        oldValue: entry.oldValue,
        newValue: entry.newValue,
        createdAt: entry.createdAt,
      })),
    };
  }

  /**
   * Publishes the verification decision.
   *
   * The whole decision is **one** transaction — vendor status, the reviewer's
   * stamp on the submission, the wallet guarantee, the role grant and the audit
   * row. There is no window in which a vendor is APPROVED without a wallet, or has
   * the vendor role without an approval to justify it, and no window in which the
   * audit trail disagrees with the stored state.
   */
  async verifyVendor(params: VerifyVendorParams): Promise<{
    profile: VendorProfileView;
    previousStatus: VendorStatus;
    walletCreated: boolean;
    roleUpdated: boolean;
    auditLogId: string;
  }> {
    if (params.status === VendorDecision.REJECTED && (params.rejectionReason ?? '').trim().length < 10) {
      throw new BadRequestException('rejectionReason is required when rejecting a vendor (at least 10 characters)');
    }
    if (params.status === VendorDecision.APPROVED && params.rejectionReason !== null && params.rejectionReason !== undefined) {
      throw new BadRequestException('rejectionReason must be null when approving a vendor');
    }

    const rejectionReason = params.status === VendorDecision.REJECTED ? (params.rejectionReason ?? '').trim() : null;
    const commissionRateOverride =
      params.commissionRateOverride === undefined ? null : params.commissionRateOverride;

    const vendor = await this.prisma.vendor.findUnique({
      where: { id: params.vendorId },
      select: {
        id: true,
        userId: true,
        status: true,
        verifiedAt: true,
        commissionRateOverride: true,
        user: { select: { id: true, role: true } },
      },
    });
    if (vendor === null) {
      throw new NotFoundException('Vendor not found');
    }

    const submission = await this.prisma.vendorVerification.findFirst({
      where: { vendorId: vendor.id },
      orderBy: { createdAt: 'desc' },
      select: { id: true, reviewedAt: true },
    });

    if (params.status === VendorDecision.APPROVED && submission === null) {
      throw new ConflictException(
        'This vendor has not submitted verification documents yet; there is nothing to approve',
      );
    }
    if (params.status === VendorDecision.REJECTED && (submission === null || submission.reviewedAt !== null)) {
      throw new ConflictException(
        submission === null
          ? 'This vendor has not submitted verification documents yet; there is nothing to reject'
          : 'The latest submission has already been reviewed; wait for a new submission from the vendor',
      );
    }
    if (vendor.status === VendorStatus.REJECTED && params.status === VendorDecision.APPROVED && submission?.reviewedAt !== null) {
      // Approving after a rejection is legitimate (the admin changed their mind),
      // but it must be an explicit re-review, which is what this message asks for.
      this.logger.warn(
        `Vendor ${vendor.id} is approved after a rejection; the reviewer must re-check the documents (admin ${params.reviewerId})`,
      );
    }

    const decidedAt = new Date();

    const outcome = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.vendor.update({
        where: { id: vendor.id },
        data: {
          status: params.status,
          verifiedAt: params.status === VendorDecision.APPROVED ? decidedAt : null,
          commissionRateOverride:
            commissionRateOverride === null ? null : new Prisma.Decimal(commissionRateOverride),
        },
        select: { id: true },
      });

      if (submission !== null) {
        await tx.vendorVerification.update({
          where: { id: submission.id },
          data: {
            reviewedByUserId: params.reviewerId,
            reviewedAt: decidedAt,
            rejectionReason,
          },
          select: { id: true },
        });
      }

      let walletCreated = false;
      let roleUpdated = false;

      if (params.status === VendorDecision.APPROVED) {
        const existingWallet = await tx.vendorWallet.findUnique({
          where: { vendorId: vendor.id },
          select: { id: true },
        });
        // `upsert` (not find-then-create) so two admins approving at the same
        // moment still produce exactly one wallet for the vendor.
        await tx.vendorWallet.upsert({
          where: { vendorId: vendor.id },
          create: { vendorId: vendor.id },
          update: {},
          select: { id: true },
        });
        walletCreated = existingWallet === null;

        if (vendor.user.role !== UserRole.VENDOR) {
          if (STAFF_ROLES.has(vendor.user.role)) {
            throw new ConflictException(
              'This store belongs to a staff account; granting the vendor role is not allowed',
            );
          }
          await tx.user.update({
            where: { id: vendor.userId },
            data: { role: UserRole.VENDOR },
            select: { id: true },
          });
          roleUpdated = true;
        }
      }

      const auditRow = await tx.auditLog.create({
        data: {
          userId: params.reviewerId,
          action: AuditAction.STATUS_CHANGE,
          entityName: 'Vendor',
          entityId: vendor.id,
          ipAddress: params.context.ipAddress,
          userAgent: params.context.userAgent,
          oldValue: sanitize({
            status: vendor.status,
            verifiedAt: vendor.verifiedAt,
            commissionRateOverride: vendor.commissionRateOverride?.toFixed(2) ?? null,
          }) as Prisma.InputJsonValue,
          newValue: sanitize({
            status: params.status,
            verifiedAt: params.status === VendorDecision.APPROVED ? decidedAt : null,
            commissionRateOverride: commissionRateOverride?.toFixed(2) ?? null,
            rejectionReason,
            verificationId: submission?.id ?? null,
            walletCreated,
            roleUpdated,
          }) as Prisma.InputJsonValue,
        },
        select: { id: true },
      });

      return { walletCreated, roleUpdated, auditLogId: auditRow.id, vendorId: updated.id };
    });

    this.logger.log(
      `Vendor ${vendor.id} ${params.status} by ${params.reviewerId} (walletCreated=${String(outcome.walletCreated)}, roleUpdated=${String(outcome.roleUpdated)}, audit=${outcome.auditLogId})`,
    );

    // The store's status decides whether its catalogue is public: cached Torob
    // feed pages may now list (or miss) its offers. Runs after the commit.
    await this.torobFeedCache.invalidate();

    const profile = await this.requireProfileByVendorId(vendor.id);
    return {
      profile,
      previousStatus: vendor.status,
      walletCreated: outcome.walletCreated,
      roleUpdated: outcome.roleUpdated,
      auditLogId: outcome.auditLogId,
    };
  }

  // ─── Guards and helpers ───────────────────────────────────────────────────

  /** Loads the vendor row of a user or fails with a message that tells them why. */
  private async requireVendorByUser(userId: string): Promise<VendorRecord> {
    const vendor = await this.prisma.vendor.findUnique({
      where: { userId },
      select: VENDOR_RECORD_SELECT,
    });
    if (vendor === null) {
      throw new NotFoundException('No store is linked to this account; register one with POST /vendors/register');
    }
    return this.toVendorRecord(vendor);
  }

  private async requireProfileByVendorId(vendorId: string): Promise<VendorProfileView> {
    const vendor = await this.prisma.vendor.findUnique({
      where: { id: vendorId },
      select: {
        ...VENDOR_RECORD_SELECT,
        wallet: { select: WALLET_SELECT },
        verifications: { orderBy: { createdAt: 'desc' }, take: 1, select: VERIFICATION_SELECT },
        user: { select: { mediaAssets: MEDIA_ASSETS_SELECT } },
        mediaAssets: MEDIA_ASSETS_SELECT,
      },
    });
    if (vendor === null) {
      throw new NotFoundException('Vendor not found');
    }

    // Assets linked to the store plus the ones its owner uploaded before the store
    // existed, de-duplicated and ordered newest first.
    const byId = new Map(
      [...vendor.mediaAssets, ...vendor.user.mediaAssets].map((asset) => [asset.id, asset]),
    );
    const mediaAssets = [...byId.values()]
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
      .slice(0, MEDIA_ASSET_LIMIT)
      .map((asset) => this.toMediaAssetView(asset));

    return {
      vendor: this.toVendorRecord(vendor),
      wallet: vendor.wallet === null ? null : this.toWalletView(vendor.wallet),
      verification:
        vendor.verifications.length === 0 ? null : this.toVerificationView(vendor.verifications[0]!),
      mediaAssets,
    };
  }

  /**
   * Confirms that a URL points at a document this user uploaded.
   *
   * This is what makes the KYC body trustworthy: the client cannot reference
   * another user's file, an external URL, or a non-document asset, because the
   * service resolves the string against `media_assets` and checks the owner.
   */
  private async assertOwnedDocument(
    userId: string,
    vendorId: string,
    url: string,
    field: string,
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<string> {
    const asset = await client.mediaAsset.findFirst({
      where: { url, kind: MediaKind.DOCUMENT },
      select: { id: true, ownerUserId: true, vendorId: true },
    });

    if (asset === null) {
      throw new BadRequestException(
        `${field} must reference a document uploaded through POST /media/upload/document`,
      );
    }
    if (asset.ownerUserId !== userId && asset.vendorId !== vendorId) {
      throw new ForbiddenException(`${field} belongs to another account and cannot be attached to this store`);
    }
    return asset.id;
  }

  /**
   * Links the referenced media rows to the store.
   *
   * A document is uploaded before the store exists (the KYC flow needs the file to
   * submit it), so the connection is completed here, inside the same transaction as
   * the submission. From this point the asset belongs to the vendor: the admin
   * detail view, the store profile and any future retention policy all find it
   * through `media_assets.vendor_id`.
   */
  private async linkAssetsToVendor(
    tx: Prisma.TransactionClient,
    vendorId: string,
    assetIds: string[],
  ): Promise<void> {
    if (assetIds.length === 0) {
      return;
    }
    await tx.mediaAsset.updateMany({
      where: { id: { in: assetIds }, vendorId: null },
      data: { vendorId },
    });
  }

  private async assertOwnedImage(
    userId: string,
    vendorId: string,
    url: string,
    field: string,
  ): Promise<string> {
    const asset = await this.prisma.mediaAsset.findFirst({
      where: { url, kind: MediaKind.IMAGE },
      select: { id: true, ownerUserId: true, vendorId: true },
    });

    if (asset === null) {
      throw new BadRequestException(
        `${field} must reference an image uploaded through POST /media/upload/image`,
      );
    }
    if (asset.ownerUserId !== userId && asset.vendorId !== vendorId) {
      throw new ForbiddenException(`${field} belongs to another account and cannot be used by this store`);
    }
    return asset.id;
  }

  /** Turns a database uniqueness violation into the conflict it actually is. */
  private translateUniqueViolation(error: unknown, storeSlug: string): unknown {
    if (error instanceof ConflictException) {
      return error;
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const rawTarget: unknown = error.meta?.['target'];
      const target = Array.isArray(rawTarget)
        ? rawTarget.filter((value): value is string => typeof value === 'string').join(', ')
        : typeof rawTarget === 'string'
          ? rawTarget
          : 'unique field';
      return new ConflictException(`A store with this ${target} already exists ("${storeSlug}")`);
    }
    this.logger.error(`Vendor registration failed: ${errorMessage(error)}`);
    return error;
  }

  private toVendorRecord(row: VendorRow): VendorRecord {
    return {
      id: row.id,
      userId: row.userId,
      storeName: row.storeName,
      storeSlug: row.storeSlug,
      instagramHandle: row.instagramHandle,
      logoUrl: row.logoUrl,
      bio: row.bio,
      bankIban: row.bankIban,
      bankAccountHolder: row.bankAccountHolder,
      commissionRateOverride: row.commissionRateOverride?.toFixed(2) ?? null,
      status: row.status,
      verifiedAt: row.verifiedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private toWalletView(row: WalletRow): VendorWalletView {
    return {
      pendingBalance: row.pendingBalance.toFixed(2),
      withdrawableBalance: row.withdrawableBalance.toFixed(2),
      totalEarnedBalance: row.totalEarnedBalance.toFixed(2),
      updatedAt: row.updatedAt,
    };
  }

  private toVerificationView(row: VerificationRow): VendorVerificationView {
    return {
      id: row.id,
      nationalIdCardUrl: row.nationalCardDocUrl,
      businessLicenseUrl: row.businessDocUrl,
      bankAccountProofUrl: row.bankAccountProofUrl,
      rejectionReason: row.rejectionReason,
      reviewedByUserId: row.reviewedByUserId,
      reviewedByName: row.reviewedBy?.fullName ?? null,
      reviewedAt: row.reviewedAt,
      createdAt: row.createdAt,
    };
  }

  private toMediaAssetView(row: MediaAssetRow): MediaAssetSummaryView {
    return {
      id: row.id,
      kind: row.kind,
      purpose: row.purpose,
      url: row.url,
      thumbnailUrl: row.thumbnailUrl,
      isPublic: row.isPublic,
      createdAt: row.createdAt,
    };
  }

  private toSummaryView(row: VendorSummaryRow): VendorAdminSummaryView {
    return {
      id: row.id,
      storeName: row.storeName,
      storeSlug: row.storeSlug,
      instagramHandle: row.instagramHandle,
      logoUrl: row.logoUrl,
      status: row.status,
      verifiedAt: row.verifiedAt,
      productCount: row._count?.products ?? 0,
      wallet: row.wallet === null || row.wallet === undefined ? null : this.toWalletView(row.wallet),
      owner: {
        id: row.user.id,
        mobile: row.user.mobile,
        email: row.user.email,
        fullName: row.user.fullName,
        role: row.user.role,
        isActive: row.user.isActive,
      },
      createdAt: row.createdAt,
    };
  }
}

// ─── Prisma selections and the structural row types they produce ────────────

const VENDOR_RECORD_SELECT = {
  id: true,
  userId: true,
  storeName: true,
  storeSlug: true,
  instagramHandle: true,
  logoUrl: true,
  bio: true,
  bankIban: true,
  bankAccountHolder: true,
  commissionRateOverride: true,
  status: true,
  verifiedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

const WALLET_SELECT = {
  pendingBalance: true,
  withdrawableBalance: true,
  totalEarnedBalance: true,
  updatedAt: true,
} as const;

const VERIFICATION_SELECT = {
  id: true,
  nationalCardDocUrl: true,
  businessDocUrl: true,
  bankAccountProofUrl: true,
  rejectionReason: true,
  reviewedByUserId: true,
  reviewedBy: { select: { fullName: true } },
  reviewedAt: true,
  createdAt: true,
} as const;

/** Selection for "the store's files": assets linked to the store, plus the ones its owner uploaded. */
const MEDIA_ASSETS_SELECT = {
  orderBy: { createdAt: 'desc' },
  take: MEDIA_ASSET_LIMIT,
  select: {
    id: true,
    kind: true,
    purpose: true,
    url: true,
    thumbnailUrl: true,
    isPublic: true,
    createdAt: true,
  },
} as const;



const VENDOR_SUMMARY_SELECT = {
  id: true,
  storeName: true,
  storeSlug: true,
  instagramHandle: true,
  logoUrl: true,
  status: true,
  verifiedAt: true,
  createdAt: true,
  user: {
    select: {
      id: true,
      mobile: true,
      email: true,
      fullName: true,
      role: true,
      isActive: true,
      mediaAssets: MEDIA_ASSETS_SELECT,
    },
  },
  wallet: { select: WALLET_SELECT },
  mediaAssets: MEDIA_ASSETS_SELECT,
  _count: { select: { products: true } },
} as const;

interface VendorRow {
  id: string;
  userId: string;
  storeName: string;
  storeSlug: string;
  instagramHandle: string | null;
  logoUrl: string | null;
  bio: string | null;
  bankIban: string;
  bankAccountHolder: string | null;
  commissionRateOverride: Prisma.Decimal | null;
  status: VendorStatus;
  verifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface WalletRow {
  pendingBalance: Prisma.Decimal;
  withdrawableBalance: Prisma.Decimal;
  totalEarnedBalance: Prisma.Decimal;
  updatedAt: Date;
}

interface VerificationRow {
  id: string;
  nationalCardDocUrl: string;
  businessDocUrl: string | null;
  bankAccountProofUrl: string | null;
  rejectionReason: string | null;
  reviewedByUserId: string | null;
  reviewedBy: { fullName: string } | null;
  reviewedAt: Date | null;
  createdAt: Date;
}

interface MediaAssetRow {
  id: string;
  kind: MediaKind;
  purpose: string;
  url: string;
  thumbnailUrl: string | null;
  isPublic: boolean;
  createdAt: Date;
}

interface VendorSummaryRow {
  id: string;
  storeName: string;
  storeSlug: string;
  instagramHandle: string | null;
  logoUrl: string | null;
  status: VendorStatus;
  verifiedAt: Date | null;
  createdAt: Date;
  user: {
    id: string;
    mobile: string;
    email: string | null;
    fullName: string;
    role: UserRole;
    isActive: boolean;
    mediaAssets: MediaAssetRow[];
  };
  mediaAssets: MediaAssetRow[];
  wallet: WalletRow | null;
  _count?: { products: number };
}

/** Re-exported so controllers can annotate their Swagger bodies without re-importing. */
export { VENDOR_DECISIONS };
