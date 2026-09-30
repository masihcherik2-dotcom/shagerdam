import { Injectable, Logger } from '@nestjs/common';
import { maskMobile } from '../../../common/validators/iranian-mobile';
import {
  SmsDeliveryError,
  type OtpMessage,
  type SmsProvider,
  type SmsProviderKind,
  type SmsSendResult,
  type TransactionalMessage,
} from '../sms-provider.interface';

/** Sends per rolling second; a real gateway would reject faster bursts anyway. */
const MAX_SENDS_PER_SECOND = 5;

/** How many recent messages the sandbox keeps for inspection and tests. */
const DELIVERY_BUFFER_SIZE = 50;

export interface SandboxDelivery {
  mobile: string;
  kind: 'otp' | 'transactional';
  code?: string;
  template?: string;
  params?: Readonly<Record<string, string | number>>;
  referenceId: string;
  dispatchedAt: Date;
}

/**
 * Development/test SMS provider.
 *
 * It performs no network call; it prints the message in a readable form and
 * keeps the most recent dispatches in memory so operators (and the end-to-end
 * tests) can confirm what the user would have received. This is the local
 * equivalent of Mailhog for e-mail — it is **not** a production provider, and the
 * bootstrap refuses to start with it when `NODE_ENV=production`.
 *
 * It still honours the operational contract of a real gateway:
 *  - it rejects already-expired codes (`expiresInSeconds <= 0`);
 *  - it throttles itself to {@link MAX_SENDS_PER_SECOND} to expose flooding bugs
 *    during development instead of hiding them until production.
 */
@Injectable()
export class SandboxSmsProvider implements SmsProvider {
  readonly kind: SmsProviderKind = 'sandbox';
  readonly isTestProvider = true;

  private readonly logger = new Logger('SmsSandbox');
  private readonly deliveries: SandboxDelivery[] = [];
  private windowStartedAt = 0;
  private windowCount = 0;
  private sequence = 0;

  constructor(private readonly logCodes: boolean) {}

  sendOtp(message: OtpMessage): Promise<SmsSendResult> {
    if (message.expiresInSeconds <= 0) {
      throw new SmsDeliveryError(this.kind, 'Refusing to send an already-expired OTP');
    }
    this.assertWithinRate();

    const referenceId = this.nextReference();
    this.remember({
      mobile: message.mobile,
      kind: 'otp',
      code: message.code,
      referenceId,
      dispatchedAt: new Date(),
    });

    if (this.logCodes) {
      this.logger.log(
        `OTP ${message.purpose} → ${maskMobile(message.mobile)}: ${message.code} (valid ${message.expiresInSeconds}s, ref ${referenceId})`,
      );
    } else {
      this.logger.log(`OTP ${message.purpose} → ${maskMobile(message.mobile)} (ref ${referenceId})`);
    }

    return Promise.resolve({ provider: this.kind, referenceId, segments: 1, status: 'sent' });
  }

  sendTransactional(message: TransactionalMessage): Promise<SmsSendResult> {
    this.assertWithinRate();

    const referenceId = this.nextReference();
    this.remember({
      mobile: message.mobile,
      kind: 'transactional',
      template: message.template,
      params: message.params,
      referenceId,
      dispatchedAt: new Date(),
    });

    this.logger.log(
      `SMS ${message.template} → ${maskMobile(message.mobile)} (ref ${referenceId}) ${JSON.stringify(message.params)}`,
    );

    return Promise.resolve({ provider: this.kind, referenceId, segments: 1, status: 'sent' });
  }

  /** Most recent dispatches, newest first. Used by diagnostics and tests. */
  recentDeliveries(limit = 10, mobile?: string): readonly SandboxDelivery[] {
    const filtered = mobile ? this.deliveries.filter((item) => item.mobile === mobile) : this.deliveries;
    return filtered.slice(-limit).reverse();
  }

  /** Latest OTP code that would have been delivered to a mobile number. */
  latestOtpCode(mobile: string): string | undefined {
    return this.recentDeliveries(DELIVERY_BUFFER_SIZE, mobile).find((item) => item.kind === 'otp')?.code;
  }

  private assertWithinRate(): void {
    const now = Date.now();
    if (now - this.windowStartedAt >= 1_000) {
      this.windowStartedAt = now;
      this.windowCount = 0;
    }
    this.windowCount += 1;
    if (this.windowCount > MAX_SENDS_PER_SECOND) {
      throw new SmsDeliveryError(
        this.kind,
        `Sandbox SMS rate limit exceeded (${MAX_SENDS_PER_SECOND}/s). The OTP limiter should have prevented this.`,
      );
    }
  }

  private remember(delivery: SandboxDelivery): void {
    this.deliveries.push(delivery);
    if (this.deliveries.length > DELIVERY_BUFFER_SIZE) {
      this.deliveries.shift();
    }
  }

  private nextReference(): string {
    this.sequence += 1;
    return `SBX-${Date.now().toString(36).toUpperCase()}-${this.sequence}`;
  }
}
