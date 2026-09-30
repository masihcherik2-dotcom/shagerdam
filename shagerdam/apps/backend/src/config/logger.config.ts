import type { LogLevel } from '@nestjs/common';
import { LOG_LEVELS, type LogLevelName } from './env.validation';

/**
 * Expands a single `LOG_LEVEL` into the Nest logger levels it implies:
 * `warn` enables error+warn, `debug` enables error+warn+log+debug, and so on.
 */
export function resolveLogLevels(level: LogLevelName): LogLevel[] {
  const threshold = LOG_LEVELS.indexOf(level);
  if (threshold === -1) {
    throw new Error(`Unsupported log level: ${level}`);
  }
  return [...LOG_LEVELS.slice(0, threshold + 1)];
}
