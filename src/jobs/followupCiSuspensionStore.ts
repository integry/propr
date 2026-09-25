import { randomUUID } from 'node:crypto';
import type { Knex } from 'knex';
import { db } from '@propr/core';
import { sameSha, type SuspensionTarget } from './followupCiSuspensionRuns.js';

/**
 * Durable ownership of the pull request validation ProPR cancelled for a
 * follow-up implementation. The row survives worker retries and crashes, so the
 * obligation to restart or drop that validation is never lost.
 *
 * Every write carries the row lifetime, generation, and task that owns it,
 * so even deletion and recreation cannot let a stale read overwrite or
 * delete the state of a newer owner: its update simply matches no row. Across
 * workers the operations of a single pull request are additionally serialized
 * by the shared lease in `followupCiSuspensionLease.ts`, which is what keeps
 * their external cancel and rerun requests from interleaving.
 */

export const PR_CI_SUSPENSIONS_TABLE = 'pr_ci_suspensions';
export const SUSPENSION_ACTIVE = 'active';
export const SUSPENSION_RESTORING = 'restoring';
/** Restoration was refused by GitHub. The obligation stays recorded and every reconciliation retries it. */
export const SUSPENSION_BLOCKED = 'blocked';

export interface CiSuspensionRecord {
    repository: string;
    pull_request: number;
    head_sha: string;
    task_id: string;
    correlation_id: string | null;
    state: string;
    cancelled_runs: string;
    attempts: number;
    /** Incremented by every successful write; the optimistic-concurrency token of this row. */
    generation: number;
    /** Unique across deletion/recreation; generations are only unique within this lifetime. */
    incarnation: string;
    created_at: number;
    updated_at: number;
}

/** One cancelled run and whether its validation has already been brought back. */
export interface CancelledRun {
    id: number;
    name?: string;
    workflowId?: number;
    /**
     * The attempt the run was on when ProPR decided to cancel it, written with
     * the intent before the request leaves the worker. It is a lower bound, not
     * a claim: the cancellation cannot have affected an earlier attempt, and an
     * attempt the run reaches beyond it is either the one the request landed on
     * or a rerun somebody started afterwards — which of the two is settled from
     * the run's own attempts, never assumed. Absent on records written before
     * this evidence was kept.
     */
    observedAttempt?: number;
    /**
     * The attempt ProPR's cancellation is confirmed to have affected; a higher
     * one later proves a rerun landed. Confirmed only from evidence that ties
     * the attempt to the cancellation, never by adopting whatever attempt the
     * run shows after the request. Absent while unconfirmed — the request was
     * never answered, or the worker died before reading the run back — in which
     * case only the run's own outcome can settle the obligation. Once that
     * outcome is a cancelled run about to be rerun, the attempt it is cancelled
     * on is recorded here before the rerun is sent, so the rerun's advancement
     * is recognized even if nothing else about it ever was.
     */
    attempt?: number;
    restarted?: boolean;
}

export interface CiSuspensionStoreDeps {
    database?: Knex;
    now?: () => number;
}

export function resolveDatabase(deps: CiSuspensionStoreDeps): Knex {
    return deps.database ?? (db as unknown as Knex);
}

export function nowMs(deps: CiSuspensionStoreDeps): number {
    return (deps.now ?? Date.now)();
}

export function repositoryKey(owner: string, repo: string): string {
    return `${owner.trim()}/${repo.trim()}`.toLowerCase();
}

export function splitRepository(repository: string): { owner: string; repo: string } {
    const [owner, repo] = repository.split('/');
    return { owner, repo };
}

export function targetOf(record: CiSuspensionRecord): SuspensionTarget {
    return { ...splitRepository(record.repository), pullRequestNumber: record.pull_request };
}

export function suspensionKey(record: Pick<CiSuspensionRecord, 'repository' | 'pull_request'>): string {
    return `${record.repository}#${record.pull_request}`;
}

export function parseCancelledRuns(record: Pick<CiSuspensionRecord, 'cancelled_runs'>): CancelledRun[] {
    try {
        const parsed = JSON.parse(record.cancelled_runs) as unknown;
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((entry): entry is CancelledRun =>
            !!entry && typeof entry === 'object' && Number.isInteger((entry as CancelledRun).id));
    } catch {
        return [];
    }
}

export async function loadSuspensions(deps: CiSuspensionStoreDeps, filter?: { taskId: string }): Promise<CiSuspensionRecord[]> {
    const query = resolveDatabase(deps)<CiSuspensionRecord>(PR_CI_SUSPENSIONS_TABLE);
    return filter ? query.where({ task_id: filter.taskId }) : query.select('*');
}

/** Reads the row as it is right now; every operation starts from this inside the lock rather than from what it was handed. */
export async function loadSuspension(
    deps: CiSuspensionStoreDeps,
    key: Pick<CiSuspensionRecord, 'repository' | 'pull_request'>,
): Promise<CiSuspensionRecord | undefined> {
    return resolveDatabase(deps)<CiSuspensionRecord>(PR_CI_SUSPENSIONS_TABLE)
        .where({ repository: key.repository, pull_request: key.pull_request })
        .first();
}

/**
 * Deletes the suspension only while it is still the one the caller read.
 * Returns false when another owner or a newer generation took the row over, so
 * a stale finalizer can never drop a newer task's obligation.
 */
export async function deleteSuspension(
    deps: CiSuspensionStoreDeps,
    record: Pick<CiSuspensionRecord, 'repository' | 'pull_request' | 'task_id' | 'generation' | 'incarnation'>,
): Promise<boolean> {
    const deleted = await resolveDatabase(deps)(PR_CI_SUSPENSIONS_TABLE)
        .where({
            repository: record.repository,
            pull_request: record.pull_request,
            task_id: record.task_id,
            generation: record.generation,
            incarnation: record.incarnation,
        })
        .delete();
    return deleted > 0;
}

/**
 * Writes the cancelled runs and any state change of the record the caller read,
 * returning the record at its new generation, or null when the row moved on
 * without this caller. Callers must continue with the returned record.
 */
export async function saveCancelledRuns(
    deps: CiSuspensionStoreDeps,
    record: CiSuspensionRecord,
    runs: CancelledRun[],
    changes: Partial<Pick<CiSuspensionRecord, 'state' | 'attempts'>> = {},
): Promise<CiSuspensionRecord | null> {
    const next: CiSuspensionRecord = {
        ...record,
        ...changes,
        cancelled_runs: JSON.stringify(runs),
        updated_at: nowMs(deps),
        generation: record.generation + 1,
    };
    const updated = await resolveDatabase(deps)(PR_CI_SUSPENSIONS_TABLE)
        .where({
            repository: record.repository,
            pull_request: record.pull_request,
            task_id: record.task_id,
            generation: record.generation,
            incarnation: record.incarnation,
        })
        .update({
            cancelled_runs: next.cancelled_runs,
            updated_at: next.updated_at,
            generation: next.generation,
            state: next.state,
            attempts: next.attempts,
        });
    return updated > 0 ? next : null;
}

/**
 * Persists ownership before the first cancellation, so a crash can never lose
 * it. Runs recorded for another head belong to an obsolete revision and must
 * not be restarted; only the same head's cancellations carry over across
 * worker retries of the same implementation.
 *
 * The read and the write are two awaited calls, and between them the lease
 * can expire and be taken over: the new holder reserves the pull request for
 * a newer head and cancels its validation. The write is therefore never an
 * unconditional upsert. A row that was read is only taken over at the
 * generation and owner it was read at; where no row was read the write is an
 * insert that a conflicting insertion rejects. Either way a stale worker
 * matches nothing, and the new owner's ownership and restart obligations
 * survive it. Returns null when that happened; the caller owns nothing then.
 *
 * Those predicates only reject a takeover that happened after the read. A
 * worker stalled before its read runs — its lease expired, another worker
 * reserved the pull request and cancelled a newer head's validation — reads
 * that newer row itself, at the very generation the predicates would accept,
 * and would replace the new owner's head and drop its restart obligations.
 * The caller's `assertOwned` therefore runs once the read has resolved,
 * immediately before the write: it proves the lease is still this worker's at
 * that point, and the predicates cover only what changes after it. Lease loss
 * surfaces as whatever `assertOwned` throws, before anything is written.
 */
export async function reserveSuspension(
    params: {
        target: SuspensionTarget; headSha: string; taskId: string; correlationId?: string;
        /** Proves the caller still owns the pull request; awaited after the read and before the write. */
        assertOwned?: () => Promise<void>;
    },
    deps: CiSuspensionStoreDeps,
): Promise<{ record: CiSuspensionRecord; runs: CancelledRun[] } | null> {
    const { target, headSha, taskId, correlationId, assertOwned } = params;
    const repository = repositoryKey(target.owner, target.repo);
    const key = { repository, pull_request: target.pullRequestNumber };
    const existing = await loadSuspension(deps, key);
    // What was read may already be the new owner's row. Nothing is written on
    // top of it unless the lease is proven this worker's after that read.
    await assertOwned?.();
    const timestamp = nowMs(deps);
    const runs = existing && sameSha(existing.head_sha, headSha) ? parseCancelledRuns(existing) : [];
    const record: CiSuspensionRecord = {
        ...key,
        head_sha: headSha,
        task_id: taskId,
        correlation_id: correlationId ?? null,
        state: SUSPENSION_ACTIVE,
        cancelled_runs: JSON.stringify(runs),
        attempts: 0,
        // Taking the row over from any previous owner invalidates its in-flight writes.
        generation: (existing?.generation ?? 0) + 1,
        incarnation: existing?.incarnation ?? randomUUID(),
        created_at: existing?.created_at ?? timestamp,
        updated_at: timestamp,
    };
    const reserved = existing
        ? await takeOverSuspension(deps, existing, record)
        : await insertSuspension(deps, record);
    return reserved ? { record, runs } : null;
}

/** Replaces the row only while it is still the one that was read: same owner, same generation. */
async function takeOverSuspension(
    deps: CiSuspensionStoreDeps,
    existing: CiSuspensionRecord,
    record: CiSuspensionRecord,
): Promise<boolean> {
    const updated = await resolveDatabase(deps)(PR_CI_SUSPENSIONS_TABLE)
        .where({
            repository: existing.repository,
            pull_request: existing.pull_request,
            task_id: existing.task_id,
            generation: existing.generation,
            incarnation: existing.incarnation,
        })
        .update({
            head_sha: record.head_sha,
            task_id: record.task_id,
            correlation_id: record.correlation_id,
            state: record.state,
            cancelled_runs: record.cancelled_runs,
            attempts: record.attempts,
            generation: record.generation,
            incarnation: record.incarnation,
            updated_at: record.updated_at,
        });
    return updated > 0;
}

/**
 * Inserts the row where none was read. The primary key rejects a second
 * insertion, which is how a worker that read nothing learns that somebody
 * reserved the pull request meanwhile; that row is theirs and is left alone.
 */
async function insertSuspension(deps: CiSuspensionStoreDeps, record: CiSuspensionRecord): Promise<boolean> {
    try {
        await resolveDatabase(deps)(PR_CI_SUSPENSIONS_TABLE).insert(record);
        return true;
    } catch (error) {
        // Only a row that exists now explains the failure as a conflicting
        // insertion; anything else is a real database error.
        const conflicting = await loadSuspension(deps, record);
        if (conflicting) return false;
        throw error;
    }
}
