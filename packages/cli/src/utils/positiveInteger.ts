/**
 * Parses a CLI option that must be a positive integer.
 */
export function parsePositiveInteger(value: string, optionName: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${optionName} must be a positive integer.`);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${optionName} must be a positive integer.`);
  }

  return parsed;
}
