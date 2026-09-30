import { Injectable, Logger } from '@nestjs/common';
import { toNationalFormat } from '../../../common/validators/iranian-mobile';
import {
  SmsDeliveryError,
  type OtpMessage,
  type SmsProvider,
  type SmsProviderKind,
  type SmsSendResult,
  type TransactionalMessage,
} from '../sms-provider.interface';

/** Kavenegar REST base. The API key travels in the path, exactly as documented. */
const KAVENEGAR_BASE_URL = 'https://api.kavenegar.com/v1';

/** Kavenegar address-space of a single request; aborts prevent hanging requests. */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Response shape of `verify/lookup.json` and `sms/send.json`.
 * `return.status` is Kavenegar's own status code (200 = accepted) and is
 * independent of the HTTP status — both must be checked.
 */
interface KavenegarResponse {
  return?: { status?: number; message?: string };
  entries?: Array<{ messageid?: number; status?: number; statustext?: string }>;
}

export interface KavenegarConfig {
  apiKey: string;
  /** Line number the messages are sent from (Kavenegar "sender"). */
  sender: string;
  /** Lookup template configured in the Kavenegar panel for OTP delivery. */
  otpTemplate: string;
}

/**
 * Production SMS provider backed by the Kavenegar HTTP API.
 *
 * Two distinct APIs are used, matching how Kavenegar actually works:
 *
 *  - **OTP** goes through `verify/lookup.json`, which is the pre-approved
 *    template endpoint (fast, cheap, and the only one Iranian operators allow for
 *    login codes).
 *  - **Transactional** messages go through `sms/send.json` with a rendered body.
 *
 * Credentials are read from the environment only; nothing is hardcoded and the
 * API key is never logged. A missing key is a configuration error and fails at
 * bootstrap (see `SmsModule`) rather than at the first login attempt.
 */
@Injectable()
export class KavenegarSmsProvider implements SmsProvider {
  readonly kind: SmsProviderKind = 'kavenegar';
  readonly isTestProvider = false;

  private readonly logger = new Logger(KavenegarSmsProvider.name);

  constructor(private readonly config: KavenegarConfig) {}

  async sendOtp(message: OtpMessage): Promise<SmsSendResult> {
    if (message.expiresInSeconds <= 0) {
      throw new SmsDeliveryError(this.kind, 'Refusing to send an already-expired OTP');
    }

    const response = await this.post('verify/lookup.json', {
      receptor: toNationalFormat(message.mobile),
      token: message.code,
      template: this.config.otpTemplate,
      type: 'sms',
    });

    return this.toResult(response, 1);
  }

  async sendTransactional(message: TransactionalMessage): Promise<SmsSendResult> {
    const body = this.renderBody(message.template, message.params);
    const response = await this.post('sms/send.json', {
      receptor: toNationalFormat(message.mobile),
      sender: this.config.sender,
      message: body,
    });

    // A Persian SMS is sent as UCS-2: 70 characters per part.
    const segments = Math.max(1, Math.ceil(body.length / 70));
    return this.toResult(response, segments);
  }

  private async post(path: string, payload: Record<string, string>): Promise<KavenegarResponse> {
    const url = `${KAVENEGAR_BASE_URL}/${encodeURIComponent(this.config.apiKey)}/${path}`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(payload),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      // Network/DNS/timeout: retryable, reported as a provider failure.
      throw new SmsDeliveryError(this.kind, 'Kavenegar request failed before a response was received', error);
    }

    let parsed: KavenegarResponse;
    try {
      parsed = (await response.json()) as KavenegarResponse;
    } catch {
      throw new SmsDeliveryError(this.kind, `Kavenegar returned a non-JSON response (HTTP ${response.status})`);
    }

    const status = parsed.return?.status;
    const message = parsed.return?.message ?? 'unknown';
    if (!response.ok || (status !== undefined && status !== 200)) {
      throw new SmsDeliveryError(this.kind, `Kavenegar rejected the request: ${message} (status ${status ?? response.status})`);
    }

    this.logger.debug(`Kavenegar accepted ${path} (messages: ${parsed.entries?.length ?? 0})`);
    return parsed;
  }

  private toResult(response: KavenegarResponse, segments: number): SmsSendResult {
    const entry = response.entries?.[0];
    if (!entry?.messageid) {
      throw new SmsDeliveryError(this.kind, 'Kavenegar accepted the request but returned no message id');
    }
    return {
      provider: this.kind,
      referenceId: String(entry.messageid),
      segments,
      status: 'sent',
    };
  }

  /** Substitutes `{placeholder}` tokens; unknown placeholders are left untouched. */
  private renderBody(template: string, params: Readonly<Record<string, string | number>>): string {
    return Object.entries(params).reduce(
      (body, [key, value]) => body.replaceAll(`{${key}}`, String(value)),
      template,
    );
  }
}
