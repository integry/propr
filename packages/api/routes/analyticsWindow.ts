/**
 * The optional `period` window shared by the Analytics stats endpoints.
 *
 * Without `period` an endpoint keeps its historical scope, so callers that
 * predate the Analytics timeframe selector see the same payloads as before.
 */

import type { Request, Response } from 'express';
import type { Knex } from 'knex';
import { ANALYTICS_TIMEFRAMES, analyticsTimeframeStart, type AnalyticsTimeframe } from '@propr/shared';
import { validateEnum } from './validation.js';

export interface AnalyticsWindow {
  timeframe: AnalyticsTimeframe;
  /** Inclusive lower bound; null for all time. */
  from: Date | null;
  /** Inclusive upper bound: the moment the request was served. */
  to: Date;
}

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
  query.where(column, '<=', window.to.toISOString());
  return query;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Every UTC day touched by [from, to], ascending, as `YYYY-MM-DD`. */
export function analyticsDayKeys(from: Date, to: Date): string[] {
  const keys: string[] = [];
  const last = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  for (let day = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()); day <= last; day += DAY_MS) {
    keys.push(new Date(day).toISOString().slice(0, 10));
  }
  return keys;
}
