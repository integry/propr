import type { Knex } from 'knex';
import {
    MAX_AUTOMATION_EVENT_RUNS_PER_ISSUE,
    automationEventTriggerMatches,
    type AutomationEventTrigger,
    type AutomationTriggerEvent,
} from '@propr/shared';
import {
    AgentRunTriggerError,
    advanceAgentDefinitionEventCursor,
    countAgentRunsForTriggerSubject,
    createAgentRunCostGate,
    db,
    enqueueAgentRunPhase,
    getAgentDefinitionEventCursor,
    getAgentRunByIdempotencyKey,
    initializeAgentDefinitionEventCursor,
    listEventSubscribedAgentDefinitionIds,
    listPlanIssueBlockedEventsAfter,
    logger,
    recordSkippedRun,
    rowToAgentDefinition,
    triggerAgentRun,
    type AgentDefinitionRow,
    type AgentRunEnqueue,
    type AgentRunGate,
    type PlanIssueBlockedEventRecord,
    type StoredAgentDefinition,
    type TriggerAgentRunInput,
    type TriggerAgentRunResult,
} from '@propr/core';

/**
 * The event-trigger sweep: starts automation runs for durable events that subscribed,
 * enabled definitions match. It runs in the daemon next to the schedule sweep and reads the
 * event record with a cursor per definition, so the queue write that recorded the event
 * never depends on automation code.
 *
 * - At most one run per event and definition: the run's idempotency key is the event id,
 *   and the cursor only moves past an event once its run (or the reason it did not run) is
 *   recorded. A restart or a repeated delivery replays the same receipt.
 * - Events from before a subscription, or from while the definition was disabled, are not
 *   run: the cursor jumps to the newest event when the definition subscribes or is enabled.
 * - Every run goes through `triggerAgentRun` as an unattended `event` run, so the cost gate,
 *   the definition's autonomy, capabilities and grants apply exactly as for a schedule.
 * - Loop bound: after `MAX_AUTOMATION_EVENT_RUNS_PER_ISSUE` event runs of a definition for the
 *   same issue of the same plan, later events for that issue are recorded as skipped runs.
 */

export const AGENT_EVENT_TRIGGER_BATCH_SIZE = 50;
const DEFINITION_PAGE_SIZE = 100;
const EVENT_IDEMPOTENCY_PREFIX = 'event:plan.issue_blocked:';
/** Blocker reasons are short; a longer one is cut so the run input and its receipts stay small. */
export const TRIGGER_EVENT_REASON_MAX_CHARS = 4_000;

export interface AgentEventTriggerSweepDependencies {
    database?: Knex;
    now?: () => number;
    trigger?: (input: TriggerAgentRunInput) => Promise<TriggerAgentRunResult>;
    enqueue?: AgentRunEnqueue;
    gate?: AgentRunGate;
    isMember?: (ownerId: string) => Promise<boolean>;
    batchSize?: number;
    /** Base URL of the web UI for plan links. */
    frontendUrl?: string;
}

export interface AgentEventTriggerSweepResult {
    /** Runs created, whatever state the gate left them in. */
    created: number;
    /** Events whose run already existed (a replay after a restart or a repeated delivery). */
    existing: number;
    /** Runs recorded as skipped: the loop bound, or a definition that no longer validates. */
    skipped: number;
    /** Events the definition's subscription did not match. */
    unmatched: number;
    failed: number;
}

type EventOutcome = Exclude<keyof AgentEventTriggerSweepResult, 'failed'>;

interface SweepContext {
    database: Knex;
    clock: () => number;
    trigger: NonNullable<AgentEventTriggerSweepDependencies['trigger']>;
    gate: AgentRunGate;
    isMember: (ownerId: string) => Promise<boolean>;
    dispatch: (run: TriggerAgentRunResult['run']) => Promise<unknown>;
    batchSize: number;
    frontendUrl: string;
}

function defaultFrontendUrl(): string {
    return (process.env.FRONTEND_URL || process.env.WEB_UI_URL || 'http://localhost:5173').replace(/\/+$/, '');
}

/** The input an event run receives. */
export function planIssueBlockedTriggerEvent(event: PlanIssueBlockedEventRecord & { repository: string }, frontendUrl: string): AutomationTriggerEvent {
    return {
        type: 'plan.issue_blocked',
        eventId: event.id,
        repository: event.repository,
        planId: event.draftId,
        planName: event.planName,
        executionId: event.executionId,
        issueNumber: event.issueNumber,
        reasonKind: event.blockedKind,
        reason: event.reason.length > TRIGGER_EVENT_REASON_MAX_CHARS ? `${event.reason.slice(0, TRIGGER_EVENT_REASON_MAX_CHARS)}…` : event.reason,
        planUrl: `${frontendUrl}/studio/${encodeURIComponent(event.draftId)}`,
        issueUrl: `https://github.com/${event.repository}/issues/${event.issueNumber}`,
        occurredAt: event.createdAt,
    };
}

/** The issue an event concerns; runs per definition and subject are bounded. */
export function planIssueTriggerSubject(event: Pick<PlanIssueBlockedEventRecord, 'draftId' | 'issueNumber'>): string {
    return `plan.issue_blocked:${event.draftId}:${event.issueNumber}`;
}

async function readDefinition(id: string, database: Knex): Promise<StoredAgentDefinition | null> {
    const row = await database('agent_definitions').where({ id }).first<AgentDefinitionRow | undefined>();
    return row ? rowToAgentDefinition(row) : null;
}

async function recordSkipped(
    definition: StoredAgentDefinition,
    run: Pick<TriggerAgentRunInput, 'triggerSource' | 'idempotencyKey' | 'triggerEvent' | 'triggerSubject'>,
    skipReason: string,
    context: SweepContext,
): Promise<EventOutcome> {
    const { created } = await recordSkippedRun({ definition, trigger: 'event', ...run, skipReason },
        { database: context.database, now: context.clock });
    return created ? 'skipped' : 'existing';
}

/** Starts (or replays) the run for one event. Throws when it should be retried on the next sweep. */
async function fireEvent(
    definition: StoredAgentDefinition,
    subscription: AutomationEventTrigger,
    event: PlanIssueBlockedEventRecord,
    context: SweepContext,
): Promise<EventOutcome> {
    const repository = event.repository;
    if (!repository || !automationEventTriggerMatches(subscription, definition.repositories,
        { type: 'plan.issue_blocked', repository, reasonKind: event.blockedKind })) {
        return 'unmatched';
    }
    const triggerEvent = planIssueBlockedTriggerEvent({ ...event, repository }, context.frontendUrl);
    const run = {
        triggerSource: `plan.issue_blocked:${repository}#${event.issueNumber}`,
        idempotencyKey: `${EVENT_IDEMPOTENCY_PREFIX}${event.id}`,
        triggerEvent,
        triggerSubject: planIssueTriggerSubject(event),
    };
    const storeDeps = { database: context.database };

    const existing = await getAgentRunByIdempotencyKey(definition.id, run.idempotencyKey, storeDeps);
    if (existing) {
        // A sweep that stopped between recording a queued run and enqueueing it; the job id is
        // deterministic and the worker skips a run that is no longer queued.
        if (existing.state === 'queued') await context.dispatch(existing);
        return 'existing';
    }
    if (await countAgentRunsForTriggerSubject(definition.id, run.triggerSubject, storeDeps) >= MAX_AUTOMATION_EVENT_RUNS_PER_ISSUE) {
        return recordSkipped(definition, run, `Not started: this automation already ran ${MAX_AUTOMATION_EVENT_RUNS_PER_ISSUE} times for issue #${event.issueNumber} of this plan (loop protection)`, context);
    }
    try {
        const result = await context.trigger({ definition, trigger: 'event', ...run, gate: context.gate, keepQueuedOnEnqueueFailure: true });
        logger.info({ definitionId: definition.id, eventId: event.id, runId: result.run.id, decision: result.created ? result.run.state : 'existing' },
            'Event-triggered automation run');
        if (!result.created) {
            if (result.run.state === 'queued' && !result.enqueued) await context.dispatch(result.run);
            return 'existing';
        }
        return 'created';
    } catch (error) {
        if (!(error instanceof AgentRunTriggerError)) throw error;
        // The history shows why the event did not run.
        return recordSkipped(definition, run, `Not started: ${error.message}`, context);
    }
}

/** Handles the events after one subscription's cursor, moving the cursor past each one. */
async function sweepSubscription(definitionId: string, subscription: AutomationEventTrigger, context: SweepContext, result: AgentEventTriggerSweepResult): Promise<void> {
    const storeDeps = { database: context.database, now: context.clock };
    const stored = await getAgentDefinitionEventCursor(definitionId, subscription.event, storeDeps);
    // A subscriber without a cursor starts at the newest event and runs nothing older.
    if (stored === null) { await initializeAgentDefinitionEventCursor(definitionId, subscription.event, storeDeps); return; }
    let cursor = stored;
    const events = await listPlanIssueBlockedEventsAfter(cursor, context.batchSize, storeDeps);
    for (const event of events) {
        // Admitted against the stored definition: one disabled or unsubscribed meanwhile starts nothing.
        const definition = await readDefinition(definitionId, context.database);
        const current = definition?.eventTriggers.find(candidate => candidate.event === subscription.event);
        if (!definition?.enabled || !current) return;
        const outcome = await fireEvent(definition, current, event, context);
        result[outcome] += 1;
        // Lost to a concurrent sweep, or reset because the definition was re-enabled: stop here.
        if (!await advanceAgentDefinitionEventCursor(definitionId, subscription.event, { from: cursor, to: event.id }, storeDeps)) return;
        cursor = event.id;
    }
}

async function sweepDefinition(definitionId: string, context: SweepContext, result: AgentEventTriggerSweepResult): Promise<void> {
    const definition = await readDefinition(definitionId, context.database);
    if (!definition?.enabled || definition.eventTriggers.length === 0) return;
    // An offboarded owner's automation starts nothing; the cursor stays, and re-enabling resets it.
    if (!await context.isMember(definition.ownerId)) return;
    for (const subscription of definition.eventTriggers) await sweepSubscription(definition.id, subscription, context, result);
}

/**
 * Starts the runs for new events of every subscribed, enabled definition. Each definition is
 * handled on its own, so one that keeps failing never stops the others; its cursor stays on
 * the failing event, which is retried on the next sweep.
 */
export async function runAgentEventTriggerSweep(
    deps: AgentEventTriggerSweepDependencies & { isMember: (ownerId: string) => Promise<boolean> },
): Promise<AgentEventTriggerSweepResult> {
    const database = deps.database ?? db;
    const clock = deps.now ?? Date.now;
    const context: SweepContext = {
        database,
        clock,
        trigger: deps.trigger ?? (input => triggerAgentRun(input, { database, now: clock, enqueue: deps.enqueue })),
        gate: deps.gate ?? createAgentRunCostGate({ now: clock }),
        isMember: deps.isMember,
        dispatch: run => enqueueAgentRunPhase(run, 'report', { enqueue: deps.enqueue }),
        batchSize: deps.batchSize ?? AGENT_EVENT_TRIGGER_BATCH_SIZE,
        frontendUrl: (deps.frontendUrl ?? defaultFrontendUrl()).replace(/\/+$/, ''),
    };
    const result: AgentEventTriggerSweepResult = { created: 0, existing: 0, skipped: 0, unmatched: 0, failed: 0 };
    let afterId: string | null = null;
    for (;;) {
        const ids = await listEventSubscribedAgentDefinitionIds(DEFINITION_PAGE_SIZE, afterId, { database });
        for (const id of ids) {
            try {
                await sweepDefinition(id, context, result);
            } catch (error) {
                result.failed += 1;
                logger.error({ definitionId: id, err: error }, 'Could not start event-triggered automation runs; retrying on the next sweep');
            }
        }
        if (ids.length < DEFINITION_PAGE_SIZE) break;
        afterId = ids[ids.length - 1];
    }
    if (result.created + result.existing + result.skipped + result.failed > 0) logger.info({ ...result }, 'Automation event trigger sweep finished');
    return result;
}
