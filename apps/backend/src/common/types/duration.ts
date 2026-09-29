/**
 * Duration shorthand understood by `@nestjs/jwt` / `ms`, e.g. `30s`, `15m`, `12h`, `7d`.
 *
 * The environment validator already enforces this shape with a regex, but a
 * validated `string` is still just a `string` to TypeScript. Declaring the narrow
 * type here lets the JWT module receive it without a cast at every call site, and
 * documents the contract in one place.
 */
export type DurationString = `${number}${'s' | 'm' | 'h' | 'd'}`;
