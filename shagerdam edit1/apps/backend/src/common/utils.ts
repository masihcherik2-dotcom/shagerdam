/** Converts a `process.hrtime.bigint()` difference into fractional milliseconds. */
export function toMilliseconds(nanoseconds: bigint): number {
  return Number((Number(nanoseconds) / 1_000_000).toFixed(2));
}

/** Extracts a readable message from an unknown thrown value. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === 'string' ? error : 'Unknown error';
}
