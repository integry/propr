/**
 * The optional `period` window shared by the Analytics stats endpoints.
 *
 * Without `period` an endpoint keeps its historical scope, so callers that
 * predate the Analytics timeframe selector see the same payloads as before.
 */

import type { Request, Response } from 'express';
import type { Knex } from 'knex';
import {
  ANALYTICS_TIMEFRAMES, analyticsTimeframeBucket, analyticsTimeframeStart, type AnalyticsBucket, type AnalyticsTimeframe,
} from '@propr/shared';
import { validateEnum } from './validation.js';

export interface AnalyticsWindow {
  timeframe: AnalyticsTimeframe;
  /** Inclusive lower bound; null for all time. */
  from: Date | null;
  /** Upper bound: the moment the request was served, inclusive unless `toExclusive`. */
  to: Date;
  /**
   * When set, rows at exactly `to` fall outside the window. A previous
   * period ends where the current one starts, so the two meet at one instant
   * with neither a gap nor an overlap.
   */
  toExclusive?: boolean;
}

/** The last instant inside a window, for listing its calendar days. */
export const windowLastInstant = (window: AnalyticsWindow): Date =>
  window.toExclusive ? new Date(window.to.getTime() - 1) : window.to;

/**
 * Reads `period` from the query string.
 *
 * Returns null when no period was requested, and false after answering 400
 * for an unknown one, before the caller has run any query.
 */
export function readAnalyticsWindow(req: Request, res: Response, now: Date): AnalyticsWindow | null | false {
  const validation = validateEnum(req.query.period, ANALYTICS_TIMEFRAMES, 'period');
  if (!validation.valid) {
    res.status(400).json({ error: `period must be one of: ${ANALYTICS_TIMEFRAMES.join(', ')}` });
    return false;
  }
  if (!validation.value) return null;
  return { timeframe: validation.value, from: analyticsTimeframeStart(validation.value, now), to: now };
}

/**
 * Bounds a query to rows whose timestamp column falls inside the window, and
 * leaves it untouched when no period was requested.
 *
 * SQLite stores these columns as ISO text, so the bounds are compared as ISO
 * strings, exactly as the dashboard stats queries do.
 */
export function whereCreatedWithin<T extends Knex.QueryBuilder>(query: T, column: string, window: AnalyticsWindow | null): T {
  if (!window) return query;
  if (window.from) query.where(column, '>=', window.from.toISOString());
  query.where(column, window.toExclusive ? '<' : '<=', window.to.toISOString());
  return query;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * How the activity series over a window is bucketed: by UTC hour for the
 * single-day timeframe, by UTC day otherwise and without a window.
 */
export const analyticsWindowBucket = (window: AnalyticsWindow | null): AnalyticsBucket =>
  window ? analyticsTimeframeBucket(window.timeframe) : 'day';

/**
 * The SQL that keys a timestamp column by bucket, matching the keys
 * `analyticsBucketKeys` lists: `YYYY-MM-DD` for a day, and the ISO instant
 * at the top of the hour (`YYYY-MM-DDTHH:00:00.000Z`) for an hour. SQLite
 * stores these columns as ISO text, which `date` and `strftime` both read.
 */
export const bucketKeySql = (column: string, bucket: AnalyticsBucket): string =>
  bucket === 'hour' ? `strftime('%Y-%m-%dT%H:00:00.000Z', ${column})` : `date(${column})`;

/** Every UTC day touched by [from, to], ascending, as `YYYY-MM-DD`. */
export function analyticsDayKeys(from: Date, to: Date): string[] {
  const keys: string[] = [];
  const last = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  for (let day = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()); day <= last; day += DAY_MS) {
    keys.push(new Date(day).toISOString().slice(0, 10));
  }
  return keys;
}

/** Every UTC hour touched by [from, to], ascending, as the ISO instant at the top of the hour. */
export function analyticsHourKeys(from: Date, to: Date): string[] {
  const keys: string[] = [];
  const last = Math.floor(to.getTime() / HOUR_MS) * HOUR_MS;
  for (let hour = Math.floor(from.getTime() / HOUR_MS) * HOUR_MS; hour <= last; hour += HOUR_MS) {
    keys.push(new Date(hour).toISOString());
  }
  return keys;
}

/** Every bucket touched by [from, to], ascending, keyed as `bucketKeySql` keys them. */
export const analyticsBucketKeys = (from: Date, to: Date, bucket: AnalyticsBucket): string[] =>
  bucket === 'hour' ? analyticsHourKeys(from, to) : analyticsDayKeys(from, to);

/** The first instant of a bucket, from its key. */
export const bucketStart = (key: string): Date => new Date(key.includes('T') ? key : `${key}T00:00:00.000Z`);
