import { Logger } from '@nestjs/common';
import { maskEmail } from '../../../common/validators/email';
import { type MailMessage, type MailProvider, type MailProviderKind, type MailSendResult } from '../mail-provider.interface';

const BUFFER_SIZE = 50;

export interface SandboxMail {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Sign-in code carried by the message, when it is one. */
  code?: string;
  messageId: string;
  dispatchedAt: Date;
}

/**
 * DEVELOPMENT/TEST ONLY. Nothing leaves the process: messages are kept in a
 * small in-memory buffer (read by the e2e tests) and, with
 * MAIL_SANDBOX_LOG_CODES=true, the sign-in code is printed to the log so a
 * developer can finish the flow. `MailModule` and the environment validation
 * both refuse it in production.
 */
export class SandboxMailProvider implements MailProvider {
  readonly kind: MailProviderKind = 'sandbox';
  readonly isTestProvider = true;

  private readonly logger = new Logger('MailSandbox');
  private readonly sent: SandboxMail[] = [];
  private sequence = 0;

  constructor(private readonly logCodes: boolean) {}

  send(message: MailMessage): Promise<MailSendResult> {
    // No throttling here: abuse limits (cooldown, hourly caps per address and IP,
    // lockout) are enforced by OtpService before any provider is called.
    const now = Date.now();
    this.sequence += 1;
    const messageId = `MAIL-SBX-${now.toString(36).toUpperCase()}-${this.sequence}`;
    const code = /\b(\d{4,8})\b/.exec(message.text)?.[1];
    this.sent.push({ ...message, code, messageId, dispatchedAt: new Date(now) });
    if (this.sent.length > BUFFER_SIZE) this.sent.shift();

    const codePart = this.logCodes && code !== undefined ? `: ${code}` : '';
    this.logger.log(`E-mail "${message.subject}" → ${maskEmail(message.to)}${codePart} (ref ${messageId})`);
    return Promise.resolve({ provider: this.kind, messageId, status: 'sent' });
  }

  /** Newest first. */
  recent(limit = 10, to?: string): readonly SandboxMail[] {
    const filtered = to === undefined ? this.sent : this.sent.filter((mail) => mail.to === to);
    return filtered.slice(-limit).reverse();
  }

  latestCode(to: string): string | undefined {
    return this.recent(BUFFER_SIZE, to).find((mail) => mail.code !== undefined)?.code;
  }
}
