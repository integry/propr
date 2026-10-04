/**
 * Recorded completions — the dashboard's second source of truth.
 *
 * The "Completed" feed lists one outcome per entity, newest first.
 * Completions are recorded events, so they are read from task history rather
 * than from a task's current state: a run that completed and is now being
 * followed up still completed.
 *
 * The legacy reader below is also the backfill parity oracle. Serving reads
 * use the durable, versioned projection at the end of this module.
 *
 * Failures are not listed here: an unresolved failure is something a person
 * has to act on, so it belongs in the attention list. Cancellations and jobs
 * that were skipped or rescheduled are bookkeeping, not results, and appear in
 * neither.
 */

import { isDeepStrictEqual } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import type { Knex } from 'knex';
import { OUTCOME_TABLES as T, seedOutcomeProjection } from '../services/dashboardReadService.js';
export { OUTCOME_TABLES, installOutcomeProjection, rebuildOutcomeProjection, outcomeProjectionStatus } from '../services/dashboardReadService.js';
import {
  chunk,
  mapTaskRow,
  QUEUED_TASK_STATES,
  RUNNING_TASK_STATES,
  TASK_COLUMNS,
  type DashboardTaskRow,
  type RawTaskRow,
} from './dashboardQueries.js';

interface CompletionRow extends DashboardTaskRow {
  completionId: number;
}

export interface CompletionUpdate extends CompletionRow {
  /**
   * What the run actually produced, from the recap recorded on its completion,
   * or null when the only thing recorded is that it finished.
   */
  recap: string | null;
  /** Review score out of 10; only reviews carry one, and only when recorded. */
  reviewScore: number | null;
}

export interface CompletedRow extends CompletionUpdate {
  /** Includes the latest outcome; earlierUpdates excludes it. */
  eventCount: number;
  earlierUpdates: CompletionUpdate[];
}

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
 * States that open a run. A completion is terminal, so a task that records one
 * of these after completing has been started again, and what it records from
 * then on belongs to the new run.
 */
const RUN_START_STATES: readonly string[] = [...QUEUED_TASK_STATES, ...RUNNING_TASK_STATES];

/**
 * The newest recap and command mode recorded by the run each row's completion
 * belongs to.
 *
 * A run can record more than one completion ("implementation completed",
 * then "PR ready"), and the recap is not always on the newest one, so every
 * completion of that run is read and the newest that says something wins. The
 * run's history is read back from the listed completion and stops where the
 * run started: a task that is followed up runs again under the same id, and a
 * recap or review score from an earlier run must not be shown as the result of
 * a later one that recorded none.
 */
async function loadCompletionDetails(db: Knex, rows: readonly CompletionRow[]): Promise<Map<number, CompletionDetails>> {
  const details = new Map<number, CompletionDetails>();
  for (const batch of chunk([...new Set(rows.map(row => row.taskId))])) {
    const history = await db('task_history')
      .whereIn('task_id', batch)
      .whereIn('state', ['completed', ...RUN_START_STATES])
      .select('task_id', 'history_id', 'state', 'timestamp', 'metadata')
      .orderBy([{ column: 'timestamp', order: 'desc' }, { column: 'history_id', order: 'desc' }]) as Array<Record<string, unknown>>;
    const byTask = new Map<string, Array<Record<string, unknown>>>();
    for (const entry of history) {
      const taskId = String(entry.task_id);
      const entries = byTask.get(taskId) ?? [];
      entries.push(entry);
      byTask.set(taskId, entries);
    }
    for (const row of rows.filter(row => byTask.has(row.taskId))) {
      const current: CompletionDetails = { recap: null, commandMode: null };
      let found = false;
      for (const entry of byTask.get(row.taskId)!) {
        if (!found && Number(entry.history_id) !== row.completionId) continue;
        found = true;
        const metadata = parseJsonObject(entry.metadata);
        current.commandMode ??= typeof metadata.commandMode === 'string' ? metadata.commandMode : null;
        if (entry.state !== 'completed') break;
        current.recap ??= meaningfulRecap(recapFrom(metadata));
      }
      details.set(row.completionId, current);
    }
  }
  return details;
}

function isReviewRun(row: Pick<DashboardTaskRow, 'taskType' | 'title'>, commandMode: string | null): boolean {
  if (commandMode !== null) return commandMode === 'review';
  return row.taskType === 'review' || /^Review PR #\d+:/i.test(row.title ?? '');
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
 * Group before limiting or searching so retries cannot crowd other entities
 * off the page. Keep the newest outcome (and its own recap/score), with the
 * count of completed runs behind it. Duplicate terminal transitions within a
 * run and skipped work remain excluded, while a later run cannot erase a review.
 *
 * Identity follows mapTaskRow's PR resolution, including legacy PR task IDs
 * and PRs recorded only in final_result. Goal and issue keys are fallbacks;
 * repository and entity kind are both part of the partition.
 */
function entityCompletions(db: Knex, repository: string, taskId?: string): Knex.QueryBuilder {
  // Keep one outcome per run, not per task: a review and a subsequent fix can
  // reuse the same task ID. Consecutive completion writes are still one run.
  const history = db('task_history')
    .modify(query => { if (taskId !== undefined) query.where('task_id', taskId); })
    .whereIn('state', ['completed', ...RUN_START_STATES])
    .select('task_id', 'history_id', 'state', 'timestamp', 'reason').select(db.raw(`
    SUM(CASE WHEN state IN (${RUN_START_STATES.map(() => '?').join(', ')}) THEN 1 ELSE 0 END)
      OVER (PARTITION BY task_id ORDER BY timestamp, history_id) AS run_id
  `, [...RUN_START_STATES]));
  const runs = db.from('completion_history').where('state', 'completed')
    .where(query => query.whereNull('reason').orWhereNot('reason', 'like', SKIPPED_REASON_PATTERN))
    .select('*').select(db.raw(`ROW_NUMBER() OVER (
      PARTITION BY task_id, run_id ORDER BY timestamp DESC, history_id DESC
    ) AS completion_rank`));
  const completed = db('tasks as t').join('completion_runs as h', 'h.task_id', 't.task_id')
    .where('h.completion_rank', 1)
    .where(query => query.whereNull('t.task_type').orWhereNot('t.task_type', 'goal'))
    .modify(query => { if (repository && repository !== 'all') query.where('t.repository', repository); })
    .select(TASK_COLUMNS).select('h.history_id');
  const validJob = "CASE WHEN json_valid(initial_job_data) THEN initial_job_data ELSE '{}' END";
  const validResult = "CASE WHEN json_valid(final_result) THEN final_result ELSE '{}' END";
  const numbered = db.from('completed').select('*').select(db.raw(`
    COALESCE(pr_number,
      CASE WHEN json_type(${validJob}, '$.pullRequestNumber') IN ('integer', 'real')
        THEN json_extract(${validJob}, '$.pullRequestNumber') END,
      CASE WHEN task_type IN ('pr-comment', 'review', 'merge_conflict')
        OR substr(task_id, 1, 11) = 'pr-comment-'
        OR substr(task_id, 1, 12) = 'pr-comments-'
        THEN issue_number END,
      CASE WHEN json_type(${validResult}, '$.postProcessing.pr.number') IN ('integer', 'real')
        THEN json_extract(${validResult}, '$.postProcessing.pr.number') END
    ) AS entity_pr_number,
    CASE WHEN json_type(${validJob}, '$.goalId') = 'text'
      THEN NULLIF(trim(json_extract(${validJob}, '$.goalId')), '') END AS entity_goal_id,
    COALESCE(
      CASE WHEN json_type(${validJob}, '$.title') = 'text'
        THEN NULLIF(trim(json_extract(${validJob}, '$.title')), '') END,
      CASE WHEN json_type(${validJob}, '$.issueRef.title') = 'text'
        THEN NULLIF(trim(json_extract(${validJob}, '$.issueRef.title')), '') END,
      CASE WHEN json_type(${validJob}, '$.branchName') = 'text'
        THEN NULLIF(trim(json_extract(${validJob}, '$.branchName')), '') END
    ) AS resolved_title
  `));
  // Window sorts must not carry the task's potentially megabyte-sized job
  // and result JSON. Resolve identity/title first, rank compact rows, then
  // retrieve payloads for the selected outcomes.
  const entities = db.from('numbered').select(
    'task_id', 'repository', 'issue_number', 'pr_number', 'task_type', 'model_name',
    'created_at', 'state', 'state_timestamp', 'reason', 'history_id',
    'resolved_title',
  ).select(db.raw(`
    CASE
      WHEN entity_pr_number IS NOT NULL THEN 'pr:' || entity_pr_number
      WHEN entity_goal_id IS NOT NULL THEN 'goal:' || entity_goal_id
      WHEN issue_number IS NOT NULL THEN 'issue:' || issue_number
      ELSE 'task:' || task_id
    END AS entity_key
  `));
  const ranked = db.from('entities').select('*').select(db.raw(`
    ROW_NUMBER() OVER (
      PARTITION BY repository, entity_key ORDER BY state_timestamp DESC, task_id DESC, history_id DESC
    ) AS entity_rank,
    COUNT(*) OVER (PARTITION BY repository, entity_key) AS event_count,
    FIRST_VALUE(resolved_title) OVER (
      PARTITION BY repository, entity_key
      ORDER BY (resolved_title IS NULL), state_timestamp DESC, task_id DESC, history_id DESC
    ) AS entity_title
  `));
  return db.with('completion_history', history).with('completion_runs', runs).with('completed', completed).with('numbered', numbered)
    .with('entities', entities).with('ranked', ranked)
    .from('ranked');
}

/** Recent entity outcomes, optionally narrowed by their decoded title. */
export async function loadCompletedRows(
  db: Knex,
  repository: string,
  options: { limit?: number; search?: string } = {},
  taskId?: string, // Internal bounded parity oracle during background backfill.
): Promise<CompletedRow[]> {
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
  const search = options.search?.trim().toLowerCase() ?? '';
  type EntityRow = RawTaskRow & { history_id: number; event_count: number; entity_key: string; entity_title: string | null };
  // Choose parents before hydrating any task JSON. Searching decodes titles
  // with JavaScript's Unicode case folding, as before, but reads the compact
  // parent titles once instead of rerunning all windows for every 500 matches.
  const parents = () => db.from('ranked').where('entity_rank', 1)
    .orderBy([{ column: 'state_timestamp', order: 'desc' }, { column: 'task_id', order: 'desc' }]);
  let selectedKeys: Array<[string, string]> | undefined;
  if (search) {
    const titles = await entityCompletions(db, repository, taskId).where('entity_rank', 1)
      .select('repository', 'entity_key', 'entity_title')
      .orderBy([{ column: 'state_timestamp', order: 'desc' }, { column: 'task_id', order: 'desc' }]) as EntityRow[];
    selectedKeys = titles.filter(row => (row.entity_title ?? '').toLowerCase().includes(search))
      .slice(0, limit).map(row => [row.repository, row.entity_key]);
    if (selectedKeys.length === 0) return [];
  }

  // A single materialized ranking supplies both parents and earlier updates.
  // Limiting parents never limits an entity's history or changes its count.
  const selectedQuery = entityCompletions(db, repository, taskId);
  if (selectedKeys) selectedQuery.whereIn(['repository', 'entity_key'], selectedKeys);
  else selectedQuery.whereIn(['repository', 'entity_key'], parents().select('repository', 'entity_key').limit(limit));
  const selected = await selectedQuery.select('*')
    .orderBy([{ column: 'state_timestamp', order: 'desc' }, { column: 'task_id', order: 'desc' }, { column: 'history_id', order: 'desc' }]) as Array<EntityRow & { entity_rank: number }>;
  const payloads = new Map<string, Pick<RawTaskRow, 'initial_job_data' | 'final_result'>>();
  for (const batch of chunk([...new Set(selected.map(row => row.task_id))])) {
    for (const row of await db('tasks').whereIn('task_id', batch)
      .select('task_id', 'initial_job_data', 'final_result')) payloads.set(row.task_id, row);
  }
  const hydrate = (row: EntityRow): CompletionRow => ({
    ...mapTaskRow({ ...row, ...payloads.get(row.task_id) }), completionId: row.history_id,
  });
  const visible = selected.filter(row => Number(row.entity_rank) === 1).map(row => ({
    ...hydrate(row), title: row.entity_title, eventCount: Number(row.event_count), entityKey: row.entity_key,
  }));
  const earlier = selected.filter(row => Number(row.entity_rank) > 1);
  const earlierRows = earlier.map(hydrate);
  const details = await loadCompletionDetails(db, [...visible, ...earlierRows]);
  const updates = new Map<string, CompletionUpdate[]>();
  for (const [index, raw] of earlier.entries()) {
    const key = JSON.stringify([raw.repository, raw.entity_key]);
    const group = updates.get(key) ?? [];
    group.push(withCompletionDetails(earlierRows[index], details));
    updates.set(key, group);
  }
  return visible.map(row => ({
    ...withCompletionDetails(row, details), eventCount: row.eventCount,
    earlierUpdates: updates.get(JSON.stringify([row.repository, row.entityKey])) ?? [],
  }));
}

function withCompletionDetails<Row extends Pick<CompletionRow, 'completionId' | 'taskType' | 'title'>>(
  row: Row, details: Map<number, CompletionDetails>,
): Omit<Row, 'taskType'> & Pick<CompletionUpdate, 'taskType' | 'recap' | 'reviewScore'> {
  const detail = details.get(row.completionId) ?? { recap: null, commandMode: null };
  if (isReviewRun(row, detail.commandMode)) {
    const review = splitReviewRecap(detail.recap);
    return { ...row, taskType: 'review', recap: meaningfulRecap(review.detail), reviewScore: review.score };
  }
  const taskType = detail.commandMode === 'default' ? 'follow-up' : detail.commandMode ?? row.taskType;
  return { ...row, taskType, recap: meaningfulRecap(detail.recap), reviewScore: null };
}

export type OutcomeUpdate = Pick<CompletionUpdate, 'taskId' | 'repository' | 'issueNumber' | 'prNumber'
  | 'taskType' | 'title' | 'stateTimestamp' | 'completionId' | 'recap' | 'reviewScore'>;

/** Only rendering fields enter the serving tables; source payloads remain authoritative. */
export function compactOutcome(row: OutcomeUpdate): OutcomeUpdate {
  return { taskId: row.taskId, repository: row.repository, issueNumber: row.issueNumber, prNumber: row.prNumber,
    taskType: row.taskType, title: row.title, stateTimestamp: row.stateTimestamp, completionId: row.completionId,
    recap: row.recap, reviewScore: row.reviewScore };
}

export type SummaryRow = OutcomeUpdate & { eventCount: number; entityId: string; revision: string };
export type OutcomeReadRow = OutcomeUpdate & {
  eventCount: number; earlierUpdates?: OutcomeUpdate[]; entityId?: string; revision?: string;
};
export class OutcomeProjectionError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}

const runOrder = [
  { column: 'sort_at', order: 'desc' }, { column: 'task_id', order: 'desc' },
  { column: 'completion_id', order: 'desc' },
] as const;
const orderedRuns = (db: Knex, entityId: string) => db(T.runs).where('entity_id', entityId).orderBy([...runOrder]);
const entityIdFor = (repository: string, key: string) => createHash('sha256').update(JSON.stringify([1, repository, key])).digest('base64url');

/** Only this task's history is ranked. The legacy reader remains the semantic oracle. */
async function projectTask(db: Knex, taskId: string) {
  const rows = await entityCompletions(db, 'all', taskId).select('*') as Array<RawTaskRow & {
    history_id: number; entity_key: string; resolved_title: string | null;
  }>;
  if (!rows.length) return [];
  const task = await db('tasks').where('task_id', taskId).first('initial_job_data', 'final_result');
  const mapped = rows.map(row => ({ ...mapTaskRow({ ...row, ...task }), completionId: row.history_id }));
  const details = await loadCompletionDetails(db, mapped);
  return rows.map((row, index) => ({
    completion_id: row.history_id, task_id: taskId, repository: row.repository,
    entity_id: entityIdFor(row.repository, row.entity_key), sort_at: row.state_timestamp,
    title: row.resolved_title, base_type: mapped[index].taskType,
    raw_recap: details.get(row.history_id)?.recap ?? null, command_mode: details.get(row.history_id)?.commandMode ?? null, payload: JSON.stringify(compactOutcome(withCompletionDetails(mapped[index], details))),
  }));
}

/** One bounded backfill batch, or one dirty task. Safe to retry after any crash. */
export async function advanceOutcomeProjection(db: Knex): Promise<boolean> {
  const state = await db(T.state).where('id', 1).first();
  if (!state.seeded) {
    await seedOutcomeProjection(db);
    return true;
  }
  // The expensive work is in a read snapshot, outside the short write transaction.
  const snapshot = await db.transaction(async tx => {
    const generation = await tx(T.state).where('id', 1).first('epoch', 'ready');
    const dirty = await tx(T.dirty).orderBy('changed_at').orderBy('task_id').first();
    if (!dirty) return null;
    const rows = await projectTask(tx, dirty.task_id);
    if (!generation.ready) {
      // Compare both implementations in one source snapshot before cutover.
      // Each check is bounded to one task, and subsequent source changes must
      // still pass the token fence before the results can commit.
      const oracle = await loadCompletedRows(tx, 'all', {}, dirty.task_id);
      const expected = oracle.flatMap(row => [row, ...row.earlierUpdates].map(compactOutcome)).sort((a, b) => a.completionId - b.completionId);
      const actual = rows.map(row => JSON.parse(row.payload) as OutcomeUpdate).sort((a, b) => a.completionId - b.completionId);
      if (!isDeepStrictEqual(actual, expected)) throw new Error(`Outcome backfill parity mismatch for task ${dirty.task_id}`);
    }
    return { dirty, rows, epoch: generation.epoch };
  });
  if (!snapshot) {
    if (state.ready) return false;
    await db.transaction(async tx => {
      await tx(T.state).where('id', 1).update({ updated_at: Date.now() });
      if (!await tx(T.dirty).first()) {
        const activated = await tx(T.state).where({ id: 1, seeded: 1, ready: 0 }).update({ ready: 1, error: null });
        // An empty backfill has no entity events, but unavailable clients still
        // need a wake-up when the projection becomes ready.
        if (activated) await tx(T.outbox).insert({ repository: '*', token: randomUUID() }).onConflict('repository').merge();
      }
    });
    return false;
  }
  await db.transaction(async tx => {
    // Acquiring the writer lock first makes the token check + replacement atomic.
    await tx(T.state).where('id', 1).update({ updated_at: Date.now() });
    const { dirty, rows } = snapshot;
    if ((await tx(T.state).where('id', 1).first('epoch')).epoch !== snapshot.epoch) return;
    if (!await tx(T.dirty).where({ task_id: dirty.task_id, token: dirty.token }).first()) return;
    const previous = await tx(T.runs).where('task_id', dirty.task_id).select('*');
    // History can move between tasks (or be deleted and reinserted with the
    // same ID). The fenced source snapshot authorizes this task to claim those
    // completions; include their former entities and repositories in the refresh.
    // Leave the former tasks queued: their remaining runs still need projecting.
    for (const batch of chunk(rows)) {
      previous.push(...await tx(T.runs).whereNot('task_id', dirty.task_id)
        .whereIn('completion_id', batch.map(row => row.completion_id)).select('*'));
    }
    const canonical = (values: typeof rows) => JSON.stringify([...values].sort((a, b) => a.completion_id - b.completion_id));
    // Compare named fields; SQLite's column order need not match the JS object.
    const old = previous.map(row => ({ completion_id: row.completion_id, task_id: row.task_id,
      repository: row.repository, entity_id: row.entity_id, sort_at: row.sort_at, title: row.title, base_type: row.base_type,
      raw_recap: row.raw_recap, command_mode: row.command_mode, payload: row.payload }));
    if (canonical(old) !== canonical(rows)) {
      const affected = new Set([...previous, ...rows].map(row => row.entity_id));
      await tx(T.runs).where('task_id', dirty.task_id).delete();
      for (const batch of chunk(rows, 50)) await tx(T.runs).insert(batch.map(row => ({ ...row, source_revision: dirty.token })))
        .onConflict('completion_id').merge();
      for (const entityId of affected) {
        const latest = await orderedRuns(tx, entityId).first();
        if (!latest) await tx(T.entities).where('entity_id', entityId).delete();
        else {
          const title = await orderedRuns(tx, entityId).whereNotNull('title').first('title');
          const count = await tx(T.runs).where('entity_id', entityId).count({ count: '*' }).first();
          const revision = randomUUID();
          const visible: OutcomeUpdate = { ...JSON.parse(latest.payload), title: title?.title ?? null, taskType: latest.base_type };
          const summary: SummaryRow = { ...withCompletionDetails(visible, new Map([[latest.completion_id,
            { recap: latest.raw_recap, commandMode: latest.command_mode }]])),
            eventCount: Number(count?.count), entityId, revision };
          await tx(T.entities).insert({ entity_id: entityId, repository: latest.repository,
            sort_at: latest.sort_at, task_id: latest.task_id, completion_id: latest.completion_id,
            title: summary.title, revision, payload: JSON.stringify(summary) }).onConflict('entity_id').merge();
        }
      }
      // Coalesced durable outbox: a crash after commit cannot lose the wake-up.
      for (const repository of new Set([...previous, ...rows].map(row => row.repository))) {
        await tx(T.outbox).insert({ repository, token: randomUUID() }).onConflict('repository').merge();
      }
    }
    await tx(T.runs).where('task_id', dirty.task_id).update({ source_revision: dirty.token });
    await tx(T.dirty).where({ task_id: dirty.task_id, token: dirty.token }).delete();
    await tx(T.state).where('id', 1).increment('processed', 1);
  });
  return true;
}

async function requireOutcomeProjection(db: Knex): Promise<void> {
  if (process.env.DASHBOARD_OUTCOME_PROJECTION === 'legacy' || !await db.schema.hasTable(T.state)
    || !(await db(T.state).where('id', 1).first('ready'))?.ready) {
    throw new OutcomeProjectionError(503, 'OUTCOMES_NOT_READY');
  }
}

/** Serving reads never touch tasks or task_history, even for Unicode search. */
export async function loadOutcomeSummaries(db: Knex, repository: string, options: { limit?: number; search?: string } = {}): Promise<SummaryRow[]> {
  return db.transaction(async tx => {
    await requireOutcomeProjection(tx);
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
    const query = tx(T.entities).modify(q => { if (repository !== 'all') q.where({ repository }); })
      .orderBy([...runOrder, { column: 'entity_id', order: 'asc' }]);
    const search = options.search?.trim().toLowerCase();
    if (!search) return (await query.select('payload').limit(limit) as Array<{ payload: string }>).map(row => JSON.parse(row.payload));
    const titles = await query.select('entity_id', 'title') as Array<{ entity_id: string; title: string | null }>;
    const ids = titles.filter(row => (row.title ?? '').toLowerCase().includes(search)).slice(0, limit).map(row => row.entity_id);
    const rows = await tx(T.entities).whereIn('entity_id', ids).select('entity_id', 'payload');
    const byId = new Map(rows.map(row => [row.entity_id, row.payload]));
    return ids.map(id => JSON.parse(byId.get(id)));
  });
}

type HistoryCursor = { v: number; entity: string; repository: string; revision: string; at: string | number; task: string; completion: number };
export async function loadOutcomeHistory(db: Knex, repository: string,
  ...reference: [entityId: string, revision: string, options?: { limit?: number; cursor?: string }]
): Promise<{ updates: OutcomeUpdate[]; nextCursor: string | null }> {
  const [entityId, revision, options = {}] = reference;
  // Concrete repository required even when the feed was requested with "all".
  if (!repository || repository === 'all') throw new OutcomeProjectionError(400, 'REPOSITORY_REQUIRED');
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 50);
  return db.transaction(async tx => {
    await requireOutcomeProjection(tx);
    const entity = await tx(T.entities).where({ entity_id: entityId, repository }).first();
    if (!entity) throw new OutcomeProjectionError(404, 'OUTCOME_NOT_FOUND');
    if (entity.revision !== revision) throw new OutcomeProjectionError(409, 'OUTCOME_HISTORY_STALE');
    let boundary: HistoryCursor = { v: 1, entity: entityId, repository, revision,
      at: entity.sort_at, task: entity.task_id, completion: entity.completion_id };
    if (options.cursor) {
      try {
        if (typeof options.cursor !== 'string' || options.cursor.length > 2048) throw new Error();
        const parsed = JSON.parse(Buffer.from(options.cursor, 'base64url').toString()) as HistoryCursor;
        if (parsed.v !== 1 || parsed.entity !== entityId || parsed.repository !== repository || parsed.revision !== revision
          || !(typeof parsed.at === 'string' || (typeof parsed.at === 'number' && Number.isFinite(parsed.at))) || typeof parsed.task !== 'string' || !Number.isSafeInteger(parsed.completion)) throw new Error();
        // A cursor must name an actual earlier run in this revision, not an arbitrary offset.
        if (!await tx(T.runs).where({ entity_id: entityId, sort_at: parsed.at, task_id: parsed.task, completion_id: parsed.completion })
          .whereRaw('(sort_at, task_id, completion_id) < (?, ?, ?)', [entity.sort_at, entity.task_id, entity.completion_id]).first()) throw new Error();
        boundary = parsed;
      } catch { throw new OutcomeProjectionError(400, 'INVALID_HISTORY_CURSOR'); }
    }
    const rows = await orderedRuns(tx, entityId)
      .whereRaw('(sort_at, task_id, completion_id) < (?, ?, ?)', [boundary.at, boundary.task, boundary.completion]).limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return { updates: page.map(row => JSON.parse(row.payload)),
      nextCursor: rows.length > limit ? Buffer.from(JSON.stringify({ ...boundary,
        at: last.sort_at, task: last.task_id, completion: last.completion_id })).toString('base64url') : null };
  });
}
