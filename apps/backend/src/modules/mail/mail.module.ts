import { Inject, Logger, Module, type OnApplicationShutdown, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NodeEnvironment, resolveMailProvider, type EnvironmentVariables } from '../../config/env.validation';
import { MAIL_PROVIDER, type MailProvider } from './mail-provider.interface';
import { EmailService } from './email.service';
import { SandboxMailProvider } from './providers/sandbox-mail.provider';
import { SmtpMailProvider } from './providers/smtp-mail.provider';

const mailProviderFactory: Provider = {
  provide: MAIL_PROVIDER,
  inject: [ConfigService],
  useFactory: (config: ConfigService<EnvironmentVariables, true>): MailProvider | null => {
    const logger = new Logger('MailModule');
    const nodeEnv = config.getOrThrow<NodeEnvironment>('NODE_ENV');
    const kind = resolveMailProvider({ MAIL_PROVIDER: config.get('MAIL_PROVIDER'), NODE_ENV: nodeEnv });
    const isProduction = nodeEnv === NodeEnvironment.Production;

    if (kind === 'smtp') {
      const host = config.getOrThrow<string>('SMTP_HOST');
      const port = config.getOrThrow<number>('SMTP_PORT');
      const secure = config.getOrThrow<boolean>('SMTP_SECURE');
      logger.log(`Mail provider: smtp (${host}:${port}, ${secure ? 'implicit TLS' : isProduction ? 'STARTTLS required' : 'STARTTLS when offered'})`);
      return new SmtpMailProvider({
        host,
        port,
        secure,
        user: config.get<string>('SMTP_USER'),
        pass: config.get<string>('SMTP_PASS'),
        from: config.getOrThrow<string>('SMTP_FROM'),
        requireTls: isProduction && !secure,
      });
    }
    if (kind === 'sandbox') {
      if (isProduction) {
        throw new Error('MAIL_PROVIDER=sandbox is not allowed in production: it does not deliver e-mail. Set MAIL_PROVIDER=smtp or none.');
      }
      logger.warn('Mail provider: sandbox — e-mails are logged, never delivered. This provider is for development/test only.');
      return new SandboxMailProvider(config.get<boolean>('MAIL_SANDBOX_LOG_CODES') ?? true);
    }
    logger.log('Mail provider: none — sign-in by e-mail is switched off.');
    return null;
  },
};

@Module({
  providers: [mailProviderFactory, EmailService],
  exports: [MAIL_PROVIDER, EmailService],
})
export class MailModule implements OnApplicationShutdown {
  constructor(@Inject(MAIL_PROVIDER) private readonly provider: MailProvider | null) {}

  onApplicationShutdown(): void {
    if (this.provider instanceof SmtpMailProvider) this.provider.close();
  }
}
