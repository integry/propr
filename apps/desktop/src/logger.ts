import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface DesktopLogger {
  log(level: LogLevel, event: string, fields?: Record<string, unknown>): void;
}

const safeField = (value: unknown): unknown => {
  if (value instanceof Error) return { code: 'OPERATION_FAILED' };
  if (typeof value === 'string') return value.length <= 128 ? value : value.slice(0, 128);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  return { code: 'DETAIL_REDACTED' };
};

export const createDesktopLogger = (logPath: string): DesktopLogger => {
  let pending = Promise.resolve();
  const log = (level: LogLevel, event: string, fields: Record<string, unknown> = {}) => {
    const record = JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      event,
      ...Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, safeField(value)])),
    });
    const consoleMethod = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    consoleMethod(record);
    pending = pending
      .then(async () => {
        await mkdir(dirname(logPath), { recursive: true, mode: 0o700 });
        await appendFile(logPath, `${record}\n`, { encoding: 'utf8', mode: 0o600 });
      })
      .catch(() => console.error(JSON.stringify({ level: 'error', event: 'desktop.log.write_failed', code: 'LOG_WRITE_FAILED' })));
  };
  return { log };
};
