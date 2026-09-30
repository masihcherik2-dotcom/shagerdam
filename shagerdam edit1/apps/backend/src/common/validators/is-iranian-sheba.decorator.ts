import { registerDecorator, type ValidationArguments, type ValidationOptions } from 'class-validator';
import { formatSheba, isValidSheba, maskSheba, normalizeSheba } from './iranian-sheba';

/**
 * Validates an Iranian IBAN (Sheba) including its ISO 13616 check digits, and
 * exposes the canonical 26-character form through `normalizeShebaValue` so what
 * is stored is always exactly what the banking system expects.
 */
export function IsIranianSheba(options: ValidationOptions = {}): PropertyDecorator {
  return (target: object, propertyName: string | symbol): void => {
    registerDecorator({
      name: 'isIranianSheba',
      target: target.constructor,
      propertyName: String(propertyName),
      constraints: [],
      options: {
        message: (args: ValidationArguments) =>
          `${args.property} must be a valid Iranian IBAN: "IR" followed by 24 digits with a correct check digit`,
        ...options,
      },
      validator: {
        validate: (value: unknown): boolean => typeof value === 'string' && isValidSheba(value),
      },
    });
  };
}

/** Canonical form (`IR` + 24 digits, uppercase, no separators). */
export const normalizeShebaValue = normalizeSheba;

/** Display form grouped in blocks of four. */
export const formatShebaValue = formatSheba;

/** Privacy-preserving form for lists and notifications. */
export const maskShebaValue = maskSheba;
