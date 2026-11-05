import type { LogFilesData } from './types';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isOptionalNullableString = (value: unknown): value is string | null | undefined =>
  value === undefined || value === null || typeof value === 'string';

export function isLogFilesData(value: unknown): value is LogFilesData {
  if (!isRecord(value)) return false;
  if (!isOptionalNullableString(value.sessionId) || !isOptionalNullableString(value.error)) return false;
  if (value.files !== undefined && value.files !== null) {
    if (!isRecord(value.files) || !Object.values(value.files).every(path => typeof path === 'string')) return false;
  }
  if (value.logFiles !== undefined && value.logFiles !== null) {
    if (!Array.isArray(value.logFiles) || !value.logFiles.every(file =>
      isRecord(file)
      && typeof file.name === 'string'
      && typeof file.path === 'string'
      && typeof file.size === 'number'
      && Number.isFinite(file.size)
      && typeof file.type === 'string'
    )) return false;
  }
  const hasLogFiles = Array.isArray(value.logFiles);
  const hasError = typeof value.error === 'string' && value.error.trim().length > 0;
  const hasSessionId = typeof value.sessionId === 'string'
    && value.sessionId.trim().length > 0
  const hasLegacyFiles = hasSessionId && isRecord(value.files);
  if (isRecord(value.files) && !hasSessionId) return false;
  return hasLogFiles || hasError || hasLegacyFiles;
}
