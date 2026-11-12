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
 * compares with reports stored by newer runs. Ties on the storing time are
 * broken by run id, so the choice is deterministic.
 */
export async function listLatestStoredReports(
  definitionId: string,
  { limit, excludeRunId }: ListLatestStoredReportsOptions,
  { database = db }: AgentRunStoreDependencies = {},
): Promise<PreviousAgentReport[]> {
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
 * Stores a run's report with its novelty flags (running → report_ready), but
 * only while the definition's latest stored report is still the one the flags
 * were classified against. Comparing and storing are one step per definition:
 * Postgres locks the definition row until commit, and SQLite, which ignores
 * FOR UPDATE, opens the transaction holding its write lock (`BEGIN IMMEDIATE`).
 * So of two runs storing the same report at once, the second finds the first's
 * report and is told to compare again, instead of storing it as new as well.
 */
export async function storeAgentRunReport(
  run: Pick<StoredAgentRun, 'id' | 'definitionId'>,
  { patch, previousRunId }: StoreAgentRunReportInput,
  { database = db, now = Date.now }: AgentRunStoreDependencies = {},
): Promise<StoreAgentRunReportResult> {
  return database.transaction(async trx => {
    await trx('agent_definitions').where({ id: run.definitionId }).forUpdate().first('id');
    const [latest] = await listLatestStoredReports(run.definitionId, { limit: 1, excludeRunId: run.id }, { database: trx });
    if ((latest?.runId ?? null) !== previousRunId) return { outcome: 'previous_changed' as const };
    // The storing time is taken here, under the lock, so it follows the order reports are stored in.
    const stored = await transitionAgentRun(run.id, ['running'], 'report_ready', patch, { database: trx, now });
    return stored ? { outcome: 'stored' as const, run: stored } : { outcome: 'not_running' as const };
  });
}
