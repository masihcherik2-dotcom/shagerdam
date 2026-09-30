import { Logger, Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NodeEnvironment, type EnvironmentVariables } from '../../config/env.validation';
import { KavenegarSmsProvider, type KavenegarConfig } from './providers/kavenegar-sms.provider';
import { SandboxSmsProvider } from './providers/sandbox-sms.provider';
import { SMS_PROVIDER, type SmsProvider, type SmsProviderKind } from './sms-provider.interface';
import { SmsService } from './sms.service';

/**
 * Chooses the SMS provider from configuration at boot.
 *
 * The selection is resolved **once**, inside the Nest DI container, so the rest
 * of the application depends on the `SmsProvider` contract and can never branch
 * on the environment. Swapping `SMS_PROVIDER=sandbox` for
 * `SMS_PROVIDER=kavenegar` (plus credentials) changes the provider with no code
 * change and no redeploy-specific build.
 *
 * Misconfiguration fails here, at startup, not at the first login attempt:
 *  - `kavenegar` without an API key/sender/template is rejected by the
 *    environment validator before this factory runs;
 *  - a test provider in production is refused by both the validator and the
 *    factory below (defence in depth).
 */
const smsProviderFactory: Provider = {
  provide: SMS_PROVIDER,
  inject: [ConfigService],
  useFactory: (config: ConfigService<EnvironmentVariables, true>): SmsProvider => {
    const logger = new Logger('SmsModule');
    const kind = config.getOrThrow<SmsProviderKind>('SMS_PROVIDER');
    const isProduction = config.getOrThrow<NodeEnvironment>('NODE_ENV') === NodeEnvironment.Production;

    if (kind === 'kavenegar') {
      const kavenegarConfig: KavenegarConfig = {
        apiKey: config.getOrThrow<string>('SMS_KAVENEGAR_API_KEY'),
        sender: config.getOrThrow<string>('SMS_KAVENEGAR_SENDER'),
        otpTemplate: config.getOrThrow<string>('SMS_KAVENEGAR_OTP_TEMPLATE'),
      };
      logger.log('SMS provider: kavenegar (live gateway)');
      return new KavenegarSmsProvider(kavenegarConfig);
    }

    if (isProduction) {
      throw new Error(
        'SMS_PROVIDER=sandbox is not allowed in production: it does not deliver messages. ' +
          'Set SMS_PROVIDER=kavenegar with real credentials.',
      );
    }

    logger.warn(
      'SMS provider: sandbox — OTP codes are printed to the log and never delivered. ' +
        'This provider is for development/test only.',
    );
    return new SandboxSmsProvider(config.get<boolean>('SMS_SANDBOX_LOG_CODES') ?? true);
  },
};

@Module({
  providers: [smsProviderFactory, SmsService],
  exports: [SMS_PROVIDER, SmsService],
})
export class SmsModule {}
