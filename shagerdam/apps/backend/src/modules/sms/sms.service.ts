import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import type { OtpMessage, TransactionalMessage } from './sms-provider.interface';
import { SMS_PROVIDER, SmsDeliveryError, type SmsProvider, type SmsSendResult } from './sms-provider.interface';

/**
 * Thin application-facing facade over the active SMS provider.
 *
 * Its whole job is to (a) keep business code free of any provider detail and
 * (b) translate provider failures into an HTTP-meaningful error. A gateway
 * outage is not the client's fault, so it surfaces as `503 Service Unavailable`
 * rather than `400`, and the OTP itself stays valid in Redis so the user can
 * retry once the gateway recovers.
 */
@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);

  constructor(@Inject(SMS_PROVIDER) private readonly provider: SmsProvider) {}

  get providerKind(): SmsProvider['kind'] {
    return this.provider.kind;
  }

  /** Honest capability report; surfaced by `GET /auth/sms-provider`. */
  describe(): { provider: string; isTestProvider: boolean } {
    return { provider: this.provider.kind, isTestProvider: this.provider.isTestProvider };
  }

  async sendOtp(mobile: string, code: string, expiresInSeconds: number, purpose: string): Promise<SmsSendResult> {
    const message: OtpMessage = { mobile, code, expiresInSeconds, purpose };
    try {
      return await this.provider.sendOtp(message);
    } catch (error) {
      throw this.toHttpError(error, 'OTP delivery');
    }
  }

  async sendTransactional(
    mobile: string,
    template: string,
    params: Readonly<Record<string, string | number>>,
  ): Promise<SmsSendResult> {
    const message: TransactionalMessage = { mobile, template, params };
    try {
      return await this.provider.sendTransactional(message);
    } catch (error) {
      throw this.toHttpError(error, 'SMS delivery');
    }
  }

  private toHttpError(error: unknown, stage: string): ServiceUnavailableException {
    const detail = error instanceof SmsDeliveryError ? error.message : 'unknown provider error';
    this.logger.error(`${stage} failed via ${this.provider.kind}: ${detail}`);
    return new ServiceUnavailableException(
      `${stage} is temporarily unavailable (provider: ${this.provider.kind}). Please retry shortly.`,
    );
  }
}
