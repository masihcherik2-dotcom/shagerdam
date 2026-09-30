import { Injectable, Logger } from '@nestjs/common';
import { DisputeEventType } from '@prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { SmsService } from '../sms/sms.service';

/** Transactional SMS sent to the customer when a dispute is decided in their favour. `{key}` placeholders are filled by the provider. */
export const DISPUTE_REFUND_TEMPLATE =
  'شاگردم: اختلاف مرسولهٔ {subOrderNumber} به نفع شما حل شد. مبلغ {amount} ریال به شما بازگردانده می‌شود.';

export interface RefundNotice {
  disputeId: string;
  mobile: string;
  subOrderNumber: string;
  amount: string;
}

/**
 * Refund notice of a buyer-favour decision. Runs **after** the decision has
 * committed: an SMS outage must never roll back a financial resolution. The
 * outcome (sent with the provider reference, or failed) is appended to the
 * dispute timeline so staff can see who still has to be told.
 */
@Injectable()
export class DisputeNotifier {
  private readonly logger = new Logger(DisputeNotifier.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sms: SmsService,
  ) {}

  async refundNotice(notice: RefundNotice): Promise<void> {
    try {
      const sent = await this.sms.sendTransactional(notice.mobile, DISPUTE_REFUND_TEMPLATE, {
        subOrderNumber: notice.subOrderNumber,
        amount: notice.amount,
      });
      await this.record(notice.disputeId, DisputeEventType.REFUND_NOTICE_SENT, 'Refund notice sent by SMS', {
        provider: sent.provider,
        referenceId: sent.referenceId,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'unknown error';
      this.logger.error(`Refund notice for dispute ${notice.disputeId} failed: ${detail}`);
      await this.record(notice.disputeId, DisputeEventType.REFUND_NOTICE_FAILED, 'Refund notice could not be sent; contact the customer', {
        error: detail.slice(0, 300),
      }).catch((recordError: unknown) => {
        this.logger.error(`Could not record the failed refund notice of dispute ${notice.disputeId}: ${String(recordError)}`);
      });
    }
  }

  private async record(disputeId: string, type: DisputeEventType, note: string, data: Record<string, string>): Promise<void> {
    await this.prisma.disputeEvent.create({ data: { disputeId, type, actorRole: 'SYSTEM', note, data } });
  }
}
