import { BadGatewayException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AuditAction, CreditApplicationStatus, MediaKind, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { TooManyRequestsException } from '../../common/exceptions/too-many-requests.exception';
import { badRequestWith, conflictWith } from '../../common/http-errors';
import { normalizeNationalCode } from '../../common/validators/iranian-national-code';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { RedisService } from '../../infra/redis/redis.service';
import { writeOrderAudit, type OrderActor } from '../orders/order-audit';
import { CreditLedgerService } from './credit-ledger.service';
import { accountSelect, applicationSelect, outstandingByAccount, providerSummary, toAccountDto, toApplicationDto } from './credit-views';
import type { CreateCreditApplicationDto, CreditAccountDto, CreditApplicationDto, CreditPlansResponseDto } from './dto/credit.dto';
import { INSTALLMENT_INTERVAL_DAYS } from './installment-math';
import { CreditProviderError, type ApplicationDecision, type ApplicationDocument, type EligibilityResult } from './providers/credit-provider.interface';
import { CreditProviderRegistry } from './providers/credit-provider.registry';

/** Credit applications one customer may submit per rolling day (each one is a bank inquiry). */
export const MAX_APPLICATIONS_PER_DAY = 5;
const DAY_SECONDS = 24 * 60 * 60;
const APPLY_LOCK_MS = 60_000;

export const creditApplyCountKey = (userId: string): string => `credit:apply:count:${userId}`;
export const creditApplyLockKey = (userId: string): string => `credit:apply:lock:${userId}`;

/**
 * Customer side of the credit engine: applying for a credit line, reading it,
 * and the instalment plans on offer.
 *
 * Application flow (TM brief §1): validate → provider eligibility inquiry →
 * provider application → one transaction that records the CreditApplication and,
 * when approved, opens the CreditAccount with its CREDIT_ALLOCATION ledger row
 * (and saves the verified national code to the profile). Provider calls run
 * outside the transaction under a per-customer Redis lock, so parallel
 * submissions cannot race; the (user, provider) unique key backs it up.
 */
@Injectable()
export class CreditService {
  private readonly logger = new Logger(CreditService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly registry: CreditProviderRegistry,
    private readonly ledger: CreditLedgerService,
  ) {}

  async apply(userId: string, dto: CreateCreditApplicationDto, actor: OrderActor): Promise<CreditApplicationDto> {
    await this.registry.assertEnabled();
    await this.consumeDailyQuota(userId);
    const lockToken = randomUUID();
    const locked = await this.redis.client.set(creditApplyLockKey(userId), lockToken, 'PX', APPLY_LOCK_MS, 'NX');
    if (locked !== 'OK') {
      throw conflictWith('CREDIT_APPLICATION_IN_PROGRESS', 'Another credit application of yours is being processed');
    }
    try {
      return await this.applyLocked(userId, dto, actor);
    } finally {
      const holder = await this.redis.client.get(creditApplyLockKey(userId));
      if (holder === lockToken) await this.redis.client.del(creditApplyLockKey(userId));
    }
  }

  private async applyLocked(userId: string, dto: CreateCreditApplicationDto, actor: OrderActor): Promise<CreditApplicationDto> {
    const provider = await this.registry.requireActiveProvider();
    if (provider.code !== dto.providerCode) {
      throw conflictWith('CREDIT_PROVIDER_NOT_ACTIVE', `Credit provider ${dto.providerCode} is not available; apply with the active provider`, {
        activeProvider: provider.code,
      });
    }
    const adapter = this.registry.adapterFor(provider);
    const nationalCode = normalizeNationalCode(dto.nationalCode);
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { mobile: true, nationalCode: true } });
    if (user.nationalCode !== null && user.nationalCode !== nationalCode) {
      throw conflictWith('NATIONAL_CODE_MISMATCH', 'The national code differs from the one on your profile');
    }
    if (user.nationalCode === null) {
      const owner = await this.prisma.user.findUnique({ where: { nationalCode }, select: { id: true } });
      if (owner && owner.id !== userId) {
        throw conflictWith('NATIONAL_CODE_IN_USE', 'This national code belongs to another account');
      }
    }
    const existing = await this.prisma.creditAccount.findUnique({ where: { userId_providerId: { userId, providerId: provider.id } }, select: { id: true, status: true } });
    if (existing) {
      throw conflictWith('CREDIT_ACCOUNT_EXISTS', 'You already have a credit account with this provider', { accountId: existing.id, accountStatus: existing.status });
    }
    const docs = await this.resolveDocuments(userId, dto.documentIds ?? []);
    const requestedLimit = new Prisma.Decimal(dto.requestedLimit);

    let eligibility: EligibilityResult;
    let decision: ApplicationDecision | null = null;
    try {
      eligibility = await adapter.inquireEligibility(nationalCode, user.mobile);
      if (eligibility.eligible) {
        decision = await adapter.submitApplication(userId, requestedLimit, docs);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = error instanceof CreditProviderError ? error.code : 'PROVIDER_ERROR';
      this.logger.warn(`Credit provider ${provider.code} failed for user ${userId}: ${message}`);
      throw new BadGatewayException({ statusCode: 502, error: 'Bad Gateway', code: 'CREDIT_PROVIDER_UNAVAILABLE', message: 'The credit provider did not answer; try again later', providerCode: code });
    }

    const approvedLimit = decision?.status === 'APPROVED' && decision.approvedLimit?.greaterThan(0) && decision.approvedLimit.isInteger() ? decision.approvedLimit : null;
    const status: CreditApplicationStatus =
      approvedLimit !== null
        ? CreditApplicationStatus.APPROVED
        : decision?.status === 'DOCS_REQUIRED'
          ? CreditApplicationStatus.DOCS_REQUIRED
          : CreditApplicationStatus.REJECTED;
    const decisionReason = eligibility.eligible ? (decision?.reason ?? null) : (eligibility.reason ?? 'NOT_ELIGIBLE');
    const bankScoreResponse = {
      inquiry: { ref: eligibility.inquiryRef, eligible: eligibility.eligible, score: eligibility.score, reason: eligibility.reason, details: eligibility.details },
      ...(decision
        ? { decision: { status: decision.status, trackingCode: decision.trackingCode, approvedLimit: decision.approvedLimit?.toFixed(2) ?? null, reason: decision.reason, details: decision.details } }
        : {}),
    };

    try {
      const applicationId = await this.prisma.$transaction(async (tx) => {
        const application = await tx.creditApplication.create({
          data: {
            userId,
            providerId: provider.id,
            requestedLimit,
            approvedLimit,
            status,
            bankApplicationTrackingCode: decision?.trackingCode ?? null,
            bankScoreResponse: bankScoreResponse as Prisma.InputJsonValue,
            decisionReason,
            decidedAt: status === CreditApplicationStatus.DOCS_REQUIRED ? null : new Date(),
          },
          select: { id: true },
        });
        let accountId: string | null = null;
        if (approvedLimit !== null) {
          accountId = await this.ledger.openAccount(tx, { userId, providerId: provider.id, limit: approvedLimit, applicationId: application.id, expiresAt: null });
          if (user.nationalCode === null) {
            await tx.user.update({ where: { id: userId }, data: { nationalCode } });
          }
        }
        await writeOrderAudit(tx, actor, {
          action: AuditAction.CREDIT_DECISION,
          entityName: 'CreditApplication',
          entityId: application.id,
          newValue: {
            status,
            providerCode: provider.code,
            requestedLimit: requestedLimit.toFixed(2),
            approvedLimit: approvedLimit?.toFixed(2) ?? null,
            score: eligibility.score,
            decisionReason,
            trackingCode: decision?.trackingCode ?? null,
            ...(accountId ? { creditAccountId: accountId } : {}),
          },
        });
        return application.id;
      });
      return await this.applicationDto(applicationId);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        // A concurrent request recorded first (unique account per provider / unique national code).
        const rawTarget: unknown = error.meta?.['target'];
        const target = Array.isArray(rawTarget) ? rawTarget.map(String).join(',') : typeof rawTarget === 'string' ? rawTarget : '';
        throw target.includes('national_code')
          ? conflictWith('NATIONAL_CODE_IN_USE', 'This national code belongs to another account')
          : conflictWith('CREDIT_ACCOUNT_EXISTS', 'You already have a credit account with this provider');
      }
      throw error;
    }
  }

  /** The customer's credit line at the active provider (or, if none, their most recent one). */
  async account(userId: string): Promise<CreditAccountDto> {
    const active = await this.registry.findActiveProvider();
    const row =
      (active ? await this.prisma.creditAccount.findUnique({ where: { userId_providerId: { userId, providerId: active.id } }, select: accountSelect }) : null) ??
      (await this.prisma.creditAccount.findFirst({ where: { userId }, select: accountSelect, orderBy: { createdAt: 'desc' } }));
    if (!row) {
      throw new NotFoundException({ statusCode: 404, error: 'Not Found', code: 'CREDIT_ACCOUNT_NOT_FOUND', message: 'You have no credit account; apply first' });
    }
    return toAccountDto(row, await outstandingByAccount(this.prisma, [row.id]));
  }

  /** Active instalment plans of the active provider; empty when credit is disabled or the provider has no integration. */
  async plans(): Promise<CreditPlansResponseDto> {
    const creditEnabled = await this.registry.isEnabled();
    const provider = await this.registry.findActiveProvider();
    if (!provider) {
      return { creditEnabled, provider: null, items: [] };
    }
    const summary = providerSummary(provider);
    if (!creditEnabled || !this.registry.isImplemented(provider.code)) {
      return { creditEnabled, provider: summary, items: [] };
    }
    this.registry.adapterFor(provider); // 503 when the provider's configuration is invalid
    const plans = await this.prisma.installmentPlan.findMany({
      where: { providerId: provider.id, isActive: true },
      select: { id: true, title: true, durationMonths: true, interestRatePercent: true, penaltyRatePercentPerMonth: true },
      orderBy: { durationMonths: 'asc' },
    });
    return {
      creditEnabled,
      provider: summary,
      items: plans.map((plan) => ({
        id: plan.id,
        title: plan.title,
        durationMonths: plan.durationMonths,
        interestRatePercent: plan.interestRatePercent.toFixed(2),
        penaltyRatePercentPerMonth: plan.penaltyRatePercentPerMonth.toFixed(2),
        installmentIntervalDays: INSTALLMENT_INTERVAL_DAYS,
      })),
    };
  }

  private async applicationDto(applicationId: string): Promise<CreditApplicationDto> {
    const row = await this.prisma.creditApplication.findUniqueOrThrow({ where: { id: applicationId }, select: applicationSelect });
    let account: CreditAccountDto | null = null;
    if (row.status === CreditApplicationStatus.APPROVED) {
      const accountRow = await this.prisma.creditAccount.findUnique({ where: { userId_providerId: { userId: row.userId, providerId: row.providerId } }, select: accountSelect });
      if (accountRow) account = toAccountDto(accountRow, await outstandingByAccount(this.prisma, [accountRow.id]));
    }
    return toApplicationDto(row, account);
  }

  private async resolveDocuments(userId: string, documentIds: readonly string[]): Promise<ApplicationDocument[]> {
    const unique = [...new Set(documentIds)];
    if (unique.length === 0) return [];
    const assets = await this.prisma.mediaAsset.findMany({
      where: { id: { in: unique }, ownerUserId: userId, kind: MediaKind.DOCUMENT },
      select: { id: true, mimeType: true, sizeBytes: true },
    });
    if (assets.length !== unique.length) {
      throw badRequestWith('INVALID_DOCUMENTS', 'Every document must be a document you uploaded');
    }
    return assets.map((asset) => ({ mediaAssetId: asset.id, mimeType: asset.mimeType, sizeBytes: asset.sizeBytes }));
  }

  private async consumeDailyQuota(userId: string): Promise<void> {
    const key = creditApplyCountKey(userId);
    const count = await this.redis.client.incr(key);
    if (count === 1) await this.redis.client.expire(key, DAY_SECONDS);
    if (count > MAX_APPLICATIONS_PER_DAY) {
      const ttl = await this.redis.client.ttl(key);
      throw new TooManyRequestsException('Too many credit applications; try again later', ttl > 0 ? ttl : DAY_SECONDS);
    }
  }
}
