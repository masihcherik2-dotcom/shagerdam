import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditAction, Prisma } from '@prisma/client';
import type { RequestContext } from '../../common/types/request-context';
import { toE164 } from '../../common/validators/iranian-mobile';
import { PrismaService } from '../../infra/prisma/prisma.service';
import type { CreateAddressDto, UpdateAddressDto } from './dto/address-input.dto';
import type { AddressDto, DeleteAddressResponseDto } from './dto/address-response.dto';

/** Upper bound on saved addresses per customer (abuse protection, not a business rule). */
export const MAX_ADDRESSES_PER_CUSTOMER = 20;

type Tx = Prisma.TransactionClient;

interface ActorParams {
  actorId: string;
  context: RequestContext;
}

const addressSelect = {
  id: true,
  province: true,
  city: true,
  postalAddress: true,
  postalCode: true,
  buildingNumber: true,
  unitNumber: true,
  recipientName: true,
  recipientMobile: true,
  isDefault: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.AddressSelect;

const listOrder: Prisma.AddressOrderByWithRelationInput[] = [{ isDefault: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }];

/**
 * A customer's address book.
 *
 * Invariants: a customer with addresses has exactly one default, and
 * `customer_profiles.default_address_id` always points at it. Both are changed in
 * the same transaction, under a row lock on the user, so two concurrent "make
 * default" requests cannot leave two defaults behind.
 *
 * Addresses are always deletable: an order copies the address into
 * `parent_orders.shipping_address_snapshot` at checkout, so no order depends on
 * the row afterwards.
 *
 * Audit rows record *which* fields changed, never the values: addresses and
 * recipient phone numbers are personal data and do not belong in a long-lived log.
 */
@Injectable()
export class AddressesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string): Promise<AddressDto[]> {
    return this.prisma.address.findMany({ where: { userId }, select: addressSelect, orderBy: listOrder });
  }

  async create(userId: string, dto: CreateAddressDto, params: ActorParams): Promise<AddressDto> {
    return this.prisma.$transaction(async (tx) => {
      await lockUser(tx, userId);
      const count = await tx.address.count({ where: { userId } });
      if (count >= MAX_ADDRESSES_PER_CUSTOMER) {
        throw new ConflictException(
          `An address book holds at most ${MAX_ADDRESSES_PER_CUSTOMER} addresses; delete one before adding another`,
        );
      }
      const makeDefault = count === 0 || dto.isDefault === true;
      if (makeDefault) {
        await tx.address.updateMany({ where: { userId, isDefault: true }, data: { isDefault: false } });
      }
      const address = await tx.address.create({
        data: {
          userId,
          province: dto.province,
          city: dto.city,
          postalAddress: dto.postalAddress,
          postalCode: dto.postalCode,
          buildingNumber: dto.buildingNumber ?? null,
          unitNumber: dto.unitNumber ?? null,
          recipientName: dto.recipientName,
          recipientMobile: canonicalMobile(dto.recipientMobile),
          isDefault: makeDefault,
        },
        select: addressSelect,
      });
      if (makeDefault) {
        await syncProfileDefault(tx, userId, address.id);
      }
      await audit(tx, params, AuditAction.CREATE, address.id, { isDefault: makeDefault });
      return address;
    });
  }

  async update(userId: string, addressId: string, dto: UpdateAddressDto, params: ActorParams): Promise<AddressDto> {
    const changedFields = Object.entries(dto)
      .filter(([, value]) => value !== undefined)
      .map(([key]) => key);
    if (changedFields.length === 0) {
      throw new BadRequestException('Send at least one field to update');
    }
    if (dto.isDefault === false) {
      throw new BadRequestException('isDefault only accepts true; mark another address as default instead');
    }

    return this.prisma.$transaction(async (tx) => {
      await lockUser(tx, userId);
      const current = await tx.address.findFirst({ where: { id: addressId, userId }, select: { id: true, isDefault: true } });
      if (!current) {
        throw new NotFoundException('Address not found');
      }
      if (dto.isDefault === true && !current.isDefault) {
        await tx.address.updateMany({ where: { userId, isDefault: true }, data: { isDefault: false } });
        await syncProfileDefault(tx, userId, addressId);
      }
      const address = await tx.address.update({
        where: { id: addressId },
        data: {
          ...(dto.province !== undefined ? { province: dto.province } : {}),
          ...(dto.city !== undefined ? { city: dto.city } : {}),
          ...(dto.postalAddress !== undefined ? { postalAddress: dto.postalAddress } : {}),
          ...(dto.postalCode !== undefined ? { postalCode: dto.postalCode } : {}),
          ...(dto.buildingNumber !== undefined ? { buildingNumber: dto.buildingNumber } : {}),
          ...(dto.unitNumber !== undefined ? { unitNumber: dto.unitNumber } : {}),
          ...(dto.recipientName !== undefined ? { recipientName: dto.recipientName } : {}),
          ...(dto.recipientMobile !== undefined ? { recipientMobile: canonicalMobile(dto.recipientMobile) } : {}),
          ...(dto.isDefault === true ? { isDefault: true } : {}),
        },
        select: addressSelect,
      });
      await audit(tx, params, AuditAction.UPDATE, addressId, { changedFields });
      return address;
    });
  }

  async remove(userId: string, addressId: string, params: ActorParams): Promise<DeleteAddressResponseDto> {
    return this.prisma.$transaction(async (tx) => {
      await lockUser(tx, userId);
      const current = await tx.address.findFirst({ where: { id: addressId, userId }, select: { id: true, isDefault: true } });
      if (!current) {
        throw new NotFoundException('Address not found');
      }
      await tx.address.delete({ where: { id: addressId } });

      let newDefaultAddressId: string | null = null;
      if (current.isDefault) {
        const next = await tx.address.findFirst({
          where: { userId },
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
          select: { id: true },
        });
        if (next) {
          await tx.address.update({ where: { id: next.id }, data: { isDefault: true } });
          newDefaultAddressId = next.id;
        }
        // The profile FK is ON DELETE SET NULL; re-point it at the promoted address.
        await syncProfileDefault(tx, userId, newDefaultAddressId);
      }
      await audit(tx, params, AuditAction.DELETE, addressId, { wasDefault: current.isDefault, newDefaultAddressId });
      return { id: addressId, deleted: true, newDefaultAddressId };
    });
  }
}

/** Serialises address-book writes of one customer. */
async function lockUser(tx: Tx, userId: string): Promise<void> {
  await tx.$queryRaw(Prisma.sql`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`);
}

async function syncProfileDefault(tx: Tx, userId: string, addressId: string | null): Promise<void> {
  await tx.customerProfile.upsert({
    where: { userId },
    update: { defaultAddressId: addressId },
    create: { userId, defaultAddressId: addressId },
  });
}

function canonicalMobile(input: string): string {
  const e164 = toE164(input);
  if (e164 === null) {
    // The DTO validator already guarantees this; kept as a hard stop for direct callers.
    throw new BadRequestException('recipientMobile must be an Iranian mobile number');
  }
  return e164;
}

async function audit(
  tx: Tx,
  params: ActorParams,
  action: AuditAction,
  entityId: string,
  newValue: Record<string, unknown>,
): Promise<void> {
  await tx.auditLog.create({
    data: {
      userId: params.actorId,
      action,
      entityName: 'Address',
      entityId,
      ipAddress: params.context.ipAddress,
      userAgent: params.context.userAgent,
      newValue: newValue as Prisma.InputJsonValue,
    },
  });
}
