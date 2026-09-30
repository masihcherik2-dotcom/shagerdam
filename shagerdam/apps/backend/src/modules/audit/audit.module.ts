import { Module } from '@nestjs/common';
import { AuditLogService } from './audit-log.service';
import { AuditInterceptor } from './audit.interceptor';
import { AuditController } from './audit.controller';

/**
 * Audit module.
 *
 * `AuditInterceptor` is exported so it can be registered as the single global
 * interceptor in `AppModule`, and `AuditLogService` is exported because
 * authentication records its own outcome rows (LOGIN / failed LOGIN), which a
 * generic HTTP interceptor cannot infer.
 */
@Module({
  controllers: [AuditController],
  providers: [AuditLogService, AuditInterceptor],
  exports: [AuditLogService, AuditInterceptor],
})
export class AuditModule {}
