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
const REDUCED_NATIVE_WINDOW_EVENT = 'desktop.native.reduced_window.ready';
const RENDERER_LAYOUT_KEYS = new Set([
  'windowBounds', 'contentBounds', 'minimumSize', 'workArea', 'screen', 'viewport',
  'entry', 'card', 'logo', 'heading', 'connectButton', 'connectDescription',
]);
const REDUCED_NATIVE_WINDOW_LAYOUT_KEYS = new Set([
  'windowBounds', 'minimumSize', 'workArea', 'displayWorkArea',
]);
const RECTANGLE_NUMBER_KEYS = new Set(['x', 'y', 'width', 'height']);
const DIMENSION_NUMBER_KEYS = new Set(['width', 'height']);
const ELEMENT_NUMBER_KEYS = new Set(['top', 'right', 'bottom', 'left', 'width', 'height']);
const LAYOUT_NUMBER_KEYS = new Map<string, ReadonlySet<string>>([
  ['windowBounds', RECTANGLE_NUMBER_KEYS],
  ['contentBounds', RECTANGLE_NUMBER_KEYS],
  ['minimumSize', DIMENSION_NUMBER_KEYS],
  ['workArea', RECTANGLE_NUMBER_KEYS],
  ['displayWorkArea', RECTANGLE_NUMBER_KEYS],
  ['screen', DIMENSION_NUMBER_KEYS],
  ['viewport', DIMENSION_NUMBER_KEYS],
  ['entry', ELEMENT_NUMBER_KEYS],
  ['card', ELEMENT_NUMBER_KEYS],
  ['logo', ELEMENT_NUMBER_KEYS],
  ['heading', ELEMENT_NUMBER_KEYS],
  ['connectButton', ELEMENT_NUMBER_KEYS],
  ['connectDescription', ELEMENT_NUMBER_KEYS],
]);
const WINDOW_BOOLEAN_KEYS = new Set(['visible', 'maximized', 'fullScreen']);

const boundedLayout = (
  event: string,
  value: unknown,
): Record<string, Record<string, number | boolean>> | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  const expectedLayoutKeys = event === LAYOUT_EVENT
    ? RENDERER_LAYOUT_KEYS
    : REDUCED_NATIVE_WINDOW_LAYOUT_KEYS;
  const normalizedEntries: Array<[string, unknown]> = [];
  for (const entry of entries) {
    if (entry[0] !== 'missing') {
      normalizedEntries.push(entry);
      continue;
    }
    if (event !== LAYOUT_EVENT || !Array.isArray(entry[1]) || entry[1].length !== 0) return null;
  }
  if (normalizedEntries.length !== expectedLayoutKeys.size) return null;
  const result: Record<string, Record<string, number | boolean>> = {};
  for (const [name, rawGeometry] of normalizedEntries) {
    if (!expectedLayoutKeys.has(name)
      || !rawGeometry
      || typeof rawGeometry !== 'object'
      || Array.isArray(rawGeometry)) {
      return null;
    }
    const geometry = Object.entries(rawGeometry);
    const expectedNumberKeys = LAYOUT_NUMBER_KEYS.get(name);
    if (!expectedNumberKeys) return null;
    const allowedBooleanKeys = name === 'windowBounds' ? WINDOW_BOOLEAN_KEYS : undefined;
    if (geometry.length < expectedNumberKeys.size
      || geometry.length > expectedNumberKeys.size + (allowedBooleanKeys?.size ?? 0)) return null;
    const safeGeometry: Record<string, number | boolean> = {};
    for (const [key, measurement] of geometry) {
      const validNumber = expectedNumberKeys.has(key)
        && typeof measurement === 'number'
        && Number.isFinite(measurement);
      const validBoolean = allowedBooleanKeys?.has(key) === true && typeof measurement === 'boolean';
      if (!validNumber && !validBoolean) return null;
      safeGeometry[key] = measurement;
    }
    if ([...expectedNumberKeys].some(key => !Object.hasOwn(safeGeometry, key))) return null;
    result[name] = safeGeometry;
  }
  return result;
};

export const sanitizeDesktopLogFields = (
  event: string,
  fields: Record<string, unknown>,
): Record<string, unknown> => Object.fromEntries(Object.entries(fields).map(([key, value]) => {
  if ((event === LAYOUT_EVENT || event === REDUCED_NATIVE_WINDOW_EVENT) && key === 'layout') {
    return [key, boundedLayout(event, value) ?? { code: 'DETAIL_REDACTED' }];
  }
  return [key, safeField(value)];
}));

export const formatDesktopLogRecord = (
  level: LogLevel,
  event: string,
  fields: Record<string, unknown> = {},
  timestamp = new Date().toISOString(),
): string => JSON.stringify({
  timestamp,
  level,
  event,
  ...sanitizeDesktopLogFields(event, fields),
});

export const createDesktopLogger = (
  logPath: string,
  onWriteFailure?: () => void,
): DesktopLogger => {
  let pending = Promise.resolve();
  const log = (level: LogLevel, event: string, fields: Record<string, unknown> = {}) => {
    const record = formatDesktopLogRecord(level, event, fields);
    const consoleMethod = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    consoleMethod(record);
    pending = pending
      .then(async () => {
        await mkdir(dirname(logPath), { recursive: true, mode: 0o700 });
        await appendFile(logPath, `${record}\n`, { encoding: 'utf8', mode: 0o600 });
      })
      .catch(() => {
        try {
          onWriteFailure?.();
        } catch {
          // Keep the fixed logger diagnostic available even if the smoke-only sink also fails.
        }
        console.error(JSON.stringify({ level: 'error', event: 'desktop.log.write_failed', code: 'LOG_WRITE_FAILED' }));
      });
  };
  return { log };
};
