import { registerDecorator, type ValidationArguments, type ValidationOptions } from 'class-validator';
import { IRANIAN_MOBILE_NATIONAL_PATTERN, toE164 } from './iranian-mobile';

/**
 * Accepts every spelling of an Iranian mobile number the public sends
 * (`09XXXXXXXXX`, `+989XXXXXXXXX`, `0098…`, with Persian digits or separators)
 * while guaranteeing the service layer receives the canonical E.164 form.
 *
 * `@Transform` cannot be used alone here because validation must run on the
 * normalized value: a client sending `+98 912 000 0001` has to be accepted, not
 * rejected for whitespace.
 */
export function IsIranianMobile(options: ValidationOptions = {}): PropertyDecorator {
  return (target: object, propertyName: string | symbol): void => {
    registerDecorator({
      name: 'isIranianMobile',
      target: target.constructor,
      propertyName: String(propertyName),
      constraints: [],
      options: {
        message: (args: ValidationArguments) =>
          `${args.property} must be an Iranian mobile number (09XXXXXXXXX or +989XXXXXXXXX)`,
        ...options,
      },
      validator: {
        validate: (value: unknown): boolean => typeof value === 'string' && toE164(value) !== null,
      },
    });
  };
}

/** True when the value is in the national `09XXXXXXXXX` format. */
export function isNationalMobile(value: string): boolean {
  return IRANIAN_MOBILE_NATIONAL_PATTERN.test(value.trim());
}
