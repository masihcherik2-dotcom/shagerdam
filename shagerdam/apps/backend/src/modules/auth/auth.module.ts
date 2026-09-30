import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import type { EnvironmentVariables } from '../../config/env.validation';
import type { DurationString } from '../../common/types/duration';
import { AuditModule } from '../audit/audit.module';
import { SmsModule } from '../sms/sms.module';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { OtpService } from './otp.service';
import { TokenService } from './token.service';

/**
 * Authentication module.
 *
 * `JwtModule` is configured asynchronously from the validated environment (never
 * from a literal in the source), and the signing secret used here is only the
 * *access* secret: the refresh token is signed with its own secret inside
 * `TokenService`, so compromising one key never yields the other.
 */
@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvironmentVariables, true>) => ({
        secret: config.getOrThrow<string>('JWT_ACCESS_SECRET'),
        signOptions: {
          expiresIn: config.getOrThrow<DurationString>('JWT_ACCESS_TTL'),
          issuer: 'shopino',
          audience: 'shopino-api',
        },
      }),
    }),
    UsersModule,
    SmsModule,
    AuditModule,
  ],
  controllers: [AuthController],
  providers: [AuthService, OtpService, TokenService],
  exports: [AuthService, TokenService],
})
export class AuthModule {}
