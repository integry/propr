/**
 * Tells an automation's owner when its scheduled runs keep producing nothing:
 * after `automation_unproductive_run_threshold` consecutive unproductive
 * scheduled runs (an empty or unchanged report, or an acting step that changed
 * nothing), one Inbox item names the automation. It is not repeated while the
 * streak goes on; a productive scheduled run resets it. With the definition's
 * `pauseWhenUnproductive` flag the schedule is turned off at the same moment.
 * The stored Inbox item is the evidence that the owner was told: until it is
 * persisted, every later evaluation of the same streak tries again.
 *
 * Runs still complete as before: this only reads the flags stored on them.
 * Manual and other non-scheduled runs are flagged but never counted.
 */

import {
    agentRunProductivity,
    createNotificationEvent,
    disableAgentDefinitionSchedule,
    findUnproductiveScheduledStreak,
    getAgentDefinition,
    hasNotificationEvent,
    loadUnproductiveRunThreshold,
    logger,
    type StoredAgentDefinition,
    type StoredAgentRun,
} from '@propr/core';
import { AUTOMATION_RUN_NO_CHANGE_LABELS, automationRunNoChangeReason } from '@propr/shared';

export interface UnproductiveStreakDeps {
    loadThreshold?: () => Promise<number>;
    findStreak?: typeof findUnproductiveScheduledStreak;
    getDefinition?: (definitionId: string, ownerId: string) => Promise<StoredAgentDefinition | undefined>;
    disableSchedule?: (definitionId: string) => Promise<boolean>;
    createEvent?: typeof createNotificationEvent;
    /** Whether the streak's Inbox item was already persisted. */
    hasNotification?: (deduplicationKey: string) => Promise<boolean>;
}

export type UnproductiveStreakOutcome = 'notified' | 'paused' | null;

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

function streakBody(runs: readonly StoredAgentRun[], paused: boolean): string {
    const reasons = [...new Set(runs.map(run => automationRunNoChangeReason(run)).filter(reason => reason !== null))]
        .map(reason => AUTOMATION_RUN_NO_CHANGE_LABELS[reason].toLowerCase());
    const detail = reasons.length > 0 ? ` (${reasons.join('; ')})` : '';
    const tail = paused
        ? 'Its schedule has been paused; review the prompt and turn the schedule back on when it should run again.'
        : 'Check whether its prompt or schedule still make sense. You will not be told again until a scheduled run produces something.';
    return `The last ${runs.length} scheduled runs produced nothing new${detail}. ${tail}`;
}

async function pauseSchedule(run: StoredAgentRun, reason: string, disableSchedule: (definitionId: string) => Promise<boolean>): Promise<void> {
    const disabled = await disableSchedule(run.definitionId);
    logger.warn({ definitionId: run.definitionId, ownerId: run.ownerId, decision: 'schedule_disabled', reason, disabled },
        'Paused unproductive automation schedule');
}

/** One Inbox item per streak, keyed by the streak's stable identity. */
export function unproductiveStreakDeduplicationKey(definitionId: string, streakKey: string): string {
    return `automation-unproductive:${definitionId}:after:${streakKey}`;
}

const defaultStreakDeps: Required<UnproductiveStreakDeps> = {
    loadThreshold: () => loadUnproductiveRunThreshold(),
    findStreak: findUnproductiveScheduledStreak,
    getDefinition: (definitionId, ownerId) => getAgentDefinition(definitionId, ownerId),
    disableSchedule: definitionId => disableAgentDefinitionSchedule(definitionId),
    createEvent: createNotificationEvent,
    hasNotification: deduplicationKey => hasNotificationEvent(deduplicationKey),
};

/**
 * Called once a run's flags are final (report stored, acting step finished,
 * acting step rejected).
 * Best effort for the caller: errors propagate, and the caller logs them.
 */
export async function evaluateUnproductiveStreak(run: StoredAgentRun, overrides: UnproductiveStreakDeps = {}): Promise<UnproductiveStreakOutcome> {
    const { loadThreshold, findStreak, getDefinition, disableSchedule, createEvent, hasNotification } = {
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
    if (await hasNotification(deduplicationKey)) return null;

    const definition = await getDefinition(run.definitionId, run.ownerId) ?? null;
    const name = definition?.name ?? run.definitionSnapshot?.name ?? 'Automation';
    const pause = definition?.pauseWhenUnproductive === true;
    const { kind, target } = notificationTarget(run, definition);
    await createEvent({
        deduplicationKey,
        kind,
        severity: 'warning',
        target,
        title: pause ? `Automation ${name} paused: no change in ${streak.runs.length} runs` : `Automation ${name} keeps producing no change`,
        body: streakBody(streak.runs, pause),
        action: { type: 'navigate', label: 'Open automation', href: `/automations/${encodeURIComponent(run.definitionId)}` },
        metadata: {
            event: 'automation.unproductive_streak',
            agentDefinitionId: run.definitionId,
            agentRunId: run.id,
            streakRunIds: streak.runs.slice(0, threshold).map(member => member.id),
            schedulePaused: pause,
        },
    } as Parameters<typeof createNotificationEvent>[0], [{ userId: run.ownerId, pushEnabled: true }]);
    // Paused only once the owner is told: a paused schedule has no later run to retry a lost item.
    if (pause) await pauseSchedule(run, unproductivePauseReason(name, streak.runs.length), disableSchedule);
    return pause ? 'paused' : 'notified';
}

/** Never lets a lost Inbox item or a failed read change how the run itself ended. */
export async function evaluateUnproductiveStreakQuietly(run: StoredAgentRun | null, deps?: UnproductiveStreakDeps): Promise<void> {
    if (!run) return;
    await evaluateUnproductiveStreak(run, deps).catch(error => {
        logger.warn({ runId: run.id, definitionId: run.definitionId, err: error }, 'Could not evaluate the unproductive-run streak');
    });
}
