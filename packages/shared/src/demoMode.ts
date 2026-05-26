export const DEMO_MODE_READ_ONLY_CODE = 'DEMO_MODE_READ_ONLY';

export function parseTruthyEnvValue(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === 'true' || normalized === '1';
}
