import { Logger } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import { maskEmail } from '../../../common/validators/email';
import { MailDeliveryError, type MailFailureReason, type MailMessage, type MailProvider, type MailProviderKind, type MailSendResult } from '../mail-provider.interface';

export interface SmtpConfig {
  host: string;
  port: number;
  /** Implicit TLS (465). False = plain connection upgraded with STARTTLS (587). */
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
  /**
   * Refuse to send unless STARTTLS succeeds (production with secure=false), so
   * codes and the SMTP password never cross the network in clear text.
   */
  requireTls: boolean;
}

/**
 * Production provider: standard SMTP submission through nodemailer. Works with
 * Gmail (smtp.gmail.com:587 + App Password), Google Workspace, corporate relays
 * and the SMTP endpoints of transactional services. One pooled connection is
 * reused; time-outs keep a hung server from holding the sign-in request.
 */
export class SmtpMailProvider implements MailProvider {
  readonly kind: MailProviderKind = 'smtp';
  readonly isTestProvider = false;

  private readonly logger = new Logger('MailSmtp');
  private readonly transporter: Transporter<SMTPTransport.SentMessageInfo>;

  constructor(private readonly config: SmtpConfig) {
    this.transporter = createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      requireTLS: config.requireTls,
      auth: config.user !== undefined && config.pass !== undefined ? { user: config.user, pass: config.pass } : undefined,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
      tls: { minVersion: 'TLSv1.2', servername: config.host },
    });
  }

  async send(message: MailMessage): Promise<MailSendResult> {
    try {
      const info = await this.transporter.sendMail({
        from: this.config.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
        headers: { 'Auto-Submitted': 'auto-generated', 'X-Auto-Response-Suppress': 'All' },
      });
      if (info.rejected.length > 0) {
        throw new MailDeliveryError(this.kind, 'rejected', `Recipient refused by ${this.config.host}`);
      }
      this.logger.log(`E-mail "${message.subject}" → ${maskEmail(message.to)} (id ${info.messageId})`);
      return { provider: this.kind, messageId: info.messageId, status: 'sent' };
    } catch (error) {
      if (error instanceof MailDeliveryError) throw error;
      throw new MailDeliveryError(this.kind, classify(error), describe(error, this.config.host));
    }
  }

  /** Closes pooled connections (application shutdown). */
  close(): void {
    this.transporter.close();
  }
}

/** nodemailer error codes → our reasons. */
function classify(error: unknown): MailFailureReason {
  const code = (error as { code?: unknown } | null)?.code;
  switch (code) {
    case 'EAUTH':
    case 'ENOAUTH':
      return 'auth';
    case 'ECONNECTION':
    case 'ETIMEDOUT':
    case 'ESOCKET':
    case 'EDNS':
    case 'ETLS':
    case 'EPROTOCOL':
      return 'unavailable';
    case 'EENVELOPE':
    case 'EMESSAGE':
      return 'rejected';
    default:
      return 'unknown';
  }
}

/** Server response without credentials (nodemailer never echoes the password; we still only keep code + response line). */
function describe(error: unknown, host: string): string {
  const details = error as { code?: unknown; responseCode?: unknown; response?: unknown; message?: unknown } | null;
  const parts = [`SMTP ${host}`, typeof details?.code === 'string' ? details.code : 'error'];
  if (typeof details?.responseCode === 'number') parts.push(String(details.responseCode));
  const text = typeof details?.response === 'string' ? details.response : typeof details?.message === 'string' ? details.message : '';
  if (text) parts.push(text.split('\n')[0]!.slice(0, 200));
  return parts.join(' ');
}
