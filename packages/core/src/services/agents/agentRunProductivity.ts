import {
  AUTOMATION_UNPRODUCTIVE_RUN_THRESHOLD_SETTING,
  DEFAULT_AUTOMATION_UNPRODUCTIVE_RUN_THRESHOLD,
  automationRunNoChangeReason,
  isAutomationUnproductiveRunThreshold,
} from '@propr/shared';
import { getConfig } from '../../config/configManager.js';
import { db } from '../../db/connection.js';
import logger from '../../utils/logger.js';
import { rowToAgentRun, type AgentRunRow, type AgentRunStoreDependencies, type StoredAgentRun } from './agentRunStore.js';

/**
 * Unproductive-run streaks. A run is unproductive when its report was empty or
 * unchanged, or its acting step changed nothing. Only scheduled runs count
 * toward a streak: a manual run is flagged like any other, but neither extends
 * nor resets it. The run state machine is untouched; this is read-only.
 */

export type AgentRunProductivity = 'productive' | 'unproductive' | 'pending';

/** States in which the report is stored but the acting step may still change the verdict. */
const UNDECIDED_STATES = new Set<StoredAgentRun['state']>(['report_ready', 'acting']);

/**
 * The run's verdict. `pending` runs have no flags yet, or an acting step that
 * may still change something; they neither extend nor break a streak.
 */
export function agentRunProductivity(run: Pick<StoredAgentRun, 'state' | 'reportNovelty' | 'actingMutations'>): AgentRunProductivity {
  if (run.reportNovelty == null) return 'pending';
  if (run.actingMutations == null && UNDECIDED_STATES.has(run.state)) return 'pending';
  return automationRunNoChangeReason(run) ? 'unproductive' : 'productive';
}

/** Instance setting `automation_unproductive_run_threshold`; an unreadable or invalid value uses the default. */
export async function loadUnproductiveRunThreshold(
  { readConfig = getConfig }: { readConfig?: <T>(key: string, fallback: T) => Promise<T> } = {},
): Promise<number> {
  try {
    const stored = await readConfig<unknown>(AUTOMATION_UNPRODUCTIVE_RUN_THRESHOLD_SETTING, DEFAULT_AUTOMATION_UNPRODUCTIVE_RUN_THRESHOLD);
    if (isAutomationUnproductiveRunThreshold(stored)) return stored;
    logger.warn({ stored_value: stored }, `Invalid ${AUTOMATION_UNPRODUCTIVE_RUN_THRESHOLD_SETTING} in DB, using default`);
  } catch (error) {
    logger.warn({ err: error }, `Could not load ${AUTOMATION_UNPRODUCTIVE_RUN_THRESHOLD_SETTING}, using default`);
  }
  return DEFAULT_AUTOMATION_UNPRODUCTIVE_RUN_THRESHOLD;
}

/** Pending runs a streak look-back tolerates beyond the threshold before it gives up. */
const STREAK_LOOKBACK_SLACK = 10;

export interface UnproductiveStreak {
  /** The unproductive scheduled runs of the current streak, newest first (at most `threshold + 1`). */
  runs: StoredAgentRun[];
  /** True when the streak reached exactly `threshold` runs: the moment to tell the owner, once. */
  reachedThreshold: boolean;
}

/**
 * The definition's current streak of unproductive scheduled runs, newest
 * first. Pending runs are skipped; the first productive one ends the streak.
 * Counting stops one past the threshold, so `reachedThreshold` is true only
 * for the run that completed the streak, and a longer streak is not reported
 * again until a productive run resets it.
 */
export async function findUnproductiveScheduledStreak(
  definitionId: string,
  threshold: number,
  { database = db }: AgentRunStoreDependencies = {},
): Promise<UnproductiveStreak> {
  const limit = Math.max(Math.trunc(threshold), 1);
  const rows = await database('agent_runs').where({ definition_id: definitionId, trigger: 'schedule' })
    .whereNotNull('report_novelty')
    .orderBy([{ column: 'created_at', order: 'desc' }, { column: 'id', order: 'desc' }])
    .limit(limit + 1 + STREAK_LOOKBACK_SLACK).select<AgentRunRow[]>();
  const runs: StoredAgentRun[] = [];
  for (const run of rows.map(rowToAgentRun)) {
    const verdict = agentRunProductivity(run);
    if (verdict === 'pending') continue;
    if (verdict === 'productive' || runs.length > limit) break;
    runs.push(run);
  }
  return { runs, reachedThreshold: runs.length === limit };
}
