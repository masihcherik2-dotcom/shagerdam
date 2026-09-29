import { Injectable, Logger } from '@nestjs/common';
import { AuditAction, Prisma } from '@prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { errorMessage } from '../../common/utils';

/** Fields that must never reach the audit trail in clear text. */
const REDACTED_KEYS = new Set([
  'password',
  'currentpassword',
  'newpassword',
  'passwordhash',
  'otp',
  'code',
  'token',
  'accesstoken',
  'refreshtoken',
  'authorization',
  'secret',
  'apikey',
]);

const REDACTION_PLACEHOLDER = '[REDACTED]';
const MAX_JSON_DEPTH = 6;
const MAX_ARRAY_ITEMS = 50;
const MAX_STRING_LENGTH = 2_000;

export interface AuditEntryInput {
  /** Actor; `null` for anonymous events such as a failed login attempt. */
  userId?: string | null;
  action: AuditAction;
  entityName: string;
  entityId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  oldValue?: unknown;
  newValue?: unknown;
}

export interface AuditLogQuery {
  userId?: string;
  entityName?: string;
  entityId?: string;
  action?: AuditAction;
  from?: Date;
  to?: Date;
  page: number;
  pageSize: number;
}

/**
 * Writes and reads the platform audit trail.
 *
 * Two deliberate properties:
 *
 * 1. `record()` never throws. Auditing must not be able to fail a business
 *    operation — but it must not silently disappear either, so failures are
 *    logged at error level with the payload that could not be stored.
 * 2. Everything written is redacted and depth/length bounded, because audit rows
 *    are readable by admins and must not become a place where passwords, OTP
 *    codes or tokens leak.
 */
@Injectable()
export class AuditLogService {
  private readonly logger = new Logger(AuditLogService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Persists one audit row. Returns the row id, or `null` when writing failed. */
  async record(entry: AuditEntryInput): Promise<string | null> {
    try {
      const row = await this.prisma.auditLog.create({
        data: {
          userId: entry.userId ?? null,
          action: entry.action,
          entityName: entry.entityName,
          entityId: entry.entityId ?? null,
          ipAddress: entry.ipAddress?.slice(0, 45) ?? null,
          userAgent: entry.userAgent?.slice(0, 512) ?? null,
          oldValue: this.toJson(entry.oldValue),
          newValue: this.toJson(entry.newValue),
        },
        select: { id: true },
      });
      return row.id;
    } catch (error) {
      this.logger.error(
        `Failed to write audit row (${entry.action} ${entry.entityName}): ${errorMessage(error)}`,
      );
      return null;
    }
  }

  /** Paginated, filterable read used by the admin audit-log endpoint. */
  async list(query: AuditLogQuery): Promise<{ rows: AuditLogRow[]; total: number }> {
    const where: Prisma.AuditLogWhereInput = {
      ...(query.userId ? { userId: query.userId } : {}),
      ...(query.entityName ? { entityName: query.entityName } : {}),
      ...(query.entityId ? { entityId: query.entityId } : {}),
      ...(query.action ? { action: query.action } : {}),
      ...(query.from || query.to
        ? { createdAt: { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lte: query.to } : {}) } }
        : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: {
          id: true,
          userId: true,
          action: true,
          entityName: true,
          entityId: true,
          ipAddress: true,
          userAgent: true,
          oldValue: true,
          newValue: true,
          createdAt: true,
        },
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return {
      rows: rows.map((row) => ({
        ...row,
        createdAt: row.createdAt,
        actorMobile: null,
      })),
      total,
    };
  }

  /**
   * Redacts secrets and bounds the payload. Returns `undefined` for empty input
   * so the column stays NULL instead of storing an empty object.
   */
  private toJson(value: unknown): Prisma.InputJsonValue | undefined {
    if (value === undefined || value === null) {
      return undefined;
    }
    const sanitized = sanitize(value, 0);
    return sanitized === undefined ? undefined : (sanitized as Prisma.InputJsonValue);
  }
}

export interface AuditLogRow {
  id: string;
  userId: string | null;
  action: AuditAction;
  entityName: string;
  entityId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  oldValue: Prisma.JsonValue;
  newValue: Prisma.JsonValue;
  createdAt: Date;
  actorMobile: string | null;
}

/**
 * Recursively redacts secret-bearing keys and bounds the size of the stored
 * document so a large request body cannot bloat the audit table.
 */
export function sanitize(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== 'object') {
    return typeof value === 'string' ? value.slice(0, MAX_STRING_LENGTH) : value;
  }
  if (depth >= MAX_JSON_DEPTH) {
    return '[TRUNCATED]';
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitize(item, depth + 1));
  }
  if (value instanceof Date) {
    return value.toISOString();
  }

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    result[key] = REDACTED_KEYS.has(key.toLowerCase()) ? REDACTION_PLACEHOLDER : sanitize(item, depth + 1);
  }
  return result;
}
