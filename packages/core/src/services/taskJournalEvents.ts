/**
 * The `task` domain of the repository event journal.
 *
 * A task appends `queued` when its state is created, `started` when it starts
 * running (again, after a retry or a reopened goal), and one terminal event,
 * `completed`, `failed` or `cancelled`, when it ends. Events are appended by
 * the task state manager right where it records the state change in
 * `task_history`, so every job path journals the same way.
 *
 * Payloads are built from identifiers and coded fields of the task state only:
 * never the reason text, error message, agent result, prompt, tool output,
 * comment bodies or notification recaps that the state also carries.
 *
 * Appending never fails or delays the task beyond one local insert: the
 * journal logs its own failures, and anything thrown while building the event
 * is caught here.
 */

import type { Knex } from 'knex';
import {
    taskEventKind,
    type TaskEventPayload,
    type TaskEventPullRequestOutcome,
    type TaskEventType,
    type TaskTerminalEventPayload,
} from '@propr/shared';
import logger from '../utils/logger.js';
import { db as defaultDb } from '../db/connection.js';
import { appendRepositoryEvent, type RepositoryEventInput } from './repositoryEventJournal.js';
import { isBookkeepingCancellation, type HistoryEntry, type TaskState, type TaskStateData, type UpdateMetadata } from '../utils/workerStateManager.types.js';

const RUNNING_STATES = new Set<TaskState>(['processing', 'claude_execution', 'post_processing']);
const TERMINAL_STATES = new Set<TaskState>(['completed', 'failed', 'cancelled']);
const PULL_REQUEST_KINDS = new Set(['follow-up', 'review', 'merge-conflict']);
const IDENTIFIER_MAX_CHARS = 100;
/** A coded category: lower-case words joined by `_`, `-` or `.`. Anything else is free text and is dropped. */
const CODE_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/;

/** The parts of a state transition the journal needs. */
export interface TaskJournalTransition {
    state: TaskStateData;
    /** Null when the transition creates the task state. */
    previousState: TaskState | null;
    /** The previous state was a queue handoff (`requeued` / `rescheduled`), not a real cancellation. */
    previousWasBookkeeping?: boolean;
}

const positiveInteger = (value: unknown): number | null =>
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;

const identifier = (value: unknown): string | null =>
    typeof value === 'string' && value.trim() ? value.trim().slice(0, IDENTIFIER_MAX_CHARS) : null;

const code = (value: unknown): string | null =>
    typeof value === 'string' && CODE_PATTERN.test(value) ? value : null;

function basePayload(state: TaskStateData): { repository: string; payload: TaskEventPayload } | null {
    const { issueRef } = state;
    const kind = taskEventKind(issueRef?.type);
    if (!kind) return null;
    const owner = identifier(issueRef.repoOwner);
    const repo = identifier(issueRef.repoName);
    if (!owner || !repo || owner === 'unknown' || repo === 'unknown') return null;
    const number = positiveInteger(issueRef.pullRequestNumber) ?? positiveInteger(issueRef.number);
    const isPullRequest = PULL_REQUEST_KINDS.has(kind);
    return {
        repository: `${owner}/${repo}`,
        payload: {
            taskId: state.taskId,
            kind,
            issueNumber: isPullRequest ? null : number,
            prNumber: isPullRequest ? number : null,
            agent: identifier(issueRef.agentAlias) ?? identifier(issueRef.agent),
            model: identifier(issueRef.modelName),
            attempts: Number.isSafeInteger(state.attempts) ? state.attempts : 0,
        },
    };
}

/** The journal event a transition appends, or null when it appends none. */
export function taskEventType(transition: TaskJournalTransition): TaskEventType | null {
    const { state, previousState } = transition;
    if (state.state === previousState) return null;
    if (state.state === 'pending') return 'queued';
    if (TERMINAL_STATES.has(state.state)) {
        // A queue handoff records `cancelled` without a reason and is resumed
        // later: the task did not end, so it is not journaled.
        if (isBookkeepingCancellation(state)) return null;
        return state.state as TaskEventType;
    }
    if (!RUNNING_STATES.has(state.state)) return null;
    const startsRun = previousState === 'pending'
        || (previousState !== null && TERMINAL_STATES.has(previousState) && !transition.previousWasBookkeeping);
    return startsRun ? 'started' : null;
}

/** A history entry recording a queue handoff (`requeued` / `rescheduled`), judged like the live state is. */
function isBookkeepingEntry(entry: HistoryEntry): boolean {
    const terminalReason = entry.metadata?.terminalReason;
    return isBookkeepingCancellation({
        state: entry.state,
        terminalReason: typeof terminalReason === 'string' ? terminalReason as TaskStateData['terminalReason'] : undefined,
        history: [entry],
    });
}

/**
 * Milliseconds from the latest start of a run to the state's last update. A
 * run continues through running states and through queue handoffs, matching
 * `taskEventType`, which appends no `started` when a handoff resumes; a
 * resumption after a real terminal state (a retry) starts a new run.
 */
function runDurationMs(state: TaskStateData): number | null {
    const history = state.history ?? [];
    for (let index = history.length - 1; index >= 0; index--) {
        const entry = history[index];
        if (!RUNNING_STATES.has(entry.state)) continue;
        const before = history[index - 1];
        if (before && (RUNNING_STATES.has(before.state) || isBookkeepingEntry(before))) continue;
        const elapsed = Date.parse(state.updatedAt) - Date.parse(entry.timestamp);
        return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null;
    }
    return null;
}

function pullRequestOutcome(state: TaskStateData, kind: string, metadata: UpdateMetadata): TaskEventPullRequestOutcome {
    if (state.state !== 'completed' && state.state !== 'failed') return null;
    const prResult = state.prResult ?? {};
    const continuation = metadata.historyMetadata?.continuation;
    if (prResult.prCreated === true || (kind === 'implementation' && positiveInteger(prResult.prNumber))
        || (continuation && typeof continuation === 'object')) return 'opened';
    if (typeof metadata.commitHash === 'string' && metadata.commitHash) return 'updated';
    return null;
}

/** The failure category of a failed task: its coded terminal reason, else its recorded error category. */
function failureCategory(state: TaskStateData, metadata: UpdateMetadata): string | null {
    if (state.state !== 'failed') return null;
    return code(state.terminalReason) ?? code(metadata.error?.category) ?? code(metadata.errorCategory)
        ?? code(state.lastError?.category) ?? 'unknown';
}

/** Build the journal event of a task state transition (creation included), or null when none is due. */
export function buildTaskJournalEvent(transition: TaskJournalTransition, metadata: UpdateMetadata = {}): RepositoryEventInput | null {
    const type = taskEventType(transition);
    if (!type) return null;
    const { state } = transition;
    const base = basePayload(state);
    if (!base) return null;
    let payload: TaskEventPayload | TaskTerminalEventPayload = base.payload;
    if (type === 'completed' || type === 'failed' || type === 'cancelled') {
        payload = {
            ...base.payload,
            status: type,
            terminalReason: code(state.terminalReason),
            durationMs: runDurationMs(state),
            pullRequest: pullRequestOutcome(state, base.payload.kind, metadata),
            failureCategory: failureCategory(state, metadata),
        } satisfies TaskTerminalEventPayload;
    }
    return {
        repository: base.repository,
        domain: 'task',
        type,
        entityId: state.taskId,
        issueNumber: base.payload.issueNumber,
        prNumber: base.payload.prNumber,
        payload: { ...payload },
        // Each transition writes a new version, so a republished transition appends nothing.
        dedupeKey: `task:${state.taskId}:${type}:v${state.version ?? 0}`,
        occurredAt: state.updatedAt,
    };
}

/**
 * Append the journal event of a task state transition. Never throws: a failed
 * append is logged (by the journal, or here) and the task carries on.
 */
export async function appendTaskJournalEvent(
    transition: TaskJournalTransition, metadata: UpdateMetadata = {}, database: Knex = defaultDb,
): Promise<void> {
    try {
        const event = buildTaskJournalEvent(transition, metadata);
        if (!event) return;
        await appendRepositoryEvent(database, event);
    } catch (error) {
        try {
            logger.warn({ taskId: transition?.state?.taskId, error: (error as Error)?.message ?? String(error) },
                'Failed to journal task state change; continuing without it');
        } catch { /* logging never affects the task either */ }
    }
}
