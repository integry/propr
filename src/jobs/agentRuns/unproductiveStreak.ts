/**
 * Tells an automation's owner when its scheduled runs keep producing nothing:
 * after `automation_unproductive_run_threshold` consecutive unproductive
 * scheduled runs (an empty or unchanged report, or an acting step that changed
 * nothing), one Inbox item names the automation. It is not repeated while the
 * streak goes on; a productive scheduled run resets it. With the definition's
 * `pauseWhenUnproductive` flag the schedule is turned off at the same moment.
 * The stored Inbox item is the evidence that the owner was told: until it is
 * persisted, every later evaluation of the same streak tries again. The pause
 * has its own evidence, recorded with the schedule change: an item that says
 * the schedule is set to be paused does not stop a later run from finishing a
 * pause that failed or was interrupted, and a pause once made is never repeated.
 * The opt-in and the streak itself are rechecked where the schedule is
 * changed, so turning pausing off, or a newer scheduled run turning out
 * productive, at any point before then keeps the schedule on.
 *
 * Inbox items are immutable, and the streak's item is stored before the pause
 * is tried, so it states only the intended pause, in words that stay true
 * whether the pause is made, refused or fails. Only the evaluation that turned
 * the schedule off says it was paused, in a second, Inbox-only item.
 *
 * Runs still complete as before: this only reads the flags stored on them.
 * Manual and other non-scheduled runs are flagged but never counted.
 */

import {
    agentRunProductivity,
    createNotificationEvent,
    findUnproductiveScheduledStreak,
    findUnproductiveStreakNotification,
    getAgentDefinition,
    loadUnproductiveRunThreshold,
    logger,
    pauseScheduleForUnproductiveStreak,
    type StoredUnproductiveStreakNotification,
    type UnproductiveStreakPause,
    type UnproductiveStreakPauseResult,
    type StoredAgentDefinition,
    type StoredAgentRun,
} from '@propr/core';
import { AUTOMATION_RUN_NO_CHANGE_LABELS, automationRunNoChangeReason } from '@propr/shared';

export interface UnproductiveStreakDeps {
    loadThreshold?: () => Promise<number>;
    findStreak?: typeof findUnproductiveScheduledStreak;
    getDefinition?: (definitionId: string, ownerId: string) => Promise<StoredAgentDefinition | undefined>;
    /**
     * Turns the schedule off and records that this streak's pause was made, in one
     * transaction, only while the definition opts in and the streak is still current.
     */
    pauseSchedule?: (definitionId: string, pause: UnproductiveStreakPause) => Promise<UnproductiveStreakPauseResult>;
    createEvent?: typeof createNotificationEvent;
    /** The streak's persisted Inbox item, or null while none is stored. */
    findNotification?: (deduplicationKey: string) => Promise<StoredUnproductiveStreakNotification | null>;
}

export type UnproductiveStreakOutcome = 'notified' | 'paused' | null;

interface StreakNotice {
    deduplicationKey: string;
    streakKey: string;
    threshold: number;
    runs: readonly StoredAgentRun[];
    name: string;
}

const REPOSITORY_PATTERN = /^[^/\s]+\/[^/\s]+$/;

/** Why the schedule was turned off; logged and repeated in the Inbox item. */
export function unproductivePauseReason(name: string, count: number): string {
    return `Automation ${name} produced nothing new in ${count} consecutive scheduled runs, and it is set to pause its schedule when that happens`;
}

function notificationTarget(run: StoredAgentRun, definition: StoredAgentDefinition | null) {
    const repository = (definition?.repositories ?? run.definitionSnapshot?.repositories ?? [])[0];
    if (repository && REPOSITORY_PATTERN.test(repository) && run.reportTaskId) {
        return { kind: 'task' as const, target: { type: 'task' as const, repository, taskId: run.reportTaskId } };
    }
    // A repository-free automation has no task target; the Inbox still needs a destination.
    return { kind: 'system_failure' as const, target: { type: 'system_failure' as const, component: 'automations', correlationId: run.definitionId } };
}

function noChangeDetail(runs: readonly StoredAgentRun[]): string {
    const reasons = [...new Set(runs.map(run => automationRunNoChangeReason(run)).filter(reason => reason !== null))]
        .map(reason => AUTOMATION_RUN_NO_CHANGE_LABELS[reason].toLowerCase());
    return reasons.length > 0 ? ` (${reasons.join('; ')})` : '';
}

/**
 * The streak item's text. With pausing on it is stored before the pause is tried
 * and never changes, so it describes the pause as intended, with the two things
 * that keep the schedule on, and never as made.
 */
function streakBody(runs: readonly StoredAgentRun[], pauseIntended: boolean): string {
    const tail = pauseIntended
        ? 'It is set to pause its schedule when this happens, so the schedule will be turned off unless pausing is turned off or a newer scheduled run produces something first. Check whether its prompt still makes sense.'
        : 'Check whether its prompt or schedule still make sense. You will not be told again until a scheduled run produces something.';
    return `The last ${runs.length} scheduled runs produced nothing new${noChangeDetail(runs)}. ${tail}`;
}

/** The paused item's own key, so it never takes the place of the streak's item. */
export function unproductivePauseDeduplicationKey(definitionId: string, streakKey: string): string {
    return `automation-unproductive-paused:${definitionId}:after:${streakKey}`;
}

/**
 * Says the schedule was paused, once this evaluation's pause turned it off. The owner
 * was already told about the streak (with a push), so this item only lands in the
 * Inbox. It is not retried: the streak item stays true without it, and a late one
 * could arrive after the owner had turned the schedule back on.
 */
async function announcePause(
    run: StoredAgentRun,
    definition: StoredAgentDefinition | null,
    notice: StreakNotice,
    createEvent: Required<UnproductiveStreakDeps>['createEvent'],
): Promise<void> {
    const { kind, target } = notificationTarget(run, definition);
    const count = notice.runs.length;
    await createEvent({
        deduplicationKey: unproductivePauseDeduplicationKey(run.definitionId, notice.streakKey),
        kind,
        severity: 'warning',
        target,
        title: `Automation ${notice.name} paused: no change in ${count} runs`,
        body: `Its schedule was paused after ${count} consecutive scheduled runs produced nothing new${noChangeDetail(notice.runs)}. Review the prompt and turn the schedule back on when it should run again.`,
        action: { type: 'navigate', label: 'Open automation', href: `/automations/${encodeURIComponent(run.definitionId)}` },
        metadata: {
            event: 'automation.unproductive_streak_paused',
            agentDefinitionId: run.definitionId,
            agentRunId: run.id,
            streakDeduplicationKey: notice.deduplicationKey,
            streakRunIds: notice.runs.slice(0, notice.threshold).map(member => member.id),
            schedulePaused: true,
        },
    } as Parameters<typeof createNotificationEvent>[0], [{ userId: run.ownerId, pushEnabled: false }]).catch(error => {
        logger.warn({ definitionId: run.definitionId, runId: run.id, err: error },
            'Paused unproductive automation schedule, but could not store the Inbox item saying so');
    });
}

async function carryOutPause(
    run: StoredAgentRun,
    definition: StoredAgentDefinition | null,
    notice: StreakNotice,
    { pauseSchedule, createEvent }: Pick<Required<UnproductiveStreakDeps>, 'pauseSchedule' | 'createEvent'>,
): Promise<UnproductiveStreakPauseResult> {
    const { deduplicationKey, streakKey, threshold } = notice;
    const reason = unproductivePauseReason(notice.name, notice.runs.length);
    const result = await pauseSchedule(run.definitionId, { deduplicationKey, streakKey, threshold });
    if (result === 'opted_out') {
        logger.info({ definitionId: run.definitionId, ownerId: run.ownerId, decision: 'schedule_kept' },
            'Did not pause unproductive automation schedule: the owner turned pausing off');
    } else if (result === 'streak_ended') {
        logger.info({ definitionId: run.definitionId, ownerId: run.ownerId, decision: 'schedule_kept' },
            'Did not pause unproductive automation schedule: a newer scheduled run ended the streak');
    } else if (result !== 'done_before') {
        logger.warn({ definitionId: run.definitionId, ownerId: run.ownerId, decision: 'schedule_disabled', reason, disabled: result === 'disabled' },
            'Paused unproductive automation schedule');
    }
    // Only a schedule this pause turned off is reported as paused: one already off, or
    // paused by another evaluation (which reports it), was not paused by this one.
    if (result === 'disabled') await announcePause(run, definition, notice, createEvent);
    return result;
}

/**
 * The outcome of a pause attempt. After a new item, a pause another evaluation
 * already made still leaves the schedule paused; finishing a stored item's pause
 * reports only a pause made now. Either way an owner who opted out, or a streak a
 * newer productive run ended, keeps the schedule.
 */
const OUTCOME_AFTER_NEW_ITEM: Record<UnproductiveStreakPauseResult, UnproductiveStreakOutcome> = {
    disabled: 'paused', already_off: 'paused', done_before: 'paused', opted_out: 'notified', streak_ended: 'notified',
};
const OUTCOME_AFTER_STORED_ITEM: Record<UnproductiveStreakPauseResult, UnproductiveStreakOutcome> = {
    disabled: 'paused', already_off: 'paused', done_before: null, opted_out: null, streak_ended: null,
};

/** One Inbox item per streak, keyed by the streak's stable identity. */
export function unproductiveStreakDeduplicationKey(definitionId: string, streakKey: string): string {
    return `automation-unproductive:${definitionId}:after:${streakKey}`;
}

const defaultStreakDeps: Required<UnproductiveStreakDeps> = {
    loadThreshold: () => loadUnproductiveRunThreshold(),
    findStreak: findUnproductiveScheduledStreak,
    getDefinition: (definitionId, ownerId) => getAgentDefinition(definitionId, ownerId),
    pauseSchedule: (definitionId, pause) => pauseScheduleForUnproductiveStreak(definitionId, pause),
    createEvent: createNotificationEvent,
    findNotification: deduplicationKey => findUnproductiveStreakNotification(deduplicationKey),
};

/**
 * Called once a run's flags are final: the report stored and the run ended
 * without an acting step, the acting step finished (completed, failed or
 * cancelled, with its count), the acting step rejected, or the run cancelled by
 * its owner (say, while awaiting approval). A run that failed or
 * was cancelled is evaluated too: `agentRunProductivity` gives it a verdict, so
 * the streak finder counts it, and a streak it brings to the threshold must not
 * wait for some later run to complete.
 * Best effort for the caller: errors propagate, and the caller logs them.
 */
export async function evaluateUnproductiveStreak(run: StoredAgentRun, overrides: UnproductiveStreakDeps = {}): Promise<UnproductiveStreakOutcome> {
    const { loadThreshold, findStreak, getDefinition, pauseSchedule, createEvent, findNotification } = {
        ...defaultStreakDeps,
        // An override left undefined keeps its default, as a destructuring default would.
        ...Object.fromEntries(Object.entries(overrides).filter(([, value]) => value !== undefined)),
    } as Required<UnproductiveStreakDeps>;
    if (run.trigger !== 'schedule' || agentRunProductivity(run) !== 'unproductive') return null;
    const threshold = await loadThreshold();
    const streak = await findStreak(run.definitionId, threshold);
    if (!streak.reachedThreshold || !streak.runs.some(member => member.id === run.id)) return null;
    // Any run of a streak at or past the threshold speaks until the item is stored,
    // so a failed write is retried by the next run; a stored one is never repeated.
    const deduplicationKey = unproductiveStreakDeduplicationKey(run.definitionId, streak.streakKey);
    const stored = await findNotification(deduplicationKey);
    if (stored && !stored.pauseIntended) return null;

    const definition = await getDefinition(run.definitionId, run.ownerId) ?? null;
    const name = definition?.name ?? run.definitionSnapshot?.name ?? 'Automation';
    const pause = definition?.pauseWhenUnproductive === true;
    // The pause is made only for this streak, still current and at this threshold when it is committed.
    const notice: StreakNotice = { deduplicationKey, streakKey: streak.streakKey, threshold, runs: streak.runs, name };
    const pausing = { pauseSchedule, createEvent };
    if (stored) {
        // The owner was told the schedule is set to be paused. Finish a pause that failed or was
        // interrupted after the item was stored, unless the owner has since turned pausing off;
        // a pause already made is not repeated, so a schedule turned back on stays on.
        if (!pause) return null;
        return OUTCOME_AFTER_STORED_ITEM[await carryOutPause(run, definition, notice, pausing)];
    }
    const { kind, target } = notificationTarget(run, definition);
    await createEvent({
        deduplicationKey,
        kind,
        severity: 'warning',
        target,
        title: `Automation ${name} keeps producing no change`,
        body: streakBody(streak.runs, pause),
        action: { type: 'navigate', label: 'Open automation', href: `/automations/${encodeURIComponent(run.definitionId)}` },
        metadata: {
            event: 'automation.unproductive_streak',
            agentDefinitionId: run.definitionId,
            agentRunId: run.id,
            streakRunIds: streak.runs.slice(0, threshold).map(member => member.id),
            // Recovery intent only: whether a pause is owed, never whether it was made.
            pauseIntended: pause,
        },
    } as Parameters<typeof createNotificationEvent>[0], [{ userId: run.ownerId, pushEnabled: true }]);
    // Paused only once the owner is told: a paused schedule has no later run to retry a lost item.
    // A pause that fails here is retried by the next run of the streak (see above). `pause` was
    // read before the item was delivered, and the streak found before that; the pause itself
    // rechecks both, so an owner who turned pausing off meanwhile, or a newer scheduled run
    // that turned out productive meanwhile, keeps the schedule.
    if (!pause) return 'notified';
    return OUTCOME_AFTER_NEW_ITEM[await carryOutPause(run, definition, notice, pausing)];
}

/** Never lets a lost Inbox item or a failed read change how the run itself ended. */
export async function evaluateUnproductiveStreakQuietly(run: StoredAgentRun | null, deps?: UnproductiveStreakDeps): Promise<void> {
    if (!run) return;
    await evaluateUnproductiveStreak(run, deps).catch(error => {
        logger.warn({ runId: run.id, definitionId: run.definitionId, err: error }, 'Could not evaluate the unproductive-run streak');
    });
}
