import {
  AUTOMATION_UNPRODUCTIVE_RUN_THRESHOLD_SETTING,
  DEFAULT_AUTOMATION_UNPRODUCTIVE_RUN_THRESHOLD,
  automationRunNoChangeReason,
  isAutomationUnproductiveRunThreshold,
} from '@propr/shared';
import type { Knex } from 'knex';
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
/**
 * Rows a streak walk reads at most. A streak longer than this lists only the
 * runs read; its identity comes from `findProductivePredecessor` instead.
 */
const STREAK_SCAN_LIMIT = 1000;

type RunKey = Pick<AgentRunRow, 'created_at' | 'id'>;

function olderThan(query: Knex.QueryBuilder, after: RunKey | null): void {
  // Keyset paging: a run created while the walk is under way cannot shift a page.
  if (after) query.where(older => older.where('created_at', '<', after.created_at)
    .orWhere(tied => tied.where('created_at', after.created_at).andWhere('id', '<', after.id)));
}

/**
 * The newest productive scheduled run older than `before`, or `start`. The SQL
 * form of `agentRunProductivity(run) === 'productive'`: a positive acting
 * count, or no acting count and a new report once no acting step can still run.
 * It lets a streak longer than the scan keep the identity it had while shorter.
 */
async function findProductivePredecessor(database: Knex, definitionId: string, before: RunKey): Promise<string> {
  const row = await database('agent_runs').where({ definition_id: definitionId, trigger: 'schedule' })
    .where(productive => productive.where('acting_mutations', '>', 0)
      .orWhere(reported => reported.whereNull('acting_mutations').andWhere('report_novelty', 'new')
        .whereNotIn('state', [...UNDECIDED_STATES])))
    .modify(query => olderThan(query, before))
    .orderBy([{ column: 'created_at', order: 'desc' }, { column: 'id', order: 'desc' }])
    .first<{ id: string } | undefined>('id');
  return row?.id ?? 'start';
}

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
      .modify(page => olderThan(page, after))
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
  // The scan ran out before the streak did: its identity must not follow the moving scan boundary.
  breaker ??= oldestRead ? await findProductivePredecessor(database, definitionId, oldestRead) : 'start';
  return { runs, reachedThreshold: runs.length >= limit, streakKey: breaker };
}

/** The stored unproductive-streak Inbox item: whether it told the owner the schedule was paused. */
export interface StoredUnproductiveStreakNotification {
  schedulePaused: boolean;
}

/** The persisted Inbox item with this deduplication key, or null while none is stored. */
export async function findUnproductiveStreakNotification(
  deduplicationKey: string,
  { database = db }: AgentRunStoreDependencies = {},
): Promise<StoredUnproductiveStreakNotification | null> {
  const row = await database('notification_events').where({ deduplication_key: deduplicationKey })
    .first<{ metadata_json: string | null } | undefined>('metadata_json');
  if (!row) return null;
  let metadata: unknown = null;
  try { metadata = row.metadata_json ? JSON.parse(row.metadata_json) : null; } catch { metadata = null; }
  const schedulePaused = typeof metadata === 'object' && metadata !== null
    && (metadata as { schedulePaused?: unknown }).schedulePaused === true;
  return { schedulePaused };
}

/**
 * `disabled` turned the schedule off; `already_off` found it off; `done_before`
 * found this streak's pause already carried out; `opted_out` found the
 * definition no longer set to pause when unproductive, and changed nothing.
 */
export type UnproductiveStreakPauseResult = 'disabled' | 'already_off' | 'done_before' | 'opted_out';

/**
 * Turns the schedule off for one streak and records that streak's pause in the
 * same transaction. The record is what separates a pause still owed from one
 * already made: once it is stored, an owner who turns the schedule back on is
 * not overridden by later runs of the same streak. The opt-in is read inside
 * the transaction, not taken from the caller: an owner who turns
 * `pauseWhenUnproductive` off while the evaluation is under way (say, while the
 * Inbox item is delivered) is respected. Like `disableAgentDefinitionSchedule`,
 * the schedule change counts as an edit.
 */
export async function pauseScheduleForUnproductiveStreak(
  definitionId: string,
  streakDeduplicationKey: string,
  { database = db, now = Date.now }: AgentRunStoreDependencies = {},
): Promise<UnproductiveStreakPauseResult> {
  return database.transaction(async trx => {
    // A conditional write, so of two concurrent evaluations only one carries out the pause,
    // and only while the definition still opts in.
    const claimed = await trx('agent_definitions').where({ id: definitionId, pause_when_unproductive: true })
      .where(owed => owed.whereNull('unproductive_paused_streak').orWhereNot('unproductive_paused_streak', streakDeduplicationKey))
      .update({ unproductive_paused_streak: streakDeduplicationKey });
    if (Number(claimed) === 0) {
      const current = await trx('agent_definitions').where({ id: definitionId })
        .first<{ pause_when_unproductive: boolean | number | null; unproductive_paused_streak: string | null } | undefined>(
          'pause_when_unproductive', 'unproductive_paused_streak');
      // A pause already made stays recorded as made, whatever the opt-in says now.
      if (current?.unproductive_paused_streak === streakDeduplicationKey) return 'done_before';
      return current && !current.pause_when_unproductive ? 'opted_out' : 'done_before';
    }
    await trx('agent_definitions').where({ id: definitionId }).whereNotNull('pending_schedule_slot')
      .update({ pending_schedule_slot: null, pending_schedule_attempted_at: null });
    const updated = await trx('agent_definitions').where({ id: definitionId, schedule_enabled: true })
      .update({ schedule_enabled: false, next_run_at: null, revision: trx.raw('revision + 1'), updated_at: now() });
    return Number(updated) > 0 ? 'disabled' : 'already_off';
  });
}

/** True when an Inbox item with this deduplication key was persisted. */
export async function hasNotificationEvent(
  deduplicationKey: string,
  { database = db }: AgentRunStoreDependencies = {},
): Promise<boolean> {
  return Boolean(await database('notification_events').where({ deduplication_key: deduplicationKey }).first('event_id'));
}
