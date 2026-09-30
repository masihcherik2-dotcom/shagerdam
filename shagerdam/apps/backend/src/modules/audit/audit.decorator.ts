import { SetMetadata } from '@nestjs/common';
import type { AuditAction } from '@prisma/client';

export const AUDIT_METADATA_KEY = 'shopino:audit';
export const SKIP_AUDIT_KEY = 'shopino:skipAudit';

export interface AuditableOptions {
  /**
   * Entity name recorded in `audit_logs.entity_name`. When omitted, the
   * interceptor derives it from the route path (last static segment).
   */
  entityName?: string;
  /**
   * Overrides the action derived from the HTTP method. Use for the actions that
   * are not plain CRUD, e.g. a purchase capturing a payment
   * (`AuditAction.PAYMENT_CAPTURE`) or a settlement transition
   * (`AuditAction.STATUS_CHANGE`).
   */
  action?: AuditAction;
  /** Name of the route parameter that holds the entity id (defaults to `id`). */
  entityIdParam?: string;
}

/**
 * Attaches audit metadata to a mutating route. The actual row is written by
 * `AuditInterceptor` from the *result* of the handler, so the trail records what
 * really happened rather than what was requested.
 */
export const Auditable = (options: AuditableOptions = {}): MethodDecorator & ClassDecorator =>
  SetMetadata(AUDIT_METADATA_KEY, options);

/** Opts a mutating route out of the audit trail (e.g. telemetry beacons). */
export const SkipAudit = (): MethodDecorator & ClassDecorator => SetMetadata(SKIP_AUDIT_KEY, true);
