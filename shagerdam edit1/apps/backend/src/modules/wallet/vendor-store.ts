import { ForbiddenException } from '@nestjs/common';
import type { VendorStatus } from '@prisma/client';
import type { PrismaService } from '../../infra/prisma/prisma.service';

export interface VendorStore {
  id: string;
  status: VendorStatus;
  bankIban: string | null;
  bankAccountHolder: string | null;
}

/** The caller's store; 403 when the VENDOR account has no store (registration not started). */
export async function requireStore(prisma: PrismaService, userId: string): Promise<VendorStore> {
  const store = await prisma.vendor.findUnique({
    where: { userId },
    select: { id: true, status: true, bankIban: true, bankAccountHolder: true },
  });
  if (!store) {
    throw new ForbiddenException('This account has no store');
  }
  return store;
}
