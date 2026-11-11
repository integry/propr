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

/**
 * States in which the report is stored but an acting step may still run and
 * change the verdict: an acting step waiting for approval (preview, or an auto
 * run held by the cost gate) can still make the run productive once approved.
 */
const UNDECIDED_STATES = new Set<StoredAgentRun['state']>(['report_ready', 'awaiting_approval', 'acting']);

/**
 * The run's verdict. A known acting count is final on its own: more than zero
 * makes the run productive and zero is a no-op acting step, whether or not the
 * report could be compared. Otherwise the report novelty decides once no acting
 * step can still run. `pending` runs neither extend nor break a streak.
 */
export function agentRunProductivity(run: Pick<StoredAgentRun, 'state' | 'reportNovelty' | 'actingMutations'>): AgentRunProductivity {
  if (run.actingMutations == null && (run.reportNovelty == null || UNDECIDED_STATES.has(run.state))) return 'pending';
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

/** Rows read per page while walking back through a definition's scheduled runs. */
const STREAK_PAGE_SIZE = 100;
/** Rows a streak walk reads at most; a streak longer than this is identified by the oldest run read. */
const STREAK_SCAN_LIMIT = 1000;

export interface UnproductiveStreak {
  /** The unproductive scheduled runs of the current streak, newest first. */
  runs: StoredAgentRun[];
  /** True when the streak has at least `threshold` runs, so the owner should have been told. */
  reachedThreshold: boolean;
  /**
   * Stable identity of the streak: the productive scheduled run that ended the
   * previous streak (`start` when there is none). Runs added to the streak, or
   * older pending runs that later turn unproductive, keep the same identity.
   */
  streakKey: string;
}

/**
 * The definition's current streak of unproductive scheduled runs, newest
 * first. Pending runs are skipped; the first productive one ends the streak.
 * Rows count when either flag is known, so a run whose report could not be
 * compared still counts through its acting step.
 */
export async function findUnproductiveScheduledStreak(
  definitionId: string,
  threshold: number,
  { database = db }: AgentRunStoreDependencies = {},
): Promise<UnproductiveStreak> {
  const limit = Math.max(Math.trunc(threshold), 1);
  const runs: StoredAgentRun[] = [];
  let breaker: string | null = null;
  let oldestRead: AgentRunRow | null = null;
  for (let read = 0; read < STREAK_SCAN_LIMIT && breaker === null; read += STREAK_PAGE_SIZE) {
    const after = oldestRead;
    const rows = await database('agent_runs').where({ definition_id: definitionId, trigger: 'schedule' })
      .where(flagged => flagged.whereNotNull('report_novelty').orWhereNotNull('acting_mutations'))
      .modify(page => {
        // Keyset paging: a run created while the walk is under way cannot shift a page.
        if (after) page.where(older => older.where('created_at', '<', after.created_at)
          .orWhere(tied => tied.where('created_at', after.created_at).andWhere('id', '<', after.id)));
      })
      .orderBy([{ column: 'created_at', order: 'desc' }, { column: 'id', order: 'desc' }])
      .limit(STREAK_PAGE_SIZE).select<AgentRunRow[]>();
    for (const row of rows) {
      oldestRead = row;
      const run = rowToAgentRun(row);
      const verdict = agentRunProductivity(run);
      if (verdict === 'productive') { breaker = run.id; break; }
      if (verdict === 'unproductive') runs.push(run);
    }
    if (rows.length < STREAK_PAGE_SIZE) { breaker ??= 'start'; break; }
  }
  return { runs, reachedThreshold: runs.length >= limit, streakKey: breaker ?? `scan:${oldestRead?.id ?? 'start'}` };
}

/** True when an Inbox item with this deduplication key was persisted. */
export async function hasNotificationEvent(
  deduplicationKey: string,
  { database = db }: AgentRunStoreDependencies = {},
): Promise<boolean> {
  return Boolean(await database('notification_events').where({ deduplication_key: deduplicationKey }).first('event_id'));
}
