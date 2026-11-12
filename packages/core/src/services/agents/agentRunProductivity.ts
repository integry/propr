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
 * step can still run and no claimed step's count is still outstanding: a run
 * another writer cancelled or failed while its step held the grant waits for
 * that step's worker to settle the count. `pending` runs neither extend nor
 * break a streak.
 */
export function agentRunProductivity(
  run: Pick<StoredAgentRun, 'state' | 'reportNovelty' | 'actingMutations'> & Partial<Pick<StoredAgentRun, 'actingMutationsPending'>>,
): AgentRunProductivity {
  if (run.actingMutations == null
    && (run.reportNovelty == null || UNDECIDED_STATES.has(run.state) || run.actingMutationsPending === true)) return 'pending';
  return automationRunNoChangeReason(run) ? 'unproductive' : 'productive';
}

/**
 * Settles the mutation count of an acting step whose run another writer ended
 * (a cancel, or a redelivery that took the step for abandoned) while the step
 * still held its MCP grant: a known count is stored, an unknown one (null; the
 * revoke failed, or no grant was issued) only ends the outstanding mark. Only
 * onto the run the step claimed, once it has failed or been cancelled, and
 * never over a count already stored. Returns the updated run, or null when no
 * such run matched (nothing changed, so nothing new to evaluate).
 */
export async function recordAgentRunActingMutations(
  id: string,
  { actionTaskId, actingMutations }: { actionTaskId: string; actingMutations: number | null },
  { database = db, now = Date.now }: AgentRunStoreDependencies = {},
): Promise<StoredAgentRun | null> {
  const [updated] = await database('agent_runs').where({ id, action_task_id: actionTaskId }).whereIn('state', ['failed', 'cancelled'])
    .whereNull('acting_mutations')
    .modify(query => { if (actingMutations === null) query.where('acting_mutations_pending', true); })
    .update({ acting_mutations: actingMutations, acting_mutations_pending: false, updated_at: now() })
    .returning('*') as AgentRunRow[];
  return updated ? rowToAgentRun(updated) : null;
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
 * The SQL form of `agentRunProductivity(run) !== 'pending'`: a known acting count,
 * or a report novelty once no acting step can still run and no claimed step's
 * count is outstanding. Filtered before the scan limit, so pending runs (say,
 * many awaiting approval) cannot use up the scan.
 */
function decided(query: Knex.QueryBuilder): void {
  query.where(known => known.whereNotNull('acting_mutations')
    .orWhere(reported => reported.whereNotNull('report_novelty').whereNotIn('state', [...UNDECIDED_STATES])
      .where('acting_mutations_pending', false)));
}

/**
 * The newest productive scheduled run older than `before`, or `start`. The SQL
 * form of `agentRunProductivity(run) === 'productive'`: a positive acting
 * count, or no acting count and a new report once no acting step can still run.
 * It lets a streak longer than the scan keep the identity it had while shorter.
 */
async function findProductivePredecessor(database: Knex, definitionId: string, before: RunKey): Promise<string> {
  const row = await database('agent_runs').where({ definition_id: definitionId, trigger: 'schedule' })
    .modify(decided)
    .where(productive => productive.where('acting_mutations', '>', 0)
      .orWhere(reported => reported.whereNull('acting_mutations').andWhere('report_novelty', 'new')))
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
 * first. Pending runs are left out of the query, so they neither use up the
 * scan nor end the streak; the first productive run ends it. A run whose report
 * could not be compared still counts through its acting step.
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
      .modify(decided)
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

/**
 * The stored unproductive-streak Inbox item. `pauseIntended` is the recovery intent:
 * the item told the owner the schedule is set to be paused, so a pause that failed or
 * was interrupted after it was stored is still owed. It says nothing about whether the
 * pause was made; that is recorded with the schedule change (`unproductive_paused_streak`).
 */
export interface StoredUnproductiveStreakNotification {
  pauseIntended: boolean;
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
  const pauseIntended = typeof metadata === 'object' && metadata !== null
    && (metadata as { pauseIntended?: unknown }).pauseIntended === true;
  return { pauseIntended };
}

/**
 * `disabled` turned the schedule off; `already_off` found it off; `done_before`
 * found this streak's pause already carried out; `opted_out` found the
 * definition no longer set to pause when unproductive, and changed nothing;
 * `streak_ended` found the streak no longer current (a newer scheduled run
 * turned out productive, so it is not the definition's streak any more), and
 * changed nothing.
 */
export type UnproductiveStreakPauseResult = 'disabled' | 'already_off' | 'done_before' | 'opted_out' | 'streak_ended';

/** The streak an evaluation decided to pause for. */
export interface UnproductiveStreakPause {
  /** The streak's Inbox deduplication key, recorded as the pause made. */
  deduplicationKey: string;
  /** The streak's identity when the evaluation found it (`UnproductiveStreak.streakKey`). */
  streakKey: string;
  /** The threshold the evaluation found the streak to have reached. */
  threshold: number;
}

/** Rolls back the claimed pause when the streak is no longer current. */
class StreakEndedBeforePause extends Error {}

/**
 * Turns the schedule off for one streak and records that streak's pause in the
 * same transaction. The record is what separates a pause still owed from one
 * already made: once it is stored, an owner who turns the schedule back on is
 * not overridden by later runs of the same streak. The opt-in is read inside
 * the transaction, not taken from the caller: an owner who turns
 * `pauseWhenUnproductive` off while the evaluation is under way (say, while the
 * Inbox item is delivered) is respected. The streak is read again inside the
 * transaction too: a newer scheduled run that turned out productive meanwhile
 * (an acting step that was still running when the streak was found) ends the
 * streak, and the schedule is kept. Like `disableAgentDefinitionSchedule`, the
 * schedule change counts as an edit.
 */
export async function pauseScheduleForUnproductiveStreak(
  definitionId: string,
  { deduplicationKey, streakKey, threshold }: UnproductiveStreakPause,
  { database = db, now = Date.now }: AgentRunStoreDependencies = {},
): Promise<UnproductiveStreakPauseResult> {
  try {
    return await database.transaction(async trx => {
      // A conditional write, so of two concurrent evaluations only one carries out the pause,
      // and only while the definition still opts in. Being the transaction's first statement,
      // it also takes SQLite's single write lock: no run can change from here to the commit.
      const claimed = await trx('agent_definitions').where({ id: definitionId, pause_when_unproductive: true })
        .where(owed => owed.whereNull('unproductive_paused_streak').orWhereNot('unproductive_paused_streak', deduplicationKey))
        .update({ unproductive_paused_streak: deduplicationKey });
      if (Number(claimed) === 0) {
        const current = await trx('agent_definitions').where({ id: definitionId })
          .first<{ pause_when_unproductive: boolean | number | null; unproductive_paused_streak: string | null } | undefined>(
            'pause_when_unproductive', 'unproductive_paused_streak');
        // A pause already made stays recorded as made, whatever the opt-in says now.
        if (current?.unproductive_paused_streak === deduplicationKey) return 'done_before';
        return current && !current.pause_when_unproductive ? 'opted_out' : 'done_before';
      }
      // Read under that lock, so a run completing productively either committed before this
      // read (and is seen) or waits until the pause is committed.
      const streak = await findUnproductiveScheduledStreak(definitionId, threshold, { database: trx });
      if (streak.streakKey !== streakKey || !streak.reachedThreshold) throw new StreakEndedBeforePause();
      await trx('agent_definitions').where({ id: definitionId }).whereNotNull('pending_schedule_slot')
        .update({ pending_schedule_slot: null, pending_schedule_attempted_at: null });
      const updated = await trx('agent_definitions').where({ id: definitionId, schedule_enabled: true })
        .update({ schedule_enabled: false, next_run_at: null, revision: trx.raw('revision + 1'), updated_at: now() });
      return Number(updated) > 0 ? 'disabled' : 'already_off';
    });
  } catch (error) {
    // The claim is rolled back with the transaction: the streak's pause stays unmade.
    if (error instanceof StreakEndedBeforePause) return 'streak_ended';
    throw error;
  }
}

/** True when an Inbox item with this deduplication key was persisted. */
export async function hasNotificationEvent(
  deduplicationKey: string,
  { database = db }: AgentRunStoreDependencies = {},
): Promise<boolean> {
  return Boolean(await database('notification_events').where({ deduplication_key: deduplicationKey }).first('event_id'));
}
