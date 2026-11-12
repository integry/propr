import { db } from '../../db/connection.js';
import {
  AGENT_RUN_STATES_WITH_REPORT,
  transitionAgentRun,
  type AgentRunRow,
  type AgentRunStoreDependencies,
  type AgentRunTransitionPatch,
  type StoredAgentRun,
} from './agentRunStore.js';

/** Previous-report lookup: a recurring agent's own earlier reports as an input to its next run. */

export interface PreviousAgentReport {
  runId: string;
  reportedAt: number;
  report: string;
}

export interface ListPreviousReportsOptions {
  limit: number;
  /** Only runs created strictly before this time (epoch ms), typically the current run's `createdAt`. */
  beforeCreatedAt?: number;
  /** Run to leave out regardless of timestamps, typically the current run. */
  excludeRunId?: string;
}

/**
 * The newest reports a definition produced, newest first, so a recurring
 * agent can diff against last time. Failed, skipped and cancelled-before-report
 * runs are excluded because they have no report.
 */
export async function listPreviousReports(
  definitionId: string,
  { limit, beforeCreatedAt, excludeRunId }: ListPreviousReportsOptions,
  { database = db }: AgentRunStoreDependencies = {},
): Promise<PreviousAgentReport[]> {
  const boundedLimit = Math.trunc(limit);
  if (!(boundedLimit > 0)) return [];
  const query = database('agent_runs').where({ definition_id: definitionId })
    .whereIn('state', [...AGENT_RUN_STATES_WITH_REPORT])
    .whereNotNull('report');
  if (beforeCreatedAt !== undefined) query.where('created_at', '<', beforeCreatedAt);
  if (excludeRunId !== undefined) query.whereNot({ id: excludeRunId });
  const rows = await query.orderBy([{ column: 'created_at', order: 'desc' }, { column: 'id', order: 'desc' }])
    .limit(boundedLimit).select<Pick<AgentRunRow, 'id' | 'reported_at' | 'created_at' | 'report'>[]>('id', 'reported_at', 'created_at', 'report');
  return rows.map(row => ({
    runId: row.id,
    reportedAt: Number(row.reported_at ?? row.created_at),
    report: row.report ?? '',
  }));
}

/** A stored report, with its run's creation time: the prompt history its run was given is read relative to it. */
export interface LatestStoredReport extends PreviousAgentReport {
  createdAt: number;
}

export interface ListLatestStoredReportsOptions {
  limit: number;
  /** Run to leave out, typically the run whose report is about to be stored. */
  excludeRunId?: string;
}

/**
 * The definition's most recently stored reports, newest report first, for
 * report novelty. Unlike `listPreviousReports` (prompt history), this follows
 * the order reports were stored in, not the order runs were created in, and
 * keeps a report whatever happened to its run afterwards: a run whose acting
 * step later failed still reported. So a run created earlier but deferred
 * compares with reports stored by newer runs. Reports stored through
 * `storeAgentRunReport` have strictly increasing storing times per definition,
 * so the newest one is the one stored last; the run id breaks ties only among
 * reports written outside that path (older code), so the choice stays deterministic.
 */
export async function listLatestStoredReports(
  definitionId: string,
  { limit, excludeRunId }: ListLatestStoredReportsOptions,
  { database = db }: AgentRunStoreDependencies = {},
): Promise<LatestStoredReport[]> {
  const boundedLimit = Math.trunc(limit);
  if (!(boundedLimit > 0)) return [];
  const query = database('agent_runs').where({ definition_id: definitionId }).whereNotNull('report');
  if (excludeRunId !== undefined) query.whereNot({ id: excludeRunId });
  // Runs stored before reported_at existed fall back to their creation time.
  const rows = await query.orderByRaw('COALESCE(reported_at, created_at) DESC, id DESC')
    .limit(boundedLimit).select<Pick<AgentRunRow, 'id' | 'reported_at' | 'created_at' | 'report'>[]>('id', 'reported_at', 'created_at', 'report');
  return rows.map(row => ({
    runId: row.id,
    reportedAt: Number(row.reported_at ?? row.created_at),
    createdAt: Number(row.created_at),
    report: row.report ?? '',
  }));
}

export interface StoreAgentRunReportInput {
  /** The report and the novelty flags classified against `previousRunId`. */
  patch: AgentRunTransitionPatch;
  /** The previous reported run the flags were classified against; null when there was none. */
  previousRunId: string | null;
}

/**
 * `stored`: the run moved to `report_ready` with the patch. `not_running`: the
 * run left `running` first, and nothing was stored. `previous_changed`: another
 * run stored a report since the flags were classified, and nothing was stored.
 */
export type StoreAgentRunReportResult =
  | { outcome: 'stored'; run: StoredAgentRun }
  | { outcome: 'not_running' }
  | { outcome: 'previous_changed' };

/**
 * Stores a report (running → report_ready) under the definition's lock, after
 * `accept` has seen the definition's latest stored report. The storing time is
 * taken under the lock and kept strictly after the latest report's, so the
 * order reports were stored in is the order `listLatestStoredReports` returns
 * them in: the lock serialises the writes, but the clock alone would let two
 * reports stored in the same millisecond, or by hosts whose clocks differ, be
 * ordered by run id instead.
 */
async function storeReportUnderDefinitionLock(
  run: Pick<StoredAgentRun, 'id' | 'definitionId'>,
  patch: AgentRunTransitionPatch,
  accept: (latest: PreviousAgentReport | null) => boolean,
  { database = db, now = Date.now }: AgentRunStoreDependencies = {},
): Promise<StoreAgentRunReportResult> {
  return database.transaction(async trx => {
    await trx('agent_definitions').where({ id: run.definitionId }).forUpdate().first('id');
    const [latest = null] = await listLatestStoredReports(run.definitionId, { limit: 1, excludeRunId: run.id }, { database: trx });
    if (!accept(latest)) return { outcome: 'previous_changed' as const };
    const timestamp = now();
    const storedAt = latest ? Math.max(timestamp, latest.reportedAt + 1) : timestamp;
    const stored = await transitionAgentRun(run.id, ['running'], 'report_ready', patch, { database: trx, now: () => storedAt });
    return stored ? { outcome: 'stored' as const, run: stored } : { outcome: 'not_running' as const };
  });
}

/**
 * Stores a run's report with its novelty flags (running → report_ready), but
 * only while the definition's latest stored report is still the one the flags
 * were classified against. Comparing and storing are one step per definition:
 * Postgres locks the definition row until commit, and SQLite, which ignores
 * FOR UPDATE, opens the transaction holding its write lock (`BEGIN IMMEDIATE`).
 * So of two runs storing the same report at once, the second finds the first's
 * report and is told to compare again, instead of storing it as new as well.
 * The stored report then becomes the definition's latest, whatever the clock said.
 */
export async function storeAgentRunReport(
  run: Pick<StoredAgentRun, 'id' | 'definitionId'>,
  { patch, previousRunId }: StoreAgentRunReportInput,
  deps: AgentRunStoreDependencies = {},
): Promise<StoreAgentRunReportResult> {
  return storeReportUnderDefinitionLock(run, patch, latest => (latest?.runId ?? null) === previousRunId, deps);
}

/**
 * Stores a run's report without novelty flags (running → report_ready), when
 * none could be classified. It still takes the definition's lock so it becomes
 * the latest stored report in order, and the next run compares with it. Returns
 * the reported run, or null when the run had left `running`.
 */
export async function storeUnclassifiedAgentRunReport(
  run: Pick<StoredAgentRun, 'id' | 'definitionId'>,
  report: string,
  deps: AgentRunStoreDependencies = {},
): Promise<StoredAgentRun | null> {
  const stored = await storeReportUnderDefinitionLock(run, { report }, () => true, deps);
  return stored.outcome === 'stored' ? stored.run : null;
}
