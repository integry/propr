import type { Knex } from 'knex';
import {
    MAX_AUTOMATION_EVENT_RUNS_PER_ISSUE,
    automationEventTriggerMatches,
    type AutomationEventTrigger,
    type AutomationTriggerEvent,
} from '@propr/shared';
import {
    AgentRunAdmissionRefusedError,
    AgentRunTriggerError,
    advanceAgentDefinitionEventCursor,
    countAgentRunsForTriggerSubject,
    createAgentRunCostGate,
    db,
    enqueueAgentRunPhase,
    getAgentDefinitionEventCursor,
    getAgentRunByIdempotencyKey,
    holdAgentDefinitionEventCursor,
    initializeAgentDefinitionEventCursor,
    listEventSubscribedAgentDefinitionIds,
    listPlanIssueBlockedEventsAfter,
    listUndispatchedEventAgentRuns,
    logger,
    recordSkippedRun,
    rowToAgentDefinition,
    triggerAgentRun,
    type AgentDefinitionRow,
    type AgentRunAdmission,
    type AgentRunEnqueue,
    type AgentRunGate,
    type PlanIssueBlockedEventRecord,
    type StoredAgentDefinition,
    type StoredAgentRun,
    type TriggerAgentRunInput,
    type TriggerAgentRunResult,
    type UndispatchedEventAgentRunCursor,
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
 * - An accepted run whose enqueue failed stays `queued`. The replay of its event dispatches it
 *   again, and so does a recovery pass over such runs once they are older than
 *   `AGENT_EVENT_DISPATCH_RECOVERY_GRACE_MS`, so a cursor reset that skips the event (the
 *   definition was re-enabled or resubscribed) does not strand it. Events themselves are
 *   still never replayed after a reset; only receipts recorded before it are dispatched.
 * - Loop bound: after `MAX_AUTOMATION_EVENT_RUNS_PER_ISSUE` event runs of a definition for the
 *   same issue of the same plan, later events for that issue are recorded as skipped runs.
 */

export const AGENT_EVENT_TRIGGER_BATCH_SIZE = 50;
const DEFINITION_PAGE_SIZE = 100;
/**
 * How long a `queued` event run may sit unchanged before the recovery pass enqueues it again.
 * Enqueueing is idempotent (the job id is deterministic and the worker skips a run that is no
 * longer queued); the grace only keeps the pass from re-adding jobs that are simply waiting.
 */
export const AGENT_EVENT_DISPATCH_RECOVERY_GRACE_MS = 5 * 60_000;
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
    /** Accepted runs left `queued` by a failed enqueue that the recovery pass enqueued again. */
    redispatched: number;
    failed: number;
}

type EventOutcome = Exclude<keyof AgentEventTriggerSweepResult, 'failed' | 'redispatched'>;
/** The subscription was reset, disabled or dropped after its events were read: nothing was recorded. */
const FENCED = 'fenced';

interface SweepContext {
    database: Knex;
    clock: () => number;
    trigger: NonNullable<AgentEventTriggerSweepDependencies['trigger']>;
    gate: AgentRunGate;
    isMember: (ownerId: string) => Promise<boolean>;
    dispatch: (run: TriggerAgentRunResult['run']) => Promise<unknown>;
    /** Runs this sweep already enqueued, which the recovery pass leaves alone. */
    dispatched: Set<string>;
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

type EventRun = Pick<TriggerAgentRunInput, 'triggerSource' | 'idempotencyKey' | 'triggerEvent' | 'triggerSubject'> & { admit: AgentRunAdmission };

async function recordSkipped(
    definition: StoredAgentDefinition,
    run: EventRun,
    skipReason: string,
    context: SweepContext,
): Promise<EventOutcome | typeof FENCED> {
    try {
        const { created } = await recordSkippedRun({ definition, trigger: 'event', ...run, skipReason },
            { database: context.database, now: context.clock });
        return created ? 'skipped' : 'existing';
    } catch (error) {
        if (error instanceof AgentRunAdmissionRefusedError) return FENCED;
        throw error;
    }
}

/**
 * Starts (or replays) the run for one event read under `cursor`. Every receipt is recorded
 * behind the cursor fence, so a reset after the batch was read records nothing. Throws when
 * it should be retried on the next sweep.
 */
async function fireEvent(
    definition: StoredAgentDefinition,
    subscription: AutomationEventTrigger,
    { event, cursor }: { event: PlanIssueBlockedEventRecord; cursor: number },
    context: SweepContext,
): Promise<EventOutcome | typeof FENCED> {
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
        // Fenced on the revision matched above and snapshotted into the run: an edit since then
        // (a narrowed filter or repository list, too) refuses the receipt.
        admit: (trx: Knex) => holdAgentDefinitionEventCursor(trx,
            { definitionId: definition.id, revision: definition.revision, event: subscription.event, cursor }, { now: context.clock }),
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
        if (error instanceof AgentRunAdmissionRefusedError) return FENCED;
        if (!(error instanceof AgentRunTriggerError)) throw error;
        // The history shows why the event did not run.
        return recordSkipped(definition, run, `Not started: ${error.message}`, context);
    }
}

/** How often one event is retried with the definition read again after an edit fenced its receipt; later edits wait for the next sweep. */
const EDITED_DEFINITION_ATTEMPTS = 2;

/** Handles the events after one subscription's cursor, moving the cursor past each one. */
async function sweepSubscription(definitionId: string, subscription: AutomationEventTrigger, context: SweepContext, result: AgentEventTriggerSweepResult): Promise<void> {
    const storeDeps = { database: context.database, now: context.clock };
    const stored = await getAgentDefinitionEventCursor(definitionId, subscription.event, storeDeps);
    // A subscriber without a cursor starts at the newest event and runs nothing older.
    if (stored === null) { await initializeAgentDefinitionEventCursor(definitionId, subscription.event, storeDeps); return; }
    let cursor = stored;
    const events = await listPlanIssueBlockedEventsAfter(cursor, context.batchSize, storeDeps);
    for (const event of events) {
        let outcome: EventOutcome | typeof FENCED = FENCED;
        for (let attempt = 0; attempt < EDITED_DEFINITION_ATTEMPTS && outcome === FENCED; attempt += 1) {
            // Matched and admitted against the stored definition: one disabled or unsubscribed meanwhile starts nothing.
            const definition = await readDefinition(definitionId, context.database);
            const current = definition?.eventTriggers.find(candidate => candidate.event === subscription.event);
            if (!definition?.enabled || !current) return;
            outcome = await fireEvent(definition, current, { event, cursor }, context);
            // Reset (re-enabled or resubscribed) or taken by a concurrent sweep: the event is not ours to handle.
            if (outcome === FENCED && await getAgentDefinitionEventCursor(definitionId, subscription.event, storeDeps) !== cursor) return;
            // Otherwise the definition was edited after it was read: match the event again with the edit applied.
        }
        // Still being edited: the cursor stays on the event, which the next sweep retries.
        if (outcome === FENCED) return;
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
 * Enqueues accepted event runs left `queued` without a job, whatever happened to their
 * definition's cursor since. Only receipts are dispatched; no event is read. An owner who is
 * no longer a member starts nothing, as for new events.
 */
async function redispatchUndispatchedRuns(context: SweepContext, before: number, result: AgentEventTriggerSweepResult): Promise<void> {
    const members = new Map<string, boolean>();
    // Every page is visited: runs passed over (an offboarded owner's) stay queued and would
    // otherwise fill each sweep's first page and hide newer receipts of other owners.
    let after: UndispatchedEventAgentRunCursor | null = null;
    for (;;) {
        const page = await listUndispatchedEventAgentRuns(before - AGENT_EVENT_DISPATCH_RECOVERY_GRACE_MS, context.batchSize, { database: context.database, after });
        for (const run of page) await redispatchRun(run, members, context, result);
        if (page.length < context.batchSize) return;
        const last = page[page.length - 1];
        after = { updatedAt: last.updatedAt, id: last.id };
    }
}

async function redispatchRun(run: StoredAgentRun, members: Map<string, boolean>, context: SweepContext, result: AgentEventTriggerSweepResult): Promise<void> {
    try {
        if (context.dispatched.has(run.id)) return;
        if (!members.has(run.ownerId)) members.set(run.ownerId, await context.isMember(run.ownerId));
        if (!members.get(run.ownerId)) return;
        await context.dispatch(run);
        result.redispatched += 1;
        logger.info({ runId: run.id, definitionId: run.definitionId }, 'Enqueued an accepted event-triggered automation run again');
    } catch (error) {
        result.failed += 1;
        logger.error({ runId: run.id, definitionId: run.definitionId, err: error }, 'Could not enqueue an accepted event-triggered automation run; retrying on the next sweep');
    }
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
        dispatch: async run => {
            await enqueueAgentRunPhase(run, 'report', { enqueue: deps.enqueue });
            context.dispatched.add(run.id);
        },
        dispatched: new Set(),
        batchSize: deps.batchSize ?? AGENT_EVENT_TRIGGER_BATCH_SIZE,
        frontendUrl: (deps.frontendUrl ?? defaultFrontendUrl()).replace(/\/+$/, ''),
    };
    const startedAt = clock();
    const result: AgentEventTriggerSweepResult = { created: 0, existing: 0, skipped: 0, unmatched: 0, redispatched: 0, failed: 0 };
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
    await redispatchUndispatchedRuns(context, startedAt, result);
    if (result.created + result.existing + result.skipped + result.redispatched + result.failed > 0) logger.info({ ...result }, 'Automation event trigger sweep finished');
    return result;
}
