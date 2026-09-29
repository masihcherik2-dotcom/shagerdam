import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { GLOBAL_API_PREFIX, SWAGGER_PATH } from './common/constants';
import type { LogLevelName } from './config/env.validation';
import { resolveLogLevels } from './config/logger.config';
import { applyGlobalPolicies, setupSwagger } from './setup/app.setup';

const REQUEST_BODY_LIMIT_BYTES = 1_048_576;

async function bootstrap(): Promise<void> {
  const adapter = new FastifyAdapter({
    // Set only when the API is deployed behind a reverse proxy/tunnel that
    // terminates TLS; the proxy must overwrite X-Forwarded-* headers itself.
    trustProxy: true,
    bodyLimit: REQUEST_BODY_LIMIT_BYTES,
  });

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter);

  const config = app.get(ConfigService);
  app.useLogger(resolveLogLevels(config.getOrThrow<LogLevelName>('LOG_LEVEL')));
  app.enableShutdownHooks();

  applyGlobalPolicies(app, config);
  setupSwagger(app);

  const port = config.getOrThrow<number>('PORT');
  const host = config.getOrThrow<string>('HOST');

  await app.listen({ port, host });

  Logger.log(
    `Shagerdam API ready on http://${host}:${port}/${GLOBAL_API_PREFIX} — docs: http://${host}:${port}/${SWAGGER_PATH}`,
    'Bootstrap',
  );
}

void bootstrap();
