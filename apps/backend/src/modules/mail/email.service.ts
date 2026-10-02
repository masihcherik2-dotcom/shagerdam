import { HttpException, HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { maskEmail } from '../../common/validators/email';
import { MAIL_PROVIDER, MailDeliveryError, type MailProvider, type MailSendResult } from './mail-provider.interface';
import { renderOtpEmail } from './templates/otp-email.template';

/**
 * Sends the platform's e-mails through the provider selected by MAIL_PROVIDER.
 * `enabled` is false with MAIL_PROVIDER=none; callers check it before offering
 * anything that depends on e-mail.
 */
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  constructor(@Inject(MAIL_PROVIDER) private readonly provider: MailProvider | null) {}

  get enabled(): boolean {
    return this.provider !== null;
  }

  describe(): { enabled: boolean; provider: string; isTestProvider: boolean } {
    return { enabled: this.enabled, provider: this.provider?.kind ?? 'none', isTestProvider: this.provider?.isTestProvider ?? false };
  }

  /**
   * Delivers a sign-in code. Failures become 502 `EMAIL_DELIVERY_FAILED` (or
   * 503 `EMAIL_NOT_CONFIGURED`); the SMTP detail is logged, never returned.
   */
  async sendOtp(to: string, code: string, expiresInSeconds: number, purpose: string): Promise<MailSendResult> {
    if (this.provider === null) {
      throw emailError(HttpStatus.SERVICE_UNAVAILABLE, 'EMAIL_NOT_CONFIGURED', 'Sign-in by e-mail is not enabled on this server.');
    }
    try {
      return await this.provider.send(renderOtpEmail({ to, code, expiresInSeconds }));
    } catch (error) {
      const detail = error instanceof MailDeliveryError ? `${error.reason}: ${error.message}` : 'unknown provider error';
      this.logger.error(`E-mail ${purpose} code to ${maskEmail(to)} failed via ${this.provider.kind} — ${detail}`);
      throw emailError(HttpStatus.BAD_GATEWAY, 'EMAIL_DELIVERY_FAILED', 'The e-mail could not be sent right now. Try again in a moment or sign in with your mobile.');
    }
  }
}

export function emailError(status: HttpStatus, code: string, message: string): HttpException {
  const reasons: Partial<Record<HttpStatus, string>> = {
    [HttpStatus.BAD_REQUEST]: 'Bad Request',
    [HttpStatus.UNAUTHORIZED]: 'Unauthorized',
    [HttpStatus.FORBIDDEN]: 'Forbidden',
    [HttpStatus.CONFLICT]: 'Conflict',
    [HttpStatus.BAD_GATEWAY]: 'Bad Gateway',
    [HttpStatus.SERVICE_UNAVAILABLE]: 'Service Unavailable',
  };
  return new HttpException({ statusCode: status, error: reasons[status] ?? 'Error', code, message }, status);
}
