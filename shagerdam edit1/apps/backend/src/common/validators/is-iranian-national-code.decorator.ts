import { registerDecorator, type ValidationArguments, type ValidationOptions } from 'class-validator';
import { isValidNationalCode, normalizeNationalCode } from './iranian-national-code';

/**
 * Validates an Iranian national code, including its check digit.
 *
 * The stored value is always the normalized ten-digit form, so a client sending
 * Persian digits or spaces (`۰۴۹-۹۳۷۰۸۹۹`) is accepted and normalized rather than
 * rejected on formatting.
 */
export function IsIranianNationalCode(options: ValidationOptions = {}): PropertyDecorator {
  return (target: object, propertyName: string | symbol): void => {
    registerDecorator({
      name: 'isIranianNationalCode',
      target: target.constructor,
      propertyName: String(propertyName),
      constraints: [],
      options: {
        message: (args: ValidationArguments) =>
          `${args.property} must be a valid Iranian national code (10 digits with a valid check digit)`,
        ...options,
      },
      validator: {
        validate: (value: unknown): boolean => typeof value === 'string' && isValidNationalCode(value),
      },
    });
  };
}

/** Transforms any accepted spelling into the canonical ten-digit form. */
export const normalizeNationalCodeValue = normalizeNationalCode;
