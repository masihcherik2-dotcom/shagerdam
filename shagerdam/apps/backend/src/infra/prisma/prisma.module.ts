import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/**
 * Global infrastructure module: every feature module may inject `PrismaService`
 * without re-importing this module.
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
