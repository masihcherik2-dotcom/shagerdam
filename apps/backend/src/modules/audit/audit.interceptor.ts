import {
  Injectable,
  Logger,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuditAction } from '@prisma/client';
import { Observable, concatMap, from, map } from 'rxjs';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { errorMessage } from '../../common/utils';
import { AUDIT_METADATA_KEY, SKIP_AUDIT_KEY, type AuditableOptions } from './audit.decorator';
import { readAuditContext } from './audit-context';
import { AuditLogService, sanitize } from './audit-log.service';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

interface AuditableRequest {
  method: string;
  url: string;
  body?: unknown;
  params?: Record<string, unknown>;
  user?: AuthenticatedUser;
  ip?: string;
  headers?: Record<string, string | string[] | undefined>;
}

/**
 * Records every non-GET mutating request in `audit_logs`.
 *
 * Design decisions:
 *
 * - The row is written **after** the handler succeeded, so a rejected request
 *   leaves no trail of something that never happened. Authentication outcomes
 *   (LOGIN / failed LOGIN) are recorded explicitly by `AuthService`, which knows
 *   the difference between "wrong password" and "no such user".
 * - Reads are not recorded — a storefront page load is not an event worth keeping
 *   for years — **unless** the route declares `@Auditable` explicitly. Some reads
 *   are events: streaming a KYC document is access to somebody's identity papers,
 *   and "who looked at whose passport" is precisely what a compliance trail is
 *   for. An explicit decorator therefore overrides the read-method default, while
 *   `@SkipAudit()` still wins over everything.
 * - `newValue` combines the request body with the handler's response, both
 *   passed through `sanitize()`, so secrets never reach the table.
 * - `oldValue` comes from the handler via `setAuditSnapshot()` when the handler
 *   already loaded the previous state; otherwise it stays `NULL` rather than
 *   being invented.
 * - Auditing never fails the request: `AuditLogService.record()` swallows and
 *   logs write errors.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly auditLog: AuditLogService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler<unknown>): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest<AuditableRequest>();
    const method = request.method?.toUpperCase() ?? 'GET';

    // `@SkipAudit()` and `@Auditable()` are both read before the read-method rule,
    // because the rule has an exception (see below).
    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_AUDIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skip === true) {
      return next.handle();
    }

    const declared = this.reflector.getAllAndOverride<AuditableOptions>(AUDIT_METADATA_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const options = declared ?? {};

    // A declared `@Auditable` is the route author asking for a row even on a read;
    // an undeclared read is skipped. Without the decorator the method stands.
    if (READ_METHODS.has(method) && declared === undefined) {
      return next.handle();
    }

    // The audit row is written **before** the response is emitted. Awaiting one
    // INSERT costs a little latency, and it buys the property that a mutation
    // reported as successful is always in the trail — a fire-and-forget write
    // could be lost if the process died between response and flush.
    return next.handle().pipe(
      concatMap((response: unknown) =>
        from(this.write(context, request, options, response)).pipe(map((): unknown => response)),
      ),
    );
  }

  private async write(
    context: ExecutionContext,
    request: AuditableRequest,
    options: AuditableOptions,
    response: unknown,
  ): Promise<void> {
    try {
      const snapshot = readAuditContext(request);
      const headers = request.headers ?? {};
      const forwarded = headers['x-forwarded-for'];
      const forwardedValue = Array.isArray(forwarded) ? forwarded[0] : forwarded;
      const userAgentHeader = headers['user-agent'];
      const userAgent = Array.isArray(userAgentHeader) ? userAgentHeader[0] : userAgentHeader;

      const entityId =
        snapshot.entityId ??
        (options.entityIdParam ? asId(request.params?.[options.entityIdParam]) : undefined) ??
        asId(request.params?.id) ??
        asId(readProperty(response, 'id'));

      await this.auditLog.record({
        userId: request.user?.id ?? snapshot.actorId ?? null,
        action: options.action ?? deriveAction(request.method),
        entityName: options.entityName ?? deriveEntityName(context, request.url),
        entityId: entityId ?? null,
        ipAddress: forwardedValue?.split(',')[0]?.trim() || request.ip || null,
        userAgent: userAgent ?? null,
        oldValue: snapshot.oldValue,
        // A write records what was sent; a declared read records what was asked
        // for (the route parameters), because a GET has no body to keep.
        newValue: {
          ...(READ_METHODS.has(request.method.toUpperCase())
            ? { params: sanitize(request.params ?? {}) }
            : { request: sanitize(request.body) }),
          ...(snapshot.newValue !== undefined ? { result: sanitize(snapshot.newValue) } : {}),
        },
      });
    } catch (error) {
      this.logger.error(`Audit interceptor failed: ${errorMessage(error)}`);
    }
  }
}

/** Maps an HTTP method to the audit vocabulary. */
export function deriveAction(method: string): AuditAction {
  switch (method.toUpperCase()) {
    case 'POST':
      return AuditAction.CREATE;
    case 'PATCH':
    case 'PUT':
      return AuditAction.UPDATE;
    case 'DELETE':
      return AuditAction.DELETE;
    default:
      return AuditAction.UPDATE;
  }
}

/** Last static path segment, e.g. `/api/v1/auth/profile` → `profile`. */
export function deriveEntityName(context: ExecutionContext, url: string): string {
  const path = url.split('?')[0] ?? '';
  const segments = path
    .split('/')
    .filter((segment) => segment.length > 0 && !segment.startsWith(':') && !isUuid(segment));
  const last = segments.at(-1);
  if (last === undefined) {
    return context.getHandler().name;
  }
  return last;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function asId(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0 && value.length <= 64) {
    return value;
  }
  if (typeof value === 'number') {
    return String(value);
  }
  return undefined;
}

function readProperty(source: unknown, key: string): unknown {
  if (typeof source === 'object' && source !== null && key in source) {
    return (source as Record<string, unknown>)[key];
  }
  return undefined;
}
