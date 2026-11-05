import { DelayedError, type Job } from 'bullmq';
import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import { createHooklessGit } from '@propr/core';
import { createFollowupHandoffGitOps } from './followupHandoffGitOps.js';
import type { CommentJobData, JobResult, UnprocessedComment, WorkerStateManager } from '@propr/core';
import {
    advanceFollowupHandoff, finalizeFollowupHandoff, handoffRepositoryKey, loadCancelledClaimIds, loadFollowupHandoff, recordFollowupHandoff,
    HANDOFF_ACTIVE, SETTLEMENT_RETRY_SCHEDULED, SETTLEMENT_RETRY_SCHEDULING, type FollowupHandoffRecord,
} from './followupHandoffStore.js';
import { adoptPredecessorFollowupHandoff, settleFollowupHandoffAfterFailure } from './followupHandoffRecovery.js';
import { delayPRCommentJobInPlace, predecessorWaitDelay, schedulePRCommentRecovery } from './prCommentCollisionRecovery.js';
import { releasePRProcessingLock, startPRProcessingLockHeartbeat } from './prProcessingLock.js';
import { releaseHeldHandoffOfClosedPullRequest, type PullRequestClosure } from './closedPullRequestHandoffs.js';
import type { ProcessingState } from './prPublicationRecovery.js';
import type { PullRequestPublication } from './prPublication.js';

/**
 * Durable follow-up publication handoff hooks for the PR comment job. The
 * handoff is written before the agent launches — bound to the PR's head/base
 * and the worktree baseline — advanced through every publication phase the
 * normal path completes (agent exit, commit, push, completion comment), and
 * retired only once the owed publication is proven delivered. A worker restart
 * at any point leaves a record that names its exact missing phase.
 */

/** The slice of processing state these hooks read and advance. */
export interface HandoffCarrier {
    followupHandoff?: FollowupHandoffRecord | null;
    /**
     * Set when a checkpoint observed the handoff move on without this writer.
     * A swallowed loss (the container-identity callback's) otherwise leaves
     * `followupHandoff` null, indistinguishable from never having recorded one.
     */
    followupHandoffOwnershipLost?: boolean;
}

interface HandoffRef { repoOwner: string; repoName: string; pullRequestNumber: number }

export interface RecordExecutionHandoffParams {
    state: ProcessingState;
    job: Job<CommentJobData>;
    ref: HandoffRef;
    taskId: string;
    correlationId: string;
    publication: PullRequestPublication;
    llm: string | null | undefined;
    lockKey: string;
    lockToken: string;
    /** PR head/base refs at launch; recovery revalidates them before pushing. */
    binding: { headRef?: string | null; baseRef?: string | null };
    correlatedLogger: Logger;
}

async function worktreeHeadSha(worktreePath: string): Promise<string | null> {
    try {
        return (await createHooklessGit(worktreePath).raw(['rev-parse', 'HEAD'])).trim() || null;
    } catch {
        return null;
    }
}

/** Persists the handoff right before the agent launches. */
export async function recordExecutionHandoff(params: RecordExecutionHandoffParams): Promise<void> {
    const { state, job, ref } = params;
    const worktreeInfo = state.worktreeInfo!;
    state.followupHandoff = await recordFollowupHandoff({
        ref, taskId: params.taskId,
        sourceTaskIds: [...(job.data.containerCollisionTaskIds ?? []), ...(job.data.containerCollisionTaskId ? [job.data.containerCollisionTaskId] : [])],
        correlationId: params.correlationId, target: params.publication.target,
        worktreePath: worktreeInfo.worktreePath, localRepoPath: state.localRepoPath!,
        claimedComments: state.unprocessedComments, jobData: job.data, llm: params.llm,
        lockKey: params.lockKey, lockToken: params.lockToken,
        startingCommentId: state.startingWorkComment?.data.id,
        binding: { ...params.binding, headSha: await worktreeHeadSha(worktreeInfo.worktreePath) },
    });
    if (!state.followupHandoff) {
        // An unresolved different-task row still owns the publication
        // obligation for this pull request; launching an untracked agent on
        // top of it would recreate the unrecoverable-restart failure.
        throw new Error(`Follow-up publication handoff for PR #${ref.pullRequestNumber} could not be recorded because an unresolved previous attempt still owns it; the agent launch is refused`);
    }
}

/** Thrown when the durable handoff moved on without this writer; continuing untracked would let recovery republish or restore already-addressed work. */
export class FollowupHandoffOwnershipLostError extends Error {
    constructor(reason: string) {
        super(`Follow-up publication handoff ownership was lost (${reason}); stopping before further publication`);
        this.name = 'FollowupHandoffOwnershipLostError';
    }
}

async function advanceExecutionHandoff(state: HandoffCarrier, changes: Parameters<typeof advanceFollowupHandoff>[2]): Promise<void> {
    // A loss an earlier checkpoint observed — including the swallowed
    // container-identity callback's — stops every later one: the cleared
    // record must not read as "no handoff" and let publication continue.
    if (state.followupHandoffOwnershipLost) throw new FollowupHandoffOwnershipLostError('handoff_ownership_already_lost');
    if (!state.followupHandoff) return;
    const record = state.followupHandoff;
    const advanced = await advanceFollowupHandoff({}, record, changes);
    if (advanced) {
        state.followupHandoff = advanced;
        return;
    }
    // A bare generation conflict can come from a benign concurrent write; it is
    // retried once from a re-read that proves this writer still owns the row.
    // Every adoption (standalone or in-line, including a same-task
    // redelivery's) installs a new owner token, so an unchanged token and
    // successor lineage are that proof. Anything else is lost ownership, and
    // the publication fails closed rather than continuing without durable
    // tracking.
    const fresh = await loadFollowupHandoff({}, record);
    if (fresh && fresh.task_id === record.task_id && fresh.incarnation === record.incarnation
        && fresh.status === HANDOFF_ACTIVE && fresh.lock_token === record.lock_token
        && fresh.successor_task_id === record.successor_task_id) {
        const retried = await advanceFollowupHandoff({}, fresh, changes);
        if (retried) {
            state.followupHandoff = retried;
            return;
        }
    }
    state.followupHandoff = null;
    state.followupHandoffOwnershipLost = true;
    throw new FollowupHandoffOwnershipLostError(fresh ? 'handoff_record_changed' : 'handoff_record_missing');
}

/**
 * The job result of a writer that observed its handoff move on to a recovery
 * successor. Ownership loss is a stop condition: the successor owns the
 * starting comment, the task's terminal state and the handoff settlement, so
 * no failure is published or settled for this writer.
 */
export function stopAfterHandoffOwnershipLoss(error: Error, correlatedLogger: Logger): JobResult {
    correlatedLogger.warn({ error: error.message }, 'Follow-up handoff ownership was lost; stopping without failure publication or settlement');
    return { status: 'skipped', reason: 'followup_handoff_ownership_lost' };
}

/**
 * The worktree this writer may still clean up. The successor that adopted the
 * handoff also owns its retained worktree: detaching it would break that
 * recovery's publication.
 */
export function writerOwnedWorktree<T>(state: HandoffCarrier & { worktreeInfo?: T }): T | undefined {
    return state.followupHandoffOwnershipLost ? undefined : state.worktreeInfo;
}

/** Binds the launched agent container's immutable identity to the handoff. */
export async function markExecutionHandoffContainer(state: HandoffCarrier, containerId: string): Promise<void> {
    await advanceExecutionHandoff(state, { container_id: containerId });
}

/**
 * Marks the agent exited so recovery knows execution itself finished, and
 * whether it reported full success — the only evidence that lets a recovered
 * completion comment bind the accepted request bodies, and that keeps a
 * successful run without file changes from being executed again. A success's
 * analysis is persisted with it, so that recovery can still deliver the
 * no-change completion answer the normal path owed.
 */
export async function markExecutionHandoffAgentExited(state: HandoffCarrier, agentCompleted: boolean, analysisSummary?: string | null): Promise<void> {
    await advanceExecutionHandoff(state, {
        phase: 'agent_exited', agent_completed: agentCompleted ? 1 : 0,
        agent_summary: agentCompleted ? analysisSummary || null : null,
    });
}

/** Records the normal path's commit so restart recovery resumes from the push, not from scratch. */
export async function markExecutionHandoffCommitted(state: HandoffCarrier, commitHash: string | null | undefined): Promise<void> {
    await advanceExecutionHandoff(state, { phase: 'committed', commit_hash: commitHash ?? null });
}

/** Records the normal path's completed push; recovery after this never reports missing work. */
export async function markExecutionHandoffPushed(state: HandoffCarrier, commitHash: string | null | undefined): Promise<void> {
    await advanceExecutionHandoff(state, { phase: 'pushed', commit_hash: commitHash ?? null });
}

/** Records the delivered completion comment so recovery never overwrites it with a failure notice. */
export async function markExecutionHandoffCommentPublished(state: HandoffCarrier, commentUrl: string | null | undefined): Promise<void> {
    await advanceExecutionHandoff(state, { phase: 'comment_published', completion_comment_url: commentUrl ?? null });
}

/**
 * Durably records that a usage-limit retry is taking over the claimed
 * comments: `scheduling` before the queue add, `scheduled` once the retry job
 * is persisted. A worker death before the handoff settles then never lets
 * recovery return comments the retry job owns to the pending list.
 *
 * `scheduling` fails closed: a failed write or lost ownership throws, so no
 * retry is added and the claim stays with the handoff, whose recovery returns
 * it exactly once. A failed `scheduled` confirmation write is only logged —
 * the retry already exists, and the durable `scheduling` state makes recovery
 * hold the handoff for an operator instead of requeueing. Lost ownership at
 * `scheduled` still throws: the adopting successor owns what follows.
 */
export async function checkpointExecutionHandoffUsageLimitRetry(
    state: HandoffCarrier,
    stage: 'scheduling' | 'scheduled',
    correlatedLogger: Logger,
): Promise<void> {
    if (stage === 'scheduling') {
        if (state.followupHandoffOwnershipLost) throw new FollowupHandoffOwnershipLostError('usage_limit_retry_not_owned');
        await advanceExecutionHandoff(state, { settlement: SETTLEMENT_RETRY_SCHEDULING });
        return;
    }
    try {
        await advanceExecutionHandoff(state, { settlement: SETTLEMENT_RETRY_SCHEDULED });
    } catch (error) {
        // A successor adopted the handoff while the retry was being scheduled:
        // it now owns the claim's settlement, so this writer must stop before
        // the delay comment and its own error settlement.
        if (error instanceof FollowupHandoffOwnershipLostError) throw error;
        correlatedLogger.warn({ stage, error: (error as Error).message },
            'Could not confirm the scheduled usage-limit retry on the follow-up handoff; recovery holds it as unconfirmed');
    }
}

/**
 * Marks the owed publication fully delivered. The row is retained at
 * cleanup_pending rather than deleted, because the branch stays attached to the
 * worktree until the job's cleanup runs: a worker death in that window leaves a
 * discoverable record whose recovery releases the branch without republishing.
 */
export async function markExecutionHandoffCleanupPending(state: HandoffCarrier, correlatedLogger: Logger): Promise<void> {
    try {
        await advanceExecutionHandoff(state, { phase: 'cleanup_pending' });
    } catch (error) {
        if (!(error instanceof FollowupHandoffOwnershipLostError)) throw error;
        // Publication is already complete; the row moved on to another owner,
        // who now carries the branch-cleanup obligation durably instead.
        correlatedLogger.warn({ error: error.message }, 'Could not record the follow-up handoff cleanup checkpoint after publication');
    }
}

/**
 * Retires the handoff only once the worktree cleanup proved branch release
 * (no Git worktree registration holds the branch any more). A still-held
 * branch — or unreadable registrations — keeps the row at
 * cleanup_pending, blocking successors until recovery releases it durably.
 */
export async function retireExecutionHandoffAfterCleanup(state: HandoffCarrier, correlatedLogger: Logger): Promise<void> {
    const record = state.followupHandoff;
    if (!record) return;
    state.followupHandoff = null;
    try {
        // Re-read: an error settlement may have advanced the row (or held it
        // for an operator) after this writer's copy; only this task's own
        // active cleanup_pending row may retire here.
        const fresh = await loadFollowupHandoff({}, record);
        if (!fresh || fresh.task_id !== record.task_id || fresh.incarnation !== record.incarnation
            || fresh.status !== HANDOFF_ACTIVE || fresh.phase !== 'cleanup_pending') return;
        const git = createFollowupHandoffGitOps(async () => {
            throw new Error('Branch-release evidence needs no push token');
        });
        // The repository's worktree registrations are the release proof: a
        // removed directory whose registration survives still holds the branch.
        const holders = await git.branchWorktreeRegistrations(fresh.local_repo_path, fresh.branch_name);
        if (holders.length > 0) {
            correlatedLogger.warn({ worktreePath: fresh.worktree_path, branchName: fresh.branch_name, holders },
                'The follow-up branch is still registered to a worktree after cleanup; the handoff is retained for recovery to release it');
            return;
        }
        await finalizeFollowupHandoff({}, fresh);
    } catch (error) {
        correlatedLogger.warn({ error: (error as Error).message },
            'Could not retire the follow-up handoff after cleanup; it stays recoverable');
    }
}

export interface PredecessorHandoffGateParams {
    job: Job<CommentJobData>;
    ref: HandoffRef;
    taskId: string;
    stateManager: WorkerStateManager;
    redisClient: Redis;
    pickedUpComments: UnprocessedComment[];
    /** The job's full captured comment set, filtered in place like `pickedUpComments`. */
    commentsToProcess?: UnprocessedComment[];
    lockKey: string;
    lockToken: string;
    correlatedLogger: Logger;
    /**
     * How the pull request was closed, or null while it is open. Read only when
     * a predecessor blocks this writer: a merged or closed pull request ends the
     * wait instead of waiting forever behind a hold nobody can publish.
     */
    pullRequestClosure?: () => Promise<PullRequestClosure | null>;
    /** Releases the closed pull request's operator-held follow-up; injectable for tests. */
    releaseClosedHold?: typeof releaseHeldHandoffOfClosedPullRequest;
}

/** Removes the given comment IDs from a captured set in place, returning how many were removed. */
function dropComments(comments: UnprocessedComment[], ids: ReadonlySet<number>): number {
    const kept = comments.filter(comment => !ids.has(comment.id));
    const removed = comments.length - kept.length;
    comments.splice(0, comments.length, ...kept);
    return removed;
}

/**
 * A follow-up claims pending comments before it takes the PR lease, so it can
 * capture a cancelled predecessor's restored claims and then be admitted after
 * an operator released that predecessor (the release's withdrawal finds the
 * pending list already empty). Under the lease, the captured set is reconciled
 * against the durable cancelled-claim evidence the release recorded — not
 * only the current handoff row, which an intervening follow-up may have
 * replaced and retired meanwhile; nothing a cancelled predecessor claimed may
 * execute.
 */
function dropReleasedCancelledClaims(
    params: PredecessorHandoffGateParams,
    claimIds: number[],
): JobResult | undefined {
    const ids = new Set(claimIds);
    const commentsToProcess = params.commentsToProcess ?? params.pickedUpComments;
    const removed = dropComments(commentsToProcess, ids);
    if (commentsToProcess !== params.pickedUpComments) dropComments(params.pickedUpComments, ids);
    if (removed === 0) return undefined;
    params.correlatedLogger.info({ cancelledClaimIds: claimIds, dropped: removed, remaining: commentsToProcess.length },
        'Dropped comments a released cancelled follow-up had claimed; they are not executed');
    return commentsToProcess.length === 0
        ? { status: 'skipped', reason: 'cancelled_predecessor_claims', pullRequestNumber: params.ref.pullRequestNumber }
        : undefined;
}

function predecessorBlockReason(adoption: Awaited<ReturnType<typeof adoptPredecessorFollowupHandoff>>): string | undefined {
    if ('blocked' in adoption && adoption.blocked) return adoption.blocked;
    // An operator hold produced by the inline resume itself (or a lost lease)
    // equally blocks this writer: the unresolved obligation must not be raced
    // or overwritten by a fresh worktree and handoff. A cleanup_pending outcome
    // blocks too — publication settled but the branch is still attached to the
    // retained worktree, so preparing another worktree on it would fail. An
    // unresolved superseded outcome (the row kept moving under re-reads) is
    // equally unsafe to race. retry_pending also blocks if the worktree vanished
    // during resume, after adoption's initial retry check.
    if ('resumed' in adoption && adoption.resumed
        && (adoption.resumed.outcome === 'awaiting_operator' || adoption.resumed.outcome === 'ownership_lost'
            || adoption.resumed.outcome === 'retry_pending' || adoption.resumed.outcome === 'cleanup_pending' || adoption.resumed.outcome === 'superseded')) {
        return `predecessor_${adoption.resumed.outcome}`;
    }
    return undefined;
}

/**
 * Runs under the caller's PR processing lease, before any new worktree is
 * prepared: a recoverable predecessor is adopted and finished in-line — with
 * the lease kept renewed for the duration — while a still-live, unverifiable,
 * or operator-held predecessor delays this writer in place (with backoff)
 * instead of letting it race the retained worktree; only a job no worker holds
 * falls back to a replacement job. A released cancelled predecessor's claims are
 * dropped from the captured comments; a job left with none is skipped.
 */
export async function gatePredecessorHandoff(params: PredecessorHandoffGateParams): Promise<JobResult | undefined> {
    const { job, ref, taskId, stateManager, redisClient, correlatedLogger } = params;
    let leaseLost = false;
    const stopHeartbeat = startPRProcessingLockHeartbeat({
        redisClient, lockKey: params.lockKey, lockToken: params.lockToken,
        onLockLost: () => { leaseLost = true; },
        onError: error => correlatedLogger.warn({ lockKey: params.lockKey, error: (error as Error).message }, 'Failed to renew PR processing lock during predecessor handoff adoption'),
    });
    let adoption: Awaited<ReturnType<typeof adoptPredecessorFollowupHandoff>> = {};
    let blocked: string | undefined;
    let cancelledClaimIds: number[] = [];
    try {
        // A superseded outcome means the row moved on mid-adoption; re-read and
        // resolve it before admitting this writer instead of racing an unknown
        // state. Persistent supersession falls through as a blocking reason.
        for (let attempt = 0; ; attempt += 1) {
            adoption = await adoptPredecessorFollowupHandoff(
                { ...ref, currentTaskId: taskId, log: correlatedLogger, lockToken: params.lockToken, isOwnershipLost: () => leaseLost },
                { redis: redisClient, stateManager },
            );
            if (attempt >= 2 || !('resumed' in adoption) || adoption.resumed?.outcome !== 'superseded') break;
        }
        cancelledClaimIds = await loadCancelledClaimIds({}, { repository: handoffRepositoryKey(ref.repoOwner, ref.repoName), pull_request: ref.pullRequestNumber });
    } catch (error) {
        // Fail closed: an adoption this writer could not verify or finish (for
        // example unavailable remote evidence) leaves the predecessor's
        // obligation standing, so the successor reschedules instead of racing
        // the retained worktree with a fresh one.
        correlatedLogger.warn({ error: (error as Error).message }, 'Predecessor follow-up handoff adoption failed; rescheduling this writer');
        blocked = 'predecessor_recovery_failed';
    } finally {
        await stopHeartbeat();
    }
    blocked ??= predecessorBlockReason(adoption);
    if (!blocked) {
        if ('releasedCancelledClaimIds' in adoption) cancelledClaimIds.push(...adoption.releasedCancelledClaimIds);
        if (cancelledClaimIds.length === 0) return undefined;
        const skipped = dropReleasedCancelledClaims(params, cancelledClaimIds);
        if (skipped) await releasePRProcessingLock(redisClient, params.lockKey, params.lockToken);
        return skipped;
    }
    const closed = await endWaitOnClosedPullRequest(params, blocked);
    if (closed) return closed;
    // Wait in place as the same job and task, backing off: an operator hold
    // can stand for days, and a fresh replacement every minute left thousands
    // of cancelled tasks behind a single unanswered follow-up.
    const waited = await delayPRCommentJobInPlace({ job, taskId, redisClient, pickedUpComments: params.pickedUpComments, correlatedLogger }, {
        attemptsField: 'predecessorWaitAttempts', delayFor: predecessorWaitDelay, reason: blocked,
        message: 'A predecessor follow-up handoff blocks this PR; waiting in place',
    });
    if (waited) {
        await releasePRProcessingLock(redisClient, params.lockKey, params.lockToken);
        throw new DelayedError();
    }
    const replacementTaskId = await schedulePRCommentRecovery({
        job, taskId, stateManager, redisClient, pickedUpComments: params.pickedUpComments,
        delay: 60_000, reason: blocked, correlatedLogger,
    });
    await releasePRProcessingLock(redisClient, params.lockKey, params.lockToken);
    return { status: 'rescheduled', reason: blocked, replacementTaskId };
}

/**
 * A blocked writer on a merged or closed pull request stops instead of
 * waiting: nothing can be published there, and the hold it waits behind would
 * never be settled. Its captured comments are not returned to the pending
 * list, exactly as for a job that finds the pull request closed later on, and
 * the hold itself is released once this job has let go of the PR lease.
 */
async function endWaitOnClosedPullRequest(params: PredecessorHandoffGateParams, blocked: string): Promise<JobResult | undefined> {
    const { ref, redisClient, correlatedLogger } = params;
    let closure: PullRequestClosure | null = null;
    try {
        closure = await params.pullRequestClosure?.() ?? null;
    } catch (error) {
        correlatedLogger.warn({ error: (error as Error).message }, 'Could not read the pull request state while blocked by a predecessor; waiting');
    }
    if (!closure) return undefined;
    await releasePRProcessingLock(redisClient, params.lockKey, params.lockToken);
    const release = await (params.releaseClosedHold ?? releaseHeldHandoffOfClosedPullRequest)(ref, closure, { redis: redisClient as never });
    correlatedLogger.info({ pullRequestNumber: ref.pullRequestNumber, closure, blocked, holdReleased: release.released, releaseReason: release.reason },
        'Pull request is closed; ending the follow-up instead of waiting behind its predecessor');
    return { status: 'cancelled', reason: 'cancelled_pr_closed', pullRequestNumber: ref.pullRequestNumber };
}

export interface HandoffErrorSettlementParams {
    ref: HandoffRef;
    taskId: string;
    error: Error;
    cancelledState: { state: string } | null;
    cancelledStateName: string;
    correlatedLogger: Logger;
}

/**
 * Settles the handoff after the in-process error handler delivered the owed
 * failure comment and terminal state. Retained unpublished work keeps the
 * record recoverable, and a user cancellation holds it for an explicit
 * operator decision.
 */
export async function settleExecutionHandoffAfterError(params: HandoffErrorSettlementParams): Promise<void> {
    const { ref, taskId, error, cancelledState, correlatedLogger } = params;
    try {
        await settleFollowupHandoffAfterFailure({
            ...ref, taskId,
            cancelled: cancelledState?.state === params.cancelledStateName || Boolean(error.message?.includes('aborted by user')),
        });
    } catch (settleError) {
        correlatedLogger.warn({ error: (settleError as Error).message }, 'Could not settle the follow-up publication handoff after a failure');
    }
}
