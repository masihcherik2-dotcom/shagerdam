import { ValidateIf, type ValidationOptions } from 'class-validator';

/**
 * "Absent is fine, `null` is not" — the missing middle ground in class-validator.
 *
 * `@IsOptional()` skips every remaining validator when the value is `null` **or**
 * `undefined`, so `{"businessLicenseUrl": null}` would be stored as if the field
 * had been omitted, even though the contract documents a string. This decorator
 * only skips when the property is absent; an explicit `null` is then rejected by
 * whatever validators follow it.
 *
 * Use it for optional request fields where `null` is not a legal value. Fields
 * whose type is genuinely nullable (e.g. `rejectionReason: string | null`) should
 * use `@IsOptional()` together with an explicit `@IsIn([null])` style check.
 */
export function IsOptionalNonNullable(options: ValidationOptions = {}): PropertyDecorator {
  return (target: object, propertyName: string | symbol): void => {
    ValidateIf((_object: unknown, value: unknown): boolean => value !== undefined, options)(
      target,
      propertyName,
    );
  };
}
