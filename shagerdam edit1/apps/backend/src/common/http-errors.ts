import { BadRequestException, ConflictException } from '@nestjs/common';

/**
 * Errors that a client must be able to act on programmatically (show "only 2
 * left", re-render changed prices) carry a stable `code` and structured details
 * next to the usual `statusCode` / `error` / `message` fields Nest produces.
 */
export function conflictWith(code: string, message: string, details: Record<string, unknown> = {}): ConflictException {
  return new ConflictException({ statusCode: 409, error: 'Conflict', code, message, ...details });
}

export function badRequestWith(code: string, message: string, details: Record<string, unknown> = {}): BadRequestException {
  return new BadRequestException({ statusCode: 400, error: 'Bad Request', code, message, ...details });
}
