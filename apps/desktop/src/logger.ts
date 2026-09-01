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

const LAYOUT_EVENT = 'desktop.renderer.layout.ready';
const LAYOUT_KEYS = new Set([
  'windowBounds', 'workArea', 'viewport', 'entry', 'card', 'logo', 'heading',
  'connectButton', 'connectDescription',
]);
const LAYOUT_NUMBER_KEYS = new Set([
  'x', 'y', 'width', 'height', 'top', 'right', 'bottom', 'left',
]);
const LAYOUT_BOOLEAN_KEYS = new Set(['visible', 'maximized', 'fullScreen']);

const boundedLayout = (value: unknown): Record<string, Record<string, number | boolean>> | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.length > LAYOUT_KEYS.size) return null;
  const result: Record<string, Record<string, number | boolean>> = {};
  for (const [name, rawGeometry] of entries) {
    if (!LAYOUT_KEYS.has(name) || !rawGeometry || typeof rawGeometry !== 'object' || Array.isArray(rawGeometry)) {
      return null;
    }
    const geometry = Object.entries(rawGeometry);
    if (geometry.length === 0 || geometry.length > LAYOUT_NUMBER_KEYS.size + LAYOUT_BOOLEAN_KEYS.size) return null;
    const safeGeometry: Record<string, number | boolean> = {};
    for (const [key, measurement] of geometry) {
      const validNumber = LAYOUT_NUMBER_KEYS.has(key)
        && typeof measurement === 'number'
        && Number.isFinite(measurement);
      const validBoolean = LAYOUT_BOOLEAN_KEYS.has(key) && typeof measurement === 'boolean';
      if (!validNumber && !validBoolean) return null;
      safeGeometry[key] = measurement;
    }
    result[name] = safeGeometry;
  }
  return result;
};

export const sanitizeDesktopLogFields = (
  event: string,
  fields: Record<string, unknown>,
): Record<string, unknown> => Object.fromEntries(Object.entries(fields).map(([key, value]) => {
  if (event === LAYOUT_EVENT && key === 'layout') {
    return [key, boundedLayout(value) ?? { code: 'DETAIL_REDACTED' }];
  }
  return [key, safeField(value)];
}));

export const createDesktopLogger = (logPath: string): DesktopLogger => {
  let pending = Promise.resolve();
  const log = (level: LogLevel, event: string, fields: Record<string, unknown> = {}) => {
    const record = JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      event,
      ...sanitizeDesktopLogFields(event, fields),
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
