/**
 * MCP results read timestamps from several stores: SQLite `datetime('now')`
 * text without a zone (`2026-11-02 10:12:51`), JavaScript ISO strings, and
 * epoch milliseconds written by `Date.now()`. A client cannot tell the
 * zone-less form is UTC, and has to guess which numbers are instants. This
 * pass runs once at the MCP presentation boundary, so every timestamp in a
 * result is ISO 8601 UTC with `Z`. Stored values and the REST API are not
 * touched, and field names stay as they are.
 *
 * Only fields whose name marks an instant are rewritten, and only when their
 * value has a timestamp shape; anything else (ids, cursors, durations, free
 * text) passes through unchanged.
 */

/** `created_at`, `createdAt`, `nextRunAt`, `lastAt`, `timestamp`, `stateTimestamp`, `start_time`, `startTime`, `since`, `until`. */
const TIMESTAMP_KEY = /(?:_at|[a-z0-9]At|^at|^timestamp|_timestamp|[a-z0-9]Timestamp|_time|[a-z0-9]Time|^since|^until)$/;

/** A date-time with no zone designator; SQLite and naive ISO text are both UTC in ProPR. */
const ZONELESS = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/;
/** A date-time with an explicit UTC offset other than `Z`. */
const OFFSET = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?\s?[+-]\d{2}:?\d{2}$/;
const UTC_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z$/;
/**
 * Epoch milliseconds between 1973 and 5138. Epoch seconds and small durations
 * fall below the range, so they are never mistaken for an instant.
 */
const MIN_EPOCH_MS = 1e11;
const MAX_EPOCH_MS = 1e14;

export function isTimestampKey(key: string): boolean {
  return TIMESTAMP_KEY.test(key);
}

/** The ISO 8601 UTC spelling of one timestamp-shaped value, or the value itself. */
export function normalizeTimestampValue(value: unknown): unknown {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= MIN_EPOCH_MS && value < MAX_EPOCH_MS ? new Date(value).toISOString() : value;
  }
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (UTC_ISO.test(text)) return value;
  let candidate: string | null = null;
  if (ZONELESS.test(text)) candidate = `${text.replace(' ', 'T')}Z`;
  else if (OFFSET.test(text)) candidate = text.replace(' ', 'T').replace(/\s(?=[+-]\d)/, '');
  else if (/^\d{11,14}$/.test(text)) return normalizeTimestampValue(Number(text));
  if (!candidate) return value;
  const milliseconds = new Date(candidate).getTime();
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : value;
}

/** Recursively rewrites timestamp fields of a JSON result; returns a new value, never mutates the input. */
export function normalizeResultTimestamps<T>(value: T): T {
  return normalize(value, false) as T;
}

function normalize(value: unknown, timestampField: boolean): unknown {
  if (Array.isArray(value)) return value.map(item => normalize(item, timestampField));
  if (value && typeof value === 'object') {
    if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : value;
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, normalize(item, isTimestampKey(key))]));
  }
  return timestampField ? normalizeTimestampValue(value) : value;
}
