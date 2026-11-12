import type { UltrafixOutcome } from '@propr/shared';

/**
 * Journals Ultrafix loop start and end into the repository event journal.
 *
 * The loop state itself lives in Redis, so these events are appended right
 * after the state is committed there. The loop state service is Redis-only and
 * is used by processes (and tests) that never open the database, so it writes
 * through a replaceable writer: a no-op until a process that runs loops (the
 * daemon, the worker and the API server, through `createUltrafixDeps`)
 * installs the core journal writer.
 */

/** The fields of a loop state the events are derived from. */
export interface UltrafixJournalState {
    owner: string;
    repo: string;
    pr: number;
    goal: number;
    maxCycles: number;
    workEpoch: number;
    sourceCommentId?: number;
}

export interface UltrafixJournalEvent {
    repository: string;
    domain: 'pull_request';
    type: 'ultrafix_started' | 'ultrafix_ended';
    entityId: number;
    prNumber: number;
    payload: Record<string, unknown>;
    dedupeKey: string;
}

/** Appends one journal event; must never throw. */
export type UltrafixJournalWriter = (event: UltrafixJournalEvent) => Promise<void>;

const REASON_MAX_CHARS = 300;

/** Same text the CI wait records when it gives up on blocking checks. */
const CI_TIMEOUT_REASON = 'CI did not settle';

/**
 * The coded outcome of a loop that completed with a free-text reason, judged
 * as the continuation judges it: a missed goal is exhausted cycles unless the
 * loop stopped on a blocker, ran out of escalation, or timed out on CI.
 */
export function ultrafixOutcomeFromCompletion(completionStatus: 'succeeded' | 'failed', reason: string | null | undefined): UltrafixOutcome {
    if (completionStatus === 'succeeded') return 'goal_reached';
    const text = reason ?? '';
    if (text.startsWith(CI_TIMEOUT_REASON) || /escalation/i.test(text)) return 'failed';
    if (/blocker|stopped by|cancel/i.test(text)) return 'stopped';
    return 'cycles_exhausted';
}

// One loop is identified by its automatic-work epoch and the command that started it.
const loopKey = (state: UltrafixJournalState) => `${state.workEpoch}:${state.sourceCommentId ?? 'none'}`;

export function ultrafixStartedEvent(state: UltrafixJournalState): UltrafixJournalEvent {
    return {
        repository: `${state.owner}/${state.repo}`, domain: 'pull_request', type: 'ultrafix_started',
        entityId: state.pr, prNumber: state.pr,
        payload: { goal: state.goal, maxCycles: state.maxCycles, workEpoch: state.workEpoch },
        dedupeKey: `pr:${state.pr}:ultrafix_started:${loopKey(state)}`,
    };
}

export function ultrafixEndedEvent(state: UltrafixJournalState, ended: {
    outcome: UltrafixOutcome; finalScore: number | null; reason: string | null;
}): UltrafixJournalEvent {
    const reason = ended.reason?.trim() ? ended.reason.trim().slice(0, REASON_MAX_CHARS) : null;
    return {
        repository: `${state.owner}/${state.repo}`, domain: 'pull_request', type: 'ultrafix_ended',
        entityId: state.pr, prNumber: state.pr,
        payload: { outcome: ended.outcome, finalScore: ended.finalScore, reason, workEpoch: state.workEpoch },
        // A loop ends once, whether it completed or was stopped.
        dedupeKey: `pr:${state.pr}:ultrafix_ended:${loopKey(state)}`,
    };
}

/** Default writer: the core journal against the core database. */
const writeToCoreJournal: UltrafixJournalWriter = async event => {
    try {
        const core = await import('@propr/core');
        if (typeof core.appendRepositoryEvent !== 'function') return;
        await core.appendRepositoryEvent(core.db, event);
    } catch {
        // appendRepositoryEvent logs and counts its own failures; a failed load
        // of the writer must not fail the loop transition either.
    }
};

const noJournal: UltrafixJournalWriter = async () => undefined;
let writer: UltrafixJournalWriter = noJournal;

/** Journal loop transitions into the core database; called once by processes that run loops. */
export function installUltrafixCoreJournal(): void {
    writer = writeToCoreJournal;
}

/** Replace the writer (tests drive the real call sites against their own database); no argument disables journaling. */
export function setUltrafixJournalWriter(next?: UltrafixJournalWriter): void {
    writer = next ?? noJournal;
}

export const writeUltrafixJournalEvent: UltrafixJournalWriter = event => writer(event);
