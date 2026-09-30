import { BadRequestException, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { AuditAction, ConfigValueType, Prisma } from '@prisma/client';
import type { RequestContext } from '../../common/types/request-context';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { RedisService } from '../../infra/redis/redis.service';
import { sanitize } from '../audit/audit-log.service';
import type { AdminSiteInfoDto, SiteInfoHistoryEntryDto, UpdateSiteInfoDto } from './dto/site-info.dto';
import {
  changedFields,
  fieldProblem,
  normalizeField,
  SITE_INFO_AUDIT_ENTITY,
  SITE_INFO_CACHE_KEY,
  SITE_INFO_CACHE_TTL_SECONDS,
  SITE_INFO_DELAYED_INVALIDATION_MS,
  SITE_INFO_FIELDS,
  SITE_INFO_KEY_LIST,
  SITE_INFO_KEYS,
  toPublicSiteInfo,
  valuesFromRows,
  type SiteInfoField,
  type SiteInfoValues,
} from './site-info-rules';

const HISTORY_LIMIT = 20;

/**
 * Business identity (legal name, national ID, contact details, trust seals)
 * stored in `system_configs`, served publicly through a Redis cache that is
 * purged after every committed change. Same storage and cache discipline as
 * `BrandingService`.
 */
@Injectable()
export class SiteInfoService implements OnModuleDestroy {
  private readonly logger = new Logger(SiteInfoService.name);
  private readonly timers = new Set<NodeJS.Timeout>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async getPublic(): Promise<SiteInfoValues> {
    const cached = await this.readCache();
    if (cached) return cached;
    const info = toPublicSiteInfo(await this.loadValues());
    await this.writeCache(info);
    return info;
  }

  async getAdmin(): Promise<AdminSiteInfoDto> {
    const rows = await this.prisma.systemConfig.findMany({ where: { key: { in: SITE_INFO_KEY_LIST } }, select: { key: true, value: true, updatedAt: true } });
    const values = valuesFromRows(rows, (reason) => this.logger.warn(`Stored site info is partly invalid: ${reason}`));
    const updatedAtByKey = new Map(rows.map((row) => [row.key, row.updatedAt.toISOString()]));
    return {
      ...values,
      updatedAt: Object.fromEntries(SITE_INFO_FIELDS.map((field) => [field, updatedAtByKey.get(SITE_INFO_KEYS[field]) ?? null])),
      history: await this.history(),
    };
  }

  /** Validates every provided field, writes the changed keys and the audit row in one transaction, then purges the cache. */
  async update(dto: UpdateSiteInfoDto, params: { actorId: string; context: RequestContext }): Promise<AdminSiteInfoDto> {
    const before = await this.loadValues();
    const after: SiteInfoValues = { ...before };
    for (const field of SITE_INFO_FIELDS) {
      const raw = dto[field];
      if (raw === undefined) continue;
      const value = raw === null ? '' : normalizeField(field, raw);
      if (value === '') {
        after[field] = null;
        continue;
      }
      const problem = fieldProblem(field, value);
      if (problem) {
        throw new BadRequestException({ statusCode: 400, error: 'Bad Request', code: 'SITE_INFO_INVALID_FIELD', field, message: problem });
      }
      after[field] = value;
    }

    const changed = changedFields(before, after);
    if (changed.length === 0) return this.getAdmin();

    const auditLogId = await this.prisma.$transaction(async (tx) => {
      for (const field of changed) {
        const key = SITE_INFO_KEYS[field];
        const value = after[field] ?? '';
        await tx.systemConfig.upsert({
          where: { key },
          create: { key, value, valueType: ConfigValueType.STRING, description: `Business identity (${field}) — managed from /admin/site-info` },
          update: { value },
        });
      }
      const audit = await tx.auditLog.create({
        data: {
          userId: params.actorId,
          action: AuditAction.UPDATE,
          entityName: SITE_INFO_AUDIT_ENTITY,
          entityId: null,
          ipAddress: params.context.ipAddress,
          userAgent: params.context.userAgent,
          oldValue: sanitize(pick(before, changed)) as Prisma.InputJsonValue,
          newValue: sanitize(pick(after, changed)) as Prisma.InputJsonValue,
        },
        select: { id: true },
      });
      return audit.id;
    });

    await this.invalidate();
    this.logger.log(`Site info updated by ${params.actorId}: ${changed.join(', ')}`);
    return { ...(await this.getAdmin()), auditLogId };
  }

  /** Purges now and once more shortly after (a read racing the commit may write the old value back). */
  async invalidate(): Promise<void> {
    await this.purge();
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      void this.purge();
    }, SITE_INFO_DELAYED_INVALIDATION_MS);
    timer.unref();
    this.timers.add(timer);
  }

  onModuleDestroy(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  private async purge(): Promise<void> {
    try {
      await this.redis.client.del(SITE_INFO_CACHE_KEY);
    } catch (error) {
      this.logger.warn(`Could not purge the site info cache (expires within ${SITE_INFO_CACHE_TTL_SECONDS}s): ${String(error)}`);
    }
  }

  private async loadValues(): Promise<SiteInfoValues> {
    const rows = await this.prisma.systemConfig.findMany({ where: { key: { in: SITE_INFO_KEY_LIST } }, select: { key: true, value: true } });
    return valuesFromRows(rows, (reason) => this.logger.warn(`Stored site info is partly invalid: ${reason}`));
  }

  private async history(): Promise<SiteInfoHistoryEntryDto[]> {
    const rows = await this.prisma.auditLog.findMany({
      where: { entityName: SITE_INFO_AUDIT_ENTITY },
      orderBy: { createdAt: 'desc' },
      take: HISTORY_LIMIT,
      select: { id: true, createdAt: true, newValue: true, user: { select: { id: true, fullName: true } } },
    });
    return rows.map((row) => ({
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      actor: row.user ? { id: row.user.id, fullName: row.user.fullName } : null,
      changedFields:
        row.newValue !== null && typeof row.newValue === 'object' && !Array.isArray(row.newValue)
          ? Object.keys(row.newValue).filter((key) => (SITE_INFO_FIELDS as string[]).includes(key))
          : [],
    }));
  }

  private async readCache(): Promise<SiteInfoValues | null> {
    try {
      const raw = await this.redis.client.get(SITE_INFO_CACHE_KEY);
      return raw ? (JSON.parse(raw) as SiteInfoValues) : null;
    } catch (error) {
      this.logger.warn(`Site info cache read failed, using the database: ${String(error)}`);
      return null;
    }
  }

  private async writeCache(info: SiteInfoValues): Promise<void> {
    try {
      await this.redis.client.set(SITE_INFO_CACHE_KEY, JSON.stringify(info), 'EX', SITE_INFO_CACHE_TTL_SECONDS);
    } catch (error) {
      this.logger.warn(`Site info cache write failed: ${String(error)}`);
    }
  }
}

function pick(values: SiteInfoValues, fields: SiteInfoField[]): Record<string, unknown> {
  return Object.fromEntries(fields.map((field) => [field, values[field]]));
}
