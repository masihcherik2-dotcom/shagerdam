/**
 * Outgoing e-mail behind one interface. Business code (sign-in codes today)
 * talks to {@link EmailService}; which provider actually delivers is chosen
 * once at boot from `MAIL_PROVIDER` by `MailModule`.
 */
export type MailProviderKind = 'sandbox' | 'smtp';

/** DI token of the active provider; `null` when MAIL_PROVIDER=none. */
export const MAIL_PROVIDER = 'SHOPINO_MAIL_PROVIDER';

export interface MailMessage {
  /** Single recipient address (already validated and lower-cased). */
  to: string;
  subject: string;
  /** Plain-text body: shown by clients that do not render HTML. */
  text: string;
  html: string;
}

export interface MailSendResult {
  provider: MailProviderKind;
  /** Provider message id (SMTP `Message-ID`, or the sandbox reference). */
  messageId: string;
  status: 'sent';
}

/** Why a delivery failed — logged, never shown verbatim to the user. */
export type MailFailureReason = 'auth' | 'unavailable' | 'rejected' | 'unknown';

export class MailDeliveryError extends Error {
  constructor(
    readonly provider: MailProviderKind,
    readonly reason: MailFailureReason,
    message: string,
  ) {
    super(message);
    this.name = 'MailDeliveryError';
  }
}

export interface MailProvider {
  readonly kind: MailProviderKind;
  /** True for providers that never deliver (sandbox). */
  readonly isTestProvider: boolean;
  send(message: MailMessage): Promise<MailSendResult>;
}
