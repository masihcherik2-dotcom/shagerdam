import { ApiProperty } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import type { PublicUser } from '../users.service';

/** Public projection of a user row. The password hash is not part of this type. */
export class UserIdentityDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: '+989120000001', description: 'شماره موبایل به قالب E.164' })
  mobile!: string;

  @ApiProperty({ nullable: true, example: 'admin@shopino.local' })
  email!: string | null;

  @ApiProperty({ example: 'مدیر ارشد پلتفرم' })
  fullName!: string;

  @ApiProperty({ enum: UserRole })
  role!: UserRole;

  @ApiProperty({ example: true })
  isActive!: boolean;

  @ApiProperty({ nullable: true, example: '0499370899' })
  nationalCode!: string | null;

  @ApiProperty({ nullable: true, format: 'date-time' })
  lastLoginAt!: Date | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;

  static from(user: PublicUser): UserIdentityDto {
    return {
      id: user.id,
      mobile: user.mobile,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      isActive: user.isActive,
      nationalCode: user.nationalCode,
      lastLoginAt: user.lastLoginAt,
      createdAt: user.createdAt,
    };
  }
}

export class PaginatedUsersDto {
  @ApiProperty({ type: [UserIdentityDto] })
  items!: UserIdentityDto[];

  @ApiProperty({ example: 1 })
  page!: number;

  @ApiProperty({ example: 20 })
  pageSize!: number;

  @ApiProperty({ example: 42 })
  total!: number;

  @ApiProperty({ example: 3 })
  totalPages!: number;
}
