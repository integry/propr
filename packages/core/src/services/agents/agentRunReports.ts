import { db } from '../../db/connection.js';
import { AGENT_RUN_STATES_WITH_REPORT, type AgentRunRow, type AgentRunStoreDependencies } from './agentRunStore.js';

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
