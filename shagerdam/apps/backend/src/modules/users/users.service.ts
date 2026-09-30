import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, UserRole, type Gender } from '@prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { toE164, toNationalFormat } from '../../common/validators/iranian-mobile';
import { normalizeNationalCode } from '../../common/validators/iranian-national-code';
import type { UpdateProfileDto } from './dto/update-profile.dto';

/** Columns safe to hand to a client; `passwordHash` never leaves the database. */
export const PUBLIC_USER_SELECT = {
  id: true,
  mobile: true,
  email: true,
  fullName: true,
  role: true,
  isActive: true,
  nationalCode: true,
  lastLoginAt: true,
  createdAt: true,
} satisfies Prisma.UserSelect;

export interface PublicUser {
  id: string;
  mobile: string;
  email: string | null;
  fullName: string;
  role: UserRole;
  isActive: boolean;
  nationalCode: string | null;
  lastLoginAt: Date | null;
  createdAt: Date;
}

export interface CustomerProfileSummary {
  birthDate: Date | null;
  gender: Gender | null;
  bankIban: string | null;
  defaultAddressId: string | null;
}

export interface VendorProfileSummary {
  id: string;
  storeName: string;
  storeSlug: string;
  status: string;
  logoUrl: string | null;
}

export interface UserIdentity {
  user: PublicUser;
  customerProfile: CustomerProfileSummary | null;
  vendor: VendorProfileSummary | null;
}

export interface ProfileUpdateResult {
  before: { fullName: string; email: string | null; nationalCode: string | null; birthDate: Date | null };
  after: { fullName: string; email: string | null; nationalCode: string | null; birthDate: Date | null };
  user: PublicUser;
}

/**
 * All reads and writes of the identity tables live here, so `AuthService` (which
 * owns the login flows) never builds a user query itself.
 *
 * Two invariants are enforced at this layer because the database alone cannot
 * express them:
 *
 * - a user created through the OTP flow *always* gets a `CustomerProfile` in the
 *   same transaction, so "customer without a profile" is not a state the rest of
 *   the platform has to defend against;
 * - `passwordHash` is never selected for anything that travels to a client.
 */
@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Finds a user by canonical E.164 mobile number. */
  async findByMobile(mobile: string): Promise<UserIdentity | null> {
    const normalized = toE164(mobile) ?? mobile;
    const user = await this.prisma.user.findUnique({
      where: { mobile: normalized },
      select: { ...PUBLIC_USER_SELECT, customerProfile: true, vendor: true },
    });
    return user === null ? null : this.toIdentity(user);
  }

  /**
   * Resolves the identifier used on the password-login form: an e-mail address
   * or a mobile number in any accepted spelling.
   */
  async findByIdentifier(identifier: string): Promise<(UserIdentity & { passwordHash: string | null }) | null> {
    const trimmed = identifier.trim();
    const mobile = toE164(trimmed);

    const user = await this.prisma.user.findFirst({
      where: mobile !== null ? { mobile } : { email: { equals: trimmed.toLowerCase() } },
      select: { ...PUBLIC_USER_SELECT, passwordHash: true, customerProfile: true, vendor: true },
    });

    if (user === null) {
      return null;
    }
    return { ...this.toIdentity(user), passwordHash: user.passwordHash };
  }

  /** Loads the full identity of an authenticated user (`GET /auth/me`). */
  async getIdentity(userId: string): Promise<UserIdentity> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { ...PUBLIC_USER_SELECT, customerProfile: true, vendor: true },
    });

    if (user === null) {
      throw new NotFoundException('User not found');
    }
    return this.toIdentity(user);
  }

  /**
   * Creates the account for a mobile number that was just verified by OTP.
   *
   * The operation is idempotent under concurrent verification: if two requests
   * race, the unique index on `users.mobile` rejects the loser and this method
   * returns the winner's row instead of failing the login.
   */
  async ensureCustomer(mobile: string): Promise<UserIdentity> {
    const normalized = toE164(mobile) ?? mobile;
    const existing = await this.findByMobile(normalized);
    if (existing !== null) {
      return existing;
    }

    try {
      const created = await this.prisma.user.create({
        data: {
          mobile: normalized,
          fullName: `کاربر ${toNationalFormat(normalized)}`,
          role: UserRole.CUSTOMER,
          customerProfile: { create: {} },
        },
        select: { ...PUBLIC_USER_SELECT, customerProfile: true, vendor: true },
      });

      this.logger.log(`Customer account created on first OTP login: ${normalized}`);
      return this.toIdentity(created);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const winner = await this.findByMobile(normalized);
        if (winner !== null) {
          return winner;
        }
      }
      throw error;
    }
  }

  /** Records a successful authentication. Best-effort: never blocks the login. */
  async touchLastLogin(userId: string): Promise<void> {
    try {
      await this.prisma.user.update({ where: { id: userId }, data: { lastLoginAt: new Date() } });
    } catch (error) {
      this.logger.warn(`Could not update lastLoginAt for ${userId}: ${String(error)}`);
    }
  }

  /**
   * Applies a profile update and returns both the previous and the new state, so
   * the audit interceptor can record a real before/after without a second read.
   */
  async updateProfile(userId: string, dto: UpdateProfileDto): Promise<ProfileUpdateResult> {
    const current = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { ...PUBLIC_USER_SELECT, customerProfile: { select: { birthDate: true } } },
    });
    if (current === null) {
      throw new NotFoundException('User not found');
    }

    const email = dto.email === undefined ? undefined : dto.email.trim().toLowerCase();
    if (email !== undefined && email !== current.email) {
      const taken = await this.prisma.user.findUnique({ where: { email }, select: { id: true } });
      if (taken !== null && taken.id !== userId) {
        throw new ConflictException('This e-mail address is already registered');
      }
    }

    const nationalCode = dto.nationalCode === undefined ? undefined : normalizeNationalCode(dto.nationalCode);
    if (nationalCode !== undefined && nationalCode !== current.nationalCode) {
      const taken = await this.prisma.user.findUnique({ where: { nationalCode }, select: { id: true } });
      if (taken !== null && taken.id !== userId) {
        throw new ConflictException('This national code is already registered');
      }
    }

    const birthDate = dto.birthDate === undefined ? undefined : new Date(dto.birthDate);

    const updated = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.update({
        where: { id: userId },
        data: {
          ...(dto.fullName !== undefined ? { fullName: dto.fullName.trim() } : {}),
          ...(email !== undefined ? { email } : {}),
          ...(nationalCode !== undefined ? { nationalCode } : {}),
        },
        select: PUBLIC_USER_SELECT,
      });

      if (birthDate !== undefined) {
        await tx.customerProfile.upsert({
          where: { userId },
          create: { userId, birthDate },
          update: { birthDate },
        });
      }

      return user;
    });

    return {
      before: {
        fullName: current.fullName,
        email: current.email,
        nationalCode: current.nationalCode,
        birthDate: current.customerProfile?.birthDate ?? null,
      },
      after: {
        fullName: updated.fullName,
        email: updated.email,
        nationalCode: updated.nationalCode,
        birthDate: birthDate ?? current.customerProfile?.birthDate ?? null,
      },
      user: updated,
    };
  }

  /** Admin search over the identity table. Phone numbers are matched exactly. */
  async search(params: {
    query?: string;
    role?: UserRole;
    isActive?: boolean;
    page: number;
    pageSize: number;
  }): Promise<{ rows: PublicUser[]; total: number }> {
    const mobile = params.query ? toE164(params.query) : null;
    const where: Prisma.UserWhereInput = {
      ...(params.role ? { role: params.role } : {}),
      ...(params.isActive === undefined ? {} : { isActive: params.isActive }),
      ...(params.query
        ? {
            OR: [
              ...(mobile !== null ? [{ mobile }] : []),
              { email: { contains: params.query, mode: 'insensitive' as const } },
              { fullName: { contains: params.query, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        select: PUBLIC_USER_SELECT,
        orderBy: { createdAt: 'desc' },
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
      }),
      this.prisma.user.count({ where }),
    ]);

    return { rows, total };
  }

  private toIdentity(user: {
    id: string;
    mobile: string;
    email: string | null;
    fullName: string;
    role: UserRole;
    isActive: boolean;
    nationalCode: string | null;
    lastLoginAt: Date | null;
    createdAt: Date;
    customerProfile: CustomerProfileSummary | null;
    vendor: VendorProfileSummary | null;
  }): UserIdentity {
    return {
      user: {
        id: user.id,
        mobile: user.mobile,
        email: user.email,
        fullName: user.fullName,
        role: user.role,
        isActive: user.isActive,
        nationalCode: user.nationalCode,
        lastLoginAt: user.lastLoginAt,
        createdAt: user.createdAt,
      },
      customerProfile:
        user.customerProfile === null
          ? null
          : {
              birthDate: user.customerProfile.birthDate,
              gender: user.customerProfile.gender,
              bankIban: user.customerProfile.bankIban,
              defaultAddressId: user.customerProfile.defaultAddressId,
            },
      vendor:
        user.vendor === null
          ? null
          : {
              id: user.vendor.id,
              storeName: user.vendor.storeName,
              storeSlug: user.vendor.storeSlug,
              status: user.vendor.status,
              logoUrl: user.vendor.logoUrl,
            },
    };
  }
}
