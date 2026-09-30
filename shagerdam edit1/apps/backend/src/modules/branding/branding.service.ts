import { BadRequestException, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { AuditAction, ConfigValueType, MediaKind, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type { RequestContext } from '../../common/types/request-context';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { RedisService } from '../../infra/redis/redis.service';
import { sanitize } from '../audit/audit-log.service';
import { BRANDING_PURPOSE } from '../media/branding-image';
import {
  BRANDING_AUDIT_ENTITY,
  BRANDING_CACHE_KEY,
  BRANDING_CACHE_TTL_SECONDS,
  BRANDING_DELAYED_INVALIDATION_MS,
  BRANDING_FIELDS,
  BRANDING_HISTORY_LIMIT,
  BRANDING_KEYS,
  BRANDING_KEY_LIST,
  FIELD_SLOT,
  changedFields,
  isUuid,
  linkUrlProblem,
  serializeField,
  sortBanners,
  toPublicBranding,
  valuesFromRows,
  type BrandingField,
  type BrandingValues,
  type PublicBranding,
  type StoredHeroBanner,
} from './branding-rules';
import type { AdminBrandingDto, BrandingHistoryEntryDto, UpdateBrandingDto } from './dto/branding.dto';

function badRequest(code: string, message: string): BadRequestException {
  return new BadRequestException({ statusCode: 400, error: 'Bad Request', code, message });
}

/**
 * Platform visual identity: logo, mobile logo, favicon and home hero banners,
 * stored in `system_configs` and served publicly through a Redis cache that is
 * purged after every committed change.
 */
@Injectable()
export class BrandingService implements OnModuleDestroy {
  private readonly logger = new Logger(BrandingService.name);
  private readonly timers = new Set<NodeJS.Timeout>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  // ─── Public ───────────────────────────────────────────────────────────────

  /**
   * Cache → DB. Redis is an accelerator: a Redis failure falls through to the
   * database, a DB failure propagates (the storefront has its own fallback).
   */
  async getPublic(): Promise<PublicBranding> {
    const cached = await this.readCache();
    if (cached) {
      return cached;
    }
    const branding = toPublicBranding(await this.loadValues());
    await this.writeCache(branding);
    return branding;
  }

  // ─── Admin ────────────────────────────────────────────────────────────────

  async getAdmin(): Promise<AdminBrandingDto> {
    const rows = await this.prisma.systemConfig.findMany({
      where: { key: { in: BRANDING_KEY_LIST } },
      select: { key: true, value: true, updatedAt: true },
    });
    const values = valuesFromRows(rows, (reason) => this.logger.warn(`Stored branding is partly invalid: ${reason}`));
    const updatedAtByKey = new Map(rows.map((row) => [row.key, row.updatedAt.toISOString()]));

    return {
      logoUrl: values.logoUrl,
      mobileLogoUrl: values.mobileLogoUrl,
      faviconUrl: values.faviconUrl,
      heroBanners: values.heroBanners.map((banner) => ({ ...banner })),
      updatedAt: {
        logoUrl: updatedAtByKey.get(BRANDING_KEYS.logoUrl) ?? null,
        mobileLogoUrl: updatedAtByKey.get(BRANDING_KEYS.mobileLogoUrl) ?? null,
        faviconUrl: updatedAtByKey.get(BRANDING_KEYS.faviconUrl) ?? null,
        heroBanners: updatedAtByKey.get(BRANDING_KEYS.heroBanners) ?? null,
      },
      history: await this.history(),
    };
  }

  /**
   * Validates, writes the changed keys and the audit row in one transaction,
   * then purges the public cache. A no-op PATCH writes nothing.
   */
  async update(dto: UpdateBrandingDto, params: { actorId: string; context: RequestContext }): Promise<AdminBrandingDto> {
    const before = await this.loadValues();
    const after: BrandingValues = {
      logoUrl: dto.logoUrl === undefined ? before.logoUrl : dto.logoUrl,
      mobileLogoUrl: dto.mobileLogoUrl === undefined ? before.mobileLogoUrl : dto.mobileLogoUrl,
      faviconUrl: dto.faviconUrl === undefined ? before.faviconUrl : dto.faviconUrl,
      heroBanners: dto.heroBanners === undefined ? before.heroBanners : this.normalizeBanners(dto.heroBanners),
    };

    const changed = changedFields(before, after);
    if (changed.length === 0) {
      return this.getAdmin();
    }
    await this.assertAssets(after, changed);

    const auditLogId = await this.prisma.$transaction(async (tx) => {
      for (const field of changed) {
        const key = BRANDING_KEYS[field];
        const value = serializeField(field, after);
        await tx.systemConfig.upsert({
          where: { key },
          create: {
            key,
            value,
            valueType: field === 'heroBanners' ? ConfigValueType.JSON : ConfigValueType.STRING,
            description: `Platform branding (${field}) — managed from /admin/branding`,
          },
          update: { value },
        });
      }
      const audit = await tx.auditLog.create({
        data: {
          userId: params.actorId,
          action: AuditAction.UPDATE,
          entityName: BRANDING_AUDIT_ENTITY,
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
    this.logger.log(`Branding updated by ${params.actorId}: ${changed.join(', ')}`);
    return { ...(await this.getAdmin()), auditLogId };
  }

  /**
   * Deletes the public cache entry now, and once more shortly after: a public
   * read that loaded the old rows just before the commit may write them back
   * after the first delete. Best-effort; the TTL bounds any miss.
   */
  async invalidate(): Promise<void> {
    await this.purge();
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      void this.purge();
    }, BRANDING_DELAYED_INVALIDATION_MS);
    timer.unref();
    this.timers.add(timer);
  }

  onModuleDestroy(): void {
    for (const timer of this.timers) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  private async purge(): Promise<void> {
    try {
      await this.redis.client.del(BRANDING_CACHE_KEY);
    } catch (error) {
      this.logger.warn(`Could not purge the branding cache (expires within ${BRANDING_CACHE_TTL_SECONDS}s): ${String(error)}`);
    }
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  private async loadValues(): Promise<BrandingValues> {
    const rows = await this.prisma.systemConfig.findMany({
      where: { key: { in: BRANDING_KEY_LIST } },
      select: { key: true, value: true },
    });
    return valuesFromRows(rows, (reason) => this.logger.warn(`Stored branding is partly invalid: ${reason}`));
  }

  /** Input list → stored list: ids assigned, links checked, order renumbered 1..n. */
  private normalizeBanners(input: NonNullable<UpdateBrandingDto['heroBanners']>): StoredHeroBanner[] {
    const seen = new Set<string>();
    const banners = input.map((banner, index): StoredHeroBanner => {
      const id = banner.id ?? randomUUID();
      if (!isUuid(id)) {
        throw badRequest('BRANDING_INVALID_BANNER', `heroBanners[${index}].id must be a UUID`);
      }
      if (seen.has(id)) {
        throw badRequest('BRANDING_INVALID_BANNER', `heroBanners contains the id ${id} more than once`);
      }
      seen.add(id);

      const title = banner.title?.trim() ? banner.title.trim() : null;
      const linkUrl = banner.linkUrl?.trim() ? banner.linkUrl.trim() : null;
      if (linkUrl !== null) {
        const problem = linkUrlProblem(linkUrl);
        if (problem) {
          throw badRequest('BRANDING_INVALID_LINK', `heroBanners[${index}]: ${problem}`);
        }
      }
      return {
        id,
        imageUrl: banner.imageUrl,
        title,
        linkUrl,
        sortOrder: banner.sortOrder ?? index,
        isActive: banner.isActive ?? true,
      };
    });
    return sortBanners(banners).map((banner, index) => ({ ...banner, sortOrder: index + 1 }));
  }

  /**
   * Every URL being set must be a public image produced by the branding
   * upload endpoint for the matching slot — never an arbitrary external URL
   * (no hot-linking, no tracking pixels, no mixed content, CSP-compatible).
   * Only changed fields are checked so a legacy value cannot block unrelated edits.
   */
  private async assertAssets(values: BrandingValues, changed: BrandingField[]): Promise<void> {
    const wanted: Array<{ url: string; purpose: string; field: string }> = [];
    for (const field of changed) {
      if (field === 'heroBanners') {
        values.heroBanners.forEach((banner, index) =>
          wanted.push({ url: banner.imageUrl, purpose: BRANDING_PURPOSE.hero_banner, field: `heroBanners[${index}].imageUrl` }),
        );
      } else {
        const url = values[field];
        if (url !== null) {
          wanted.push({ url, purpose: BRANDING_PURPOSE[FIELD_SLOT[field]], field });
        }
      }
    }
    if (wanted.length === 0) {
      return;
    }

    const assets = await this.prisma.mediaAsset.findMany({
      where: {
        purpose: { in: [...new Set(wanted.map((entry) => entry.purpose))] },
        url: { in: [...new Set(wanted.map((entry) => entry.url))] },
        kind: MediaKind.IMAGE,
        isPublic: true,
      },
      select: { url: true, purpose: true },
    });
    const known = new Set(assets.map((asset) => `${asset.purpose}\n${asset.url}`));
    for (const entry of wanted) {
      if (!known.has(`${entry.purpose}\n${entry.url}`)) {
        throw badRequest(
          'BRANDING_ASSET_INVALID',
          `${entry.field} must be an image uploaded through POST /admin/branding/assets with the matching slot`,
        );
      }
    }
  }

  private async history(): Promise<BrandingHistoryEntryDto[]> {
    const rows = await this.prisma.auditLog.findMany({
      where: { entityName: BRANDING_AUDIT_ENTITY },
      orderBy: { createdAt: 'desc' },
      take: BRANDING_HISTORY_LIMIT,
      select: {
        id: true,
        createdAt: true,
        newValue: true,
        user: { select: { id: true, fullName: true } },
      },
    });
    return rows.map((row) => ({
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      actor: row.user ? { id: row.user.id, fullName: row.user.fullName } : null,
      changedFields:
        row.newValue !== null && typeof row.newValue === 'object' && !Array.isArray(row.newValue)
          ? Object.keys(row.newValue).filter((key) => (BRANDING_FIELDS as string[]).includes(key))
          : [],
    }));
  }

  private async readCache(): Promise<PublicBranding | null> {
    try {
      const raw = await this.redis.client.get(BRANDING_CACHE_KEY);
      return raw ? (JSON.parse(raw) as PublicBranding) : null;
    } catch (error) {
      this.logger.warn(`Branding cache read failed, using the database: ${String(error)}`);
      return null;
    }
  }

  private async writeCache(branding: PublicBranding): Promise<void> {
    try {
      await this.redis.client.set(BRANDING_CACHE_KEY, JSON.stringify(branding), 'EX', BRANDING_CACHE_TTL_SECONDS);
    } catch (error) {
      this.logger.warn(`Branding cache write failed: ${String(error)}`);
    }
  }
}

function pick(values: BrandingValues, fields: BrandingField[]): Record<string, unknown> {
  return Object.fromEntries(fields.map((field) => [field, values[field]]));
}
