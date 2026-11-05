import { randomUUID } from 'node:crypto';
import type { Knex } from 'knex';
import { db, logger } from '@propr/core';
import {
    adoptPRProcessingLock, releasePRProcessingLock, startPRProcessingLockHeartbeat,
} from './prProcessingLock.js';
import {
    containerIdentityConflict, recordFailedClosed, resolveRecoveryDeps,
    type FollowupHandoffRecoveryDeps, type ResolvedRecoveryDeps,
} from './followupHandoffDeps.js';
import {
    advanceFollowupHandoff, finalizeFollowupHandoff, handoffRepositoryKey, loadFollowupHandoff, loadFollowupHandoffs, parseClaimedComments, retryOwnsClaims,
    HANDOFF_ACTIVE, HANDOFF_AWAITING_OPERATOR, HANDOFF_RELEASED,
    type FollowupHandoffKey, type FollowupHandoffRecord, type FollowupHandoffStoreDeps,
} from './followupHandoffStore.js';
import { pendingRetryHold } from './followupHandoffTaskState.js';
import { createFollowupHandoffGitOps } from './followupHandoffGitOps.js';
import {
    reportHandoffOnTaskTimeline, resumeFollowupHandoff,
    type LoggerLike, type ResumeOutcome,
} from './followupHandoffResume.js';

export type { FollowupHandoffRecoveryDeps } from './followupHandoffDeps.js';
export {
    authorizeCancelledFollowupHandoff, inspectFollowupHandoffs, releaseFollowupHandoffRecord,
    resumeOperatorHeldFollowupHandoff,
    type FollowupHandoffStatus, type OperatorResumeResult,
} from './followupHandoffOperator.js';
import { predecessorReleasable, releasePredecessorInline, settleStuckHolds } from './followupHandoffAutoRelease.js';

/**
 * Discovers follow-up publication handoffs a worker restart interrupted and
 * finishes their owed publication exactly once. Discovery distinguishes a
 * still-live agent container from an exited or lost one (and the bound
 * container from an impostor), fails closed when that evidence is unavailable,
 * serializes with every other writer under the pull request's processing lease
 * — renewed by a heartbeat for as long as recovery holds it — and never
 * destroys retained worktrees.
 */

export interface FollowupHandoffRecoverySummary {
    inspected: number;
    published: number;
    noChanges: number;
    /** Completions or failures the normal path had already delivered; recorded without republishing or requeueing. */
    settled: number;
    cleanupPending: number;
    skippedLiveAgent: number;
    failedClosed: number;
    awaitingOperator: number;
    lockedByOtherWriter: number;
    errors: number;
}

/**
 * Finishes an adopted record under the pull request's processing lease. The
 * lease is taken over from the dead predecessor's recorded token only; a lease
 * some other writer holds, or one the recorded owner still renews, is left
 * alone and the record is retried on a later pass. While recovery works, a
 * heartbeat renews the lease so no concurrent pass can adopt it, and a lost
 * lease stops all further mutations.
 */
async function adoptAndResume(
    record: FollowupHandoffRecord,
    deps: ResolvedRecoveryDeps,
    recoveredBy?: string,
): Promise<ResumeOutcome | { outcome: 'locked' }> {
    const successorToken = `handoff-recovery:${record.incarnation}:${randomUUID()}`;
    const adoption = await adoptPRProcessingLock(deps.redis, record.lock_key, { predecessorToken: record.lock_token, successorToken });
    if (adoption !== 'adopted') {
        deps.log.info({ repository: record.repository, pullRequest: record.pull_request, adoption },
            'Follow-up handoff lease is held by another writer; retrying on a later pass');
        return { outcome: 'locked' };
    }
    try {
        // Re-read under the lease: the row may have moved on while unlocked.
        const fresh = await loadFollowupHandoff(deps.store, record);
        if (!fresh || fresh.incarnation !== record.incarnation || fresh.generation !== record.generation
            || fresh.status !== HANDOFF_ACTIVE) {
            return { outcome: 'superseded' };
        }
        // Durable successor ownership: later passes adopt from this token, not the dead one's.
        const owned = await advanceFollowupHandoff(deps.store, fresh, { lock_token: successorToken });
        if (!owned) return { outcome: 'superseded' };
        let leaseLost = false;
        const stopHeartbeat = startPRProcessingLockHeartbeat({
            redisClient: deps.redis, lockKey: record.lock_key, lockToken: successorToken,
            ...(deps.heartbeatIntervalMs ? { intervalMs: deps.heartbeatIntervalMs } : {}),
            onLockLost: () => { leaseLost = true; },
            onError: error => deps.log.warn({ lockKey: record.lock_key, error: (error as Error).message },
                'Could not renew the follow-up handoff recovery lease'),
        });
        try {
            return await resumeFollowupHandoff({
                record: owned, octokit: await deps.getOctokit(), git: deps.git,
                stateManager: deps.stateManager, restoreComments: deps.restoreComments, withdrawRestoredComments: deps.withdrawRestoredComments,
                store: deps.store, log: deps.log, taskStates: deps.taskStates, recoveredBy,
                isOwnershipLost: () => leaseLost,
                // No job drains the pending list after a standalone pass.
                scheduleRestoredComments: deps.scheduleRestoredComments,
            });
        } finally {
            await stopHeartbeat();
        }
    } finally {
        await releasePRProcessingLock(deps.redis, record.lock_key, successorToken);
    }
}

function countOutcome(summary: FollowupHandoffRecoverySummary, outcome: string): void {
    if (outcome === 'published') summary.published += 1;
    else if (outcome === 'no_changes') summary.noChanges += 1;
    else if (outcome === 'settled') summary.settled += 1;
    else if (outcome === 'cleanup_pending') summary.cleanupPending += 1;
    else if (outcome === 'awaiting_operator') summary.awaitingOperator += 1;
    else if (outcome === 'locked' || outcome === 'ownership_lost') summary.lockedByOtherWriter += 1;
}

/**
 * One recovery pass; wired into worker startup and reconciliation. With a key,
 * its publication side effects are strictly limited to that pull request's
 * handoff — the form operator commands use.
 */
export async function recoverInterruptedFollowupHandoffs(
    deps: FollowupHandoffRecoveryDeps = {},
    key?: FollowupHandoffKey,
): Promise<FollowupHandoffRecoverySummary> {
    const resolved = await resolveRecoveryDeps(deps);
    const summary: FollowupHandoffRecoverySummary = {
        inspected: 0, published: 0, noChanges: 0, settled: 0, cleanupPending: 0, skippedLiveAgent: 0,
        failedClosed: 0, awaitingOperator: 0, lockedByOtherWriter: 0, errors: 0,
    };
    try {
        if (!key) await settleStuckHolds(deps, resolved);
        const handoffs = key
            ? [await loadFollowupHandoff(resolved.store, key)]
                .filter((record): record is FollowupHandoffRecord => record?.status === HANDOFF_ACTIVE)
            : await loadFollowupHandoffs(resolved.store, { status: HANDOFF_ACTIVE });
        for (const record of handoffs) {
            summary.inspected += 1;
            try {
                const inspection = await resolved.inspectLiveness(record.task_id);
                const identityConflict = containerIdentityConflict(record, inspection);
                if (identityConflict) {
                    summary.failedClosed += 1;
                    await recordFailedClosed(record, resolved, identityConflict);
                    continue;
                }
                if (inspection.liveness === 'running') {
                    summary.skippedLiveAgent += 1;
                    await reportHandoffOnTaskTimeline({ stateManager: resolved.stateManager, log: resolved.log }, record, 'agent container is still running; waiting');
                    continue;
                }
                if (inspection.liveness !== 'stopped' && inspection.liveness !== 'not_found') {
                    summary.failedClosed += 1;
                    await recordFailedClosed(record, resolved);
                    continue;
                }
                const result = await adoptAndResume(record, resolved);
                countOutcome(summary, result.outcome);
            } catch (error) {
                summary.errors += 1;
                resolved.log.error({ repository: record.repository, pullRequest: record.pull_request, taskId: record.task_id, error: (error as Error).message },
                    'Failed to recover an interrupted follow-up handoff; it stays recorded for the next pass');
            }
        }
        return summary;
    } finally {
        if (resolved.ownRedis) await resolved.redis.quit?.();
    }
}

export interface PredecessorAdoptionParams {
    repoOwner: string;
    repoName: string;
    pullRequestNumber: number;
    currentTaskId: string;
    log: LoggerLike;
    /** The caller's current PR processing lease token, installed as the handoff's durable owner before any recovery mutation. */
    lockToken: string;
    /** Caller's own lease heartbeat signal; adoption stops mutating when it reports loss. */
    isOwnershipLost?: () => boolean;
}

export type PredecessorAdoption =
    | {
        blocked: 'predecessor_agent_still_running' | 'predecessor_liveness_unavailable'
        | 'predecessor_awaiting_operator' | 'predecessor_container_identity_mismatch'
        /**
         * The same task's failed attempt could not be taken over: a Git registration
         * still holds the branch, or the branch could not be restarted from the pull
         * request head (see maintenance.md).
         */
        | 'predecessor_branch_still_held' | 'predecessor_retry_pending';
    }
    | { resumed?: ResumeOutcome }
    /** Comment IDs a released, unauthorized cancelled predecessor claimed; they must never execute. */
    | { releasedCancelledClaimIds: number[] };

/**
 * A released handoff whose task was cancelled — and never authorized for
 * publication — still names the requests the user stopped. A follow-up that
 * captured those comments before the operator release (its pending-list claim
 * runs before it takes the lease) must drop them, so the claim set is
 * returned for the caller to filter. The task state decides, as for the
 * release itself: the release overwrote the status reason. A scheduled
 * usage-limit retry owns its claims despite the requeued attempt's CANCELLED
 * state, so its admission keeps them.
 */
async function releasedCancelledClaimIds(record: FollowupHandoffRecord, resolved: ResolvedRecoveryDeps): Promise<number[]> {
    if (record.operator_authorized || retryOwnsClaims(record)) return [];
    const task = await resolved.stateManager.getTaskState(record.task_id);
    if (task?.state !== resolved.taskStates.CANCELLED) return [];
    return parseClaimedComments(record).map(comment => comment.id);
}

async function pendingRetryOwnsMissingWorktree(record: FollowupHandoffRecord, resolved: ResolvedRecoveryDeps): Promise<boolean> {
    return record.status_reason === 'publication_failed'
        && await resolved.git.worktreeAttachment(record.worktree_path, record.branch_name) === 'missing'
        && await pendingRetryHold(record, resolved) !== null;
}

/**
 * Serializes a redelivered or new follow-up behind its recoverable
 * predecessor. The caller already holds the pull request processing lease, so
 * the predecessor is finished here, in-line, before another worktree is
 * prepared. A still-live, unverifiable, or operator-held predecessor blocks
 * the new writer entirely.
 */
export async function adoptPredecessorFollowupHandoff(
    params: PredecessorAdoptionParams,
    deps: FollowupHandoffRecoveryDeps = {},
): Promise<PredecessorAdoption> {
    const resolved = await resolveRecoveryDeps(deps);
    try {
        const key: FollowupHandoffKey = {
            repository: handoffRepositoryKey(params.repoOwner, params.repoName),
            pull_request: params.pullRequestNumber,
        };
        const record = await loadFollowupHandoff(resolved.store, key);
        if (!record) return {};
        if (record.status === HANDOFF_RELEASED) {
            const claimIds = await releasedCancelledClaimIds(record, resolved);
            return claimIds.length > 0 ? { releasedCancelledClaimIds: claimIds } : {};
        }
        // An operator hold is a standing obligation unless its attempt is over
        // and can publish nothing more; then this writer releases it instead.
        const releasable = await predecessorReleasable(record, resolved, params.currentTaskId);
        if (record.status === HANDOFF_AWAITING_OPERATOR && !releasable) return { blocked: 'predecessor_awaiting_operator' };
        const inspection = await resolved.inspectLiveness(record.task_id);
        const identityConflict = containerIdentityConflict(record, inspection);
        if (identityConflict) {
            await recordFailedClosed(record, resolved, identityConflict);
            return { blocked: 'predecessor_container_identity_mismatch' };
        }
        if (inspection.liveness === 'running') return { blocked: 'predecessor_agent_still_running' };
        if (inspection.liveness !== 'stopped' && inspection.liveness !== 'not_found') {
            await recordFailedClosed(record, resolved);
            return { blocked: 'predecessor_liveness_unavailable' };
        }
        if (releasable) return await releaseForWriter(record, resolved, params);
        // A queued retry owns a missing failed-attempt worktree. Block before
        // installing successor ownership or consulting Git inside that directory.
        if (await pendingRetryOwnsMissingWorktree(record, resolved)) return { blocked: 'predecessor_retry_pending' };
        const recoveredBy = record.task_id === params.currentTaskId ? undefined : params.currentTaskId;
        // Durable successor ownership, installed before any recovery mutation:
        // a suspended predecessor's normal-path checkpoint treats an unchanged
        // owner token as proof it still owns the row, so the token must change
        // here. A same-task redelivery shares the job's persisted lease token
        // with the stale attempt, so its adoption installs a distinct
        // adoption-scoped token instead.
        const ownerToken = recoveredBy ? params.lockToken : `${params.lockToken}#redelivery:${randomUUID()}`;
        const adopted = await advanceFollowupHandoff(resolved.store, record, {
            lock_token: ownerToken,
            // Durable successor lineage, readable from operator status surfaces.
            ...(recoveredBy && record.successor_task_id !== recoveredBy ? { successor_task_id: recoveredBy } : {}),
        });
        if (!adopted) return { resumed: { outcome: 'superseded' } };
        // No scheduleRestoredComments: comments restored here are drained by
        // the adopting job's own cleanup, which queues the pending follow-up.
        const resumed = await resumeFollowupHandoff({
            record: adopted, octokit: await resolved.getOctokit(), git: resolved.git,
            stateManager: resolved.stateManager, restoreComments: resolved.restoreComments, withdrawRestoredComments: resolved.withdrawRestoredComments,
            store: resolved.store, log: resolved.log, taskStates: resolved.taskStates, recoveredBy,
            isOwnershipLost: params.isOwnershipLost,
        });
        params.log.info({ repository: record.repository, pullRequest: record.pull_request, predecessorTaskId: record.task_id, outcome: resumed.outcome },
            'Adopted a recoverable predecessor follow-up handoff before preparing a new worktree');
        return { resumed };
    } finally {
        if (resolved.ownRedis) await resolved.redis.quit?.();
    }
}

/**
 * Releases a predecessor that can publish nothing more, so this writer runs
 * instead of waiting. A release that could not free the branch (or restart it
 * from the pull request head) keeps this writer waiting: an operator hold
 * stays reported as such, while a failed same-task attempt that was never
 * held names the branch.
 */
async function releaseForWriter(record: FollowupHandoffRecord, resolved: ResolvedRecoveryDeps, params: PredecessorAdoptionParams): Promise<PredecessorAdoption> {
    const claimIds = await releasePredecessorInline(record, resolved, params.currentTaskId, params.log);
    if (!claimIds) {
        return { blocked: record.status === HANDOFF_AWAITING_OPERATOR ? 'predecessor_awaiting_operator' : 'predecessor_branch_still_held' };
    }
    return claimIds.length > 0 ? { releasedCancelledClaimIds: claimIds } : {};
}

/** The continuation record's durable publication checkpoint, matching findPRContinuation's mapping. */
async function publicationCheckpointRetained(
    store: { database?: Knex },
    params: HandoffFailureSettlement,
): Promise<boolean> {
    try {
        const continuation = await (store.database ?? db as unknown as Knex)('pr_continuations')
            .where({ repository: handoffRepositoryKey(params.repoOwner, params.repoName) })
            .andWhere(builder => builder
                .where({ source_pr: params.pullRequestNumber })
                .orWhere({ continuation_pr: params.pullRequestNumber }))
            .first() as { publication_bundle: string | null; publication_completion: string | null } | undefined;
        return Boolean(continuation?.publication_bundle ?? continuation?.publication_completion);
    } catch {
        return false;
    }
}

/**
 * Settles a handoff whose request another owner decides. A scheduled
 * usage-limit retry owns it: retained edits are never published, and the
 * requeue is no user cancellation, so only branch release is owed, which
 * cleanup or recovery proves before retiring. A user cancellation holds it
 * for an explicit operator decision.
 */
async function settleOwnershipElsewhere(store: FollowupHandoffStoreDeps, record: FollowupHandoffRecord, cancelled: boolean): Promise<boolean> {
    if (retryOwnsClaims(record)) {
        await advanceFollowupHandoff(store, record, { phase: 'cleanup_pending', status_reason: 'usage_limit_retry' });
        return true;
    }
    if (!cancelled) return false;
    await advanceFollowupHandoff(store, record, { status: HANDOFF_AWAITING_OPERATOR, status_reason: 'cancelled_by_user' });
    return true;
}

export interface HandoffFailureSettlement {
    repoOwner: string;
    repoName: string;
    pullRequestNumber: number;
    taskId: string;
    cancelled: boolean;
}

/**
 * Settles this attempt's handoff once the in-process error handler delivered
 * the owed failure comment and terminal state. The failure notification does
 * not prove the retained work published: the row is deleted only when the
 * worktree evidence shows nothing unpublished remains. Retained edits or
 * unpushed commits keep the record adoptable by recovery, and a cancellation
 * holds it for an explicit operator decision.
 */
export async function settleFollowupHandoffAfterFailure(
    params: HandoffFailureSettlement,
    deps: FollowupHandoffRecoveryDeps = {},
): Promise<void> {
    const store = deps.store ?? {};
    const log = deps.log ?? logger as unknown as LoggerLike;
    const record = await loadFollowupHandoff(store, {
        repository: handoffRepositoryKey(params.repoOwner, params.repoName),
        pull_request: params.pullRequestNumber,
    });
    if (!record || record.task_id !== params.taskId || record.status !== HANDOFF_ACTIVE) return;
    // When the continuation machinery holds a durable publication checkpoint
    // for this pull request, that established recovery path owns the
    // obligation end to end — including retiring cancelled checkpoints without
    // replaying them — so the handoff may retire.
    if (await publicationCheckpointRetained(store, params)) {
        await finalizeFollowupHandoff(store, record);
        return;
    }
    if (await settleOwnershipElsewhere(store, record, params.cancelled)) return;
    // Publication already completed; only task finalization or branch release
    // is owed, which recovery retries without republishing.
    if (record.phase === 'comment_published' || record.phase === 'cleanup_pending') return;
    const git = deps.git ?? createFollowupHandoffGitOps(async () => {
        throw new Error('Publication evidence inspection needs no push token');
    });
    const publicationPending = ['committed', 'pushed'].includes(record.phase);
    let unpublished: boolean;
    let branchHeld = true;
    try {
        const attachment = await git.worktreeAttachment(record.worktree_path, record.branch_name);
        if (attachment === 'missing') {
            // Checkout removal cannot discharge an owed push or completion comment.
            unpublished = publicationPending;
            // A missing directory does not free the branch: Git keeps the
            // worktree registration (and its claim) until it is removed.
            branchHeld = (await git.branchWorktreeRegistrations(record.local_repo_path, record.branch_name)).length > 0;
        } else if (attachment === 'not_on_branch' || publicationPending) {
            unpublished = true;
        } else {
            unpublished = await git.hasUncommittedChanges(record.worktree_path)
                || await git.hasUnpushedCommits(record.worktree_path, record.branch_name);
        }
    } catch (error) {
        log.warn({ taskId: record.task_id, repository: record.repository, pullRequest: record.pull_request, error: (error as Error).message },
            'Could not read publication evidence after a handled failure; the handoff stays recoverable');
        unpublished = true;
    }
    if (!unpublished) {
        // Nothing is owed to GitHub, but a branch still attached to the retained
        // worktree is an outstanding obligation: the row is kept at
        // cleanup_pending until recovery proves branch release, so a worker
        // death before worktree cleanup never strands the branch undiscoverably.
        if (branchHeld) {
            await advanceFollowupHandoff(store, record, { phase: 'cleanup_pending', status_reason: 'publication_settled' });
            return;
        }
        await finalizeFollowupHandoff(store, record);
        return;
    }
    await advanceFollowupHandoff(store, record, { status_reason: 'publication_failed' });
}
