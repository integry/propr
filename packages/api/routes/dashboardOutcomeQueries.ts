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

/** Candidates read per page while a title search looks for its matches. */
const SEARCH_PAGE_SIZE = 500;

/**
 * Searches whose every character appears verbatim wherever it is serialised.
 *
 * JSON escapes quotes, backslashes and control characters, some encoders also
 * escape `/`, `'`, `<`, `>` and `&` or everything outside ASCII, and `%` and
 * `_` are `LIKE` wildcards. A title containing a search made only of the
 * characters below therefore contains it in the raw job data too, so the raw
 * text can narrow the candidates without dropping a title that matches.
 */
const VERBATIM_SEARCH = /^[a-z0-9 .,:;!?()#@+=*~^$|{}[\]`-]+$/;

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
 * The title is resolved from the job data a run was queued with, so it is
 * matched after decoding rather than in SQL: a word that only appears in an
 * issue body must not make an unrelated run look like a title match, and an
 * escaped quote in the stored JSON must not hide one that does. The raw job
 * data only narrows the candidates when that cannot drop a match (see
 * `VERBATIM_SEARCH`), and candidates are read page by page until the limit is
 * filled or history runs out, so runs that match only in their bodies cannot
 * crowd an older title match out of the result.
 */
export async function loadCompletedRows(
  db: Knex,
  repository: string,
  options: { limit?: number; search?: string } = {},
): Promise<CompletedRow[]> {
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
  const search = options.search?.trim().toLowerCase() ?? '';

  const candidates = (after: RawTaskRow | null, pageSize: number): Knex.QueryBuilder => {
    const query = terminalTransitionQuery(db, repository, 'completed')
      .where(function (this: Knex.QueryBuilder) {
        this.whereNull('h.reason').orWhereNot('h.reason', 'like', SKIPPED_REASON_PATTERN);
      })
      .select(TASK_COLUMNS)
      .orderBy([{ column: 'h.timestamp', order: 'desc' }, { column: 't.task_id', order: 'desc' }])
      .limit(pageSize);
    if (search && VERBATIM_SEARCH.test(search)) query.where('t.initial_job_data', 'like', `%${search}%`);
    if (after) {
      query.where(function (this: Knex.QueryBuilder) {
        this.where('h.timestamp', '<', after.state_timestamp)
          .orWhere(function (this: Knex.QueryBuilder) {
            this.where('h.timestamp', '=', after.state_timestamp).andWhere('t.task_id', '<', after.task_id);
          });
      });
    }
    return query;
  };

  let mapped: DashboardTaskRow[];
  if (!search) {
    mapped = (await candidates(null, limit) as unknown as RawTaskRow[]).map(mapTaskRow);
  } else {
    mapped = [];
    let after: RawTaskRow | null = null;
    while (mapped.length < limit) {
      const page = await candidates(after, SEARCH_PAGE_SIZE) as unknown as RawTaskRow[];
      for (const row of page) {
        const mappedRow = mapTaskRow(row);
        if ((mappedRow.title ?? '').toLowerCase().includes(search)) mapped.push(mappedRow);
      }
      if (page.length < SEARCH_PAGE_SIZE) break;
      after = page[page.length - 1];
    }
    mapped = mapped.slice(0, limit);
  }
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
