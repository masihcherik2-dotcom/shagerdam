/**
 * The SMS contract every provider must satisfy.
 *
 * The application layer never talks to a gateway directly: it injects the
 * `SMS_PROVIDER` token and calls these two methods. That is what makes the
 * development (sandbox) and production (real gateway) paths swappable by
 * configuration alone, with no code change and no branch inside business logic.
 */

/** Which provider implementation is running. Mirrors the `SMS_PROVIDER` env value. */
export type SmsProviderKind = 'sandbox' | 'kavenegar';

/** Injection token for the active provider. */
export const SMS_PROVIDER = 'SHOPINO_SMS_PROVIDER';

export interface OtpMessage {
  /** Canonical E.164 mobile number, e.g. `+989120000001`. */
  mobile: string;
  /** The one-time code. Never logged by a production provider. */
  code: string;
  /** Remaining validity of the code in seconds; providers reject `<= 0`. */
  expiresInSeconds: number;
  /** Purpose of the code, e.g. `login` — used for message wording and metrics. */
  purpose: string;
}

export interface TransactionalMessage {
  mobile: string;
  /** Gateway-side template identifier (Kavenegar "lookup" template name). */
  template: string;
  /** Values substituted into the template, e.g. `{ orderNumber: 'SHP-100234' }`. */
  params: Readonly<Record<string, string | number>>;
}

export interface SmsSendResult {
  /** Provider identifier as configured, e.g. `sandbox` or `kavenegar`. */
  provider: SmsProviderKind;
  /** Gateway-side identifier used for delivery reconciliation. */
  referenceId: string;
  /** Number of billable SMS parts. The sandbox always reports 1. */
  segments: number;
  /** Whether the message left the process: sandbox counts as "dispatched". */
  status: 'sent';
}

/**
 * Raised when a provider cannot accept a message. Carries the provider name so
 * the API can map it to a 502/503 without leaking gateway internals.
 */
export class SmsDeliveryError extends Error {
  constructor(
    readonly provider: SmsProviderKind,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'SmsDeliveryError';
  }
}

export interface SmsProvider {
  readonly kind: SmsProviderKind;
  /**
   * `true` for providers that only simulate delivery. Exposed so the API can
   * advertise its capability honestly (`GET /auth/sms-provider`) and so the
   * bootstrap fails loudly when a test provider would run in production.
   */
  readonly isTestProvider: boolean;
  sendOtp(message: OtpMessage): Promise<SmsSendResult>;
  sendTransactional(message: TransactionalMessage): Promise<SmsSendResult>;
}
