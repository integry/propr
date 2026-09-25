/**
 * Recorded completions — the dashboard's second source of truth.
 *
 * The "Completed" feed lists runs that finished successfully, newest first.
 * Completions are recorded events, so they are read from task history rather
 * than from a task's current state: a run that completed and is now being
 * followed up still completed.
 *
 * Failures are not listed here: an unresolved failure is something a person
 * has to act on, so it belongs in the attention list. Cancellations and jobs
 * that were skipped or rescheduled are bookkeeping, not results, and appear in
 * neither.
 */

import type { Knex } from 'knex';
import {
  chunk,
  mapTaskRow,
  TASK_COLUMNS,
  terminalTransitionQuery,
  type DashboardTaskRow,
  type RawTaskRow,
} from './dashboardQueries.js';

export interface CompletedRow extends DashboardTaskRow {
  /**
   * What the run actually produced, from the recap recorded on its completion,
   * or null when the only thing recorded is that it finished.
   */
  recap: string | null;
  /** Review score out of 10; only reviews carry one, and only when recorded. */
  reviewScore: number | null;
}

/** Rows scanned for a title search before the title itself is matched. */
const MAX_SEARCH_SCAN = 1000;

/**
 * A completion recorded for a job that decided there was nothing to do. It is
 * stored as `completed` so the run is not retried, but nothing was produced.
 */
const SKIPPED_REASON_PATTERN = 'PR comment job skipped%';

/** Recaps that only restate that the run finished, which the feed already says. */
const GENERIC_RECAPS = new Set([
  'completed the pull request follow-up.',
]);

/** `Score 8/10` or `Scores 8/10, 6/10`, as written by the review recap. */
const REVIEW_SCORE_PART = /^Scores?\s+(.+)$/i;

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function recapFrom(metadata: Record<string, unknown>): string | null {
  const direct = metadata.notificationRecap;
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  const prResult = parseJsonObject(metadata.prResult).notificationRecap;
  return typeof prResult === 'string' && prResult.trim() ? prResult.trim() : null;
}

interface CompletionDetails {
  recap: string | null;
  commandMode: string | null;
}

/**
 * The newest recap and command mode recorded on each task's completions.
 *
 * A task can record more than one completion ("implementation completed",
 * then "PR ready"), and the recap is not always on the newest one, so every
 * completion of the listed tasks is read and the newest that says something
 * wins.
 */
async function loadCompletionDetails(db: Knex, taskIds: readonly string[]): Promise<Map<string, CompletionDetails>> {
  const details = new Map<string, CompletionDetails>();
  for (const batch of chunk(taskIds)) {
    const rows = await db('task_history')
      .whereIn('task_id', batch)
      .where('state', 'completed')
      .select('task_id', 'metadata')
      .orderBy('timestamp', 'desc') as Array<Record<string, unknown>>;
    for (const row of rows) {
      const taskId = String(row.task_id);
      const metadata = parseJsonObject(row.metadata);
      const current = details.get(taskId) ?? { recap: null, commandMode: null };
      const commandMode = typeof metadata.commandMode === 'string' ? metadata.commandMode : null;
      details.set(taskId, {
        recap: current.recap ?? recapFrom(metadata),
        commandMode: current.commandMode ?? commandMode,
      });
    }
  }
  return details;
}

function isReviewRun(row: DashboardTaskRow, commandMode: string | null): boolean {
  return commandMode === 'review' || row.taskType === 'review' || /^Review PR #\d+:/i.test(row.title ?? '');
}

/**
 * A review recap split into its score and the part worth reading.
 *
 * The recap reads `Score 8/10 · 2 issues found: …`. The score becomes the
 * row's score badge — with more than one reviewer, the lowest, because that is
 * the one that decides whether the pull request is ready — and what remains is
 * the detail line.
 */
function splitReviewRecap(recap: string | null): { score: number | null; detail: string | null } {
  if (!recap) return { score: null, detail: null };
  let score: number | null = null;
  const rest: string[] = [];
  for (const part of recap.split(' · ')) {
    const scorePart = REVIEW_SCORE_PART.exec(part.trim());
    if (scorePart) {
      const scores = [...scorePart[1].matchAll(/(\d+(?:\.\d+)?)\s*\/\s*10/g)].map(match => Number(match[1]));
      if (scores.length > 0) score = Math.min(...scores);
      continue;
    }
    rest.push(part);
  }
  const detail = rest.join(' · ').trim();
  return { score, detail: detail || null };
}

function meaningfulRecap(recap: string | null): string | null {
  if (!recap) return null;
  return GENERIC_RECAPS.has(recap.toLowerCase()) ? null : recap;
}

/**
 * Recent completions, newest first, optionally narrowed to titles containing
 * `search`.
 *
 * The title is resolved from the job data a run was queued with, so the
 * search first narrows candidates in SQL by that job data and then matches the
 * resolved title itself: a word that only appears in an issue body must not
 * make an unrelated run look like a title match.
 */
export async function loadCompletedRows(
  db: Knex,
  repository: string,
  options: { limit?: number; search?: string } = {},
): Promise<CompletedRow[]> {
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
  const search = options.search?.trim().toLowerCase() ?? '';

  const query = terminalTransitionQuery(db, repository, 'completed')
    .where(function (this: Knex.QueryBuilder) {
      this.whereNull('h.reason').orWhereNot('h.reason', 'like', SKIPPED_REASON_PATTERN);
    })
    .select(TASK_COLUMNS)
    .orderBy('h.timestamp', 'desc')
    .limit(search ? MAX_SEARCH_SCAN : limit);
  if (search) query.where('t.initial_job_data', 'like', `%${search}%`);

  const mapped = (await query as unknown as RawTaskRow[])
    .map(mapTaskRow)
    .filter(row => !search || (row.title ?? '').toLowerCase().includes(search))
    .slice(0, limit);
  if (mapped.length === 0) return [];

  const details = await loadCompletionDetails(db, mapped.map(row => row.taskId));
  return mapped.map(row => {
    const detail = details.get(row.taskId) ?? { recap: null, commandMode: null };
    if (isReviewRun(row, detail.commandMode)) {
      const review = splitReviewRecap(detail.recap);
      return { ...row, recap: meaningfulRecap(review.detail), reviewScore: review.score };
    }
    return { ...row, recap: meaningfulRecap(detail.recap), reviewScore: null };
  });
}
