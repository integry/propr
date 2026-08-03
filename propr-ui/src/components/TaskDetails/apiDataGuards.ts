import type { AnalysisData, LogFilesData } from './types';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isOptionalString = (value: unknown): value is string | undefined =>
  value === undefined || typeof value === 'string';

export function isLogFilesData(value: unknown): value is LogFilesData {
  if (!isRecord(value)) return false;
  if (!isOptionalString(value.sessionId) || !isOptionalString(value.error)) return false;
  if (value.files !== undefined) {
    if (!isRecord(value.files) || !Object.values(value.files).every(path => typeof path === 'string')) return false;
  }
  if (value.logFiles !== undefined) {
    if (!Array.isArray(value.logFiles) || !value.logFiles.every(file =>
      isRecord(file)
      && typeof file.name === 'string'
      && typeof file.path === 'string'
      && typeof file.size === 'number'
      && Number.isFinite(file.size)
      && typeof file.type === 'string'
    )) return false;
  }
  return true;
}

export function isAnalysisData(value: unknown): value is AnalysisData {
  if (!isRecord(value)) return false;
  return ['report', 'analysis', 'content', 'error'].every(key => isOptionalString(value[key]));
}
