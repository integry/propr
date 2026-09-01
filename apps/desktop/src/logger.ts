import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface DesktopLogger {
  log(level: LogLevel, event: string, fields?: Record<string, unknown>): void;
}

const serializeError = (value: unknown): unknown => value instanceof Error
  ? { name: value.name, message: value.message, stack: value.stack }
  : value;

export const createDesktopLogger = (
  logPath: string,
  onWriteFailure?: () => void,
): DesktopLogger => {
  let pending = Promise.resolve();
  const log = (level: LogLevel, event: string, fields: Record<string, unknown> = {}) => {
    const record = JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      event,
      ...Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, serializeError(value)])),
    });
    const consoleMethod = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    consoleMethod(record);
    pending = pending
      .then(async () => {
        await mkdir(dirname(logPath), { recursive: true, mode: 0o700 });
        await appendFile(logPath, `${record}\n`, { encoding: 'utf8', mode: 0o600 });
      })
      .catch(error => {
        try {
          onWriteFailure?.();
        } catch {
          // Keep the fixed logger diagnostic available even if the smoke-only sink also fails.
        }
        console.error(JSON.stringify({ level: 'error', event: 'desktop.log.write_failed', error: serializeError(error) }));
      });
  };
  return { log };
};
