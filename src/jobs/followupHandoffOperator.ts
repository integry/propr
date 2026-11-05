import { randomUUID } from 'node:crypto';
import { inspectTaskContainerLivenessForTask } from '@propr/core';
import { adoptPRProcessingLock, releasePRProcessingLock } from './prProcessingLock.js';
import {
    containerIdentityConflict, recordFailedClosed, resolveHandoffRedis, resolveRecoveryDeps,
    type FollowupHandoffRecoveryDeps, type HandoffRedis, type ResolvedRecoveryDeps, type TaskContainerInspection,
} from './followupHandoffDeps.js';
import {
    advanceFollowupHandoff, inFollowupHandoffTransaction, loadFollowupHandoff, loadFollowupHandoffs, parseClaimedComments, parseSourceTaskIds,
    recordCancelledClaims, retryOwnsClaims, revokeCancelledClaims,
    HANDOFF_ACTIVE, HANDOFF_AWAITING_OPERATOR, HANDOFF_RELEASED, SETTLEMENT_RETRY_SCHEDULED, SETTLEMENT_RETRY_SCHEDULING,
    type FollowupHandoffKey, type FollowupHandoffRecord, type FollowupHandoffStoreDeps,
} from './followupHandoffStore.js';
import type { FollowupHandoffGitOps } from './followupHandoffGitOps.js';

/**
 * Operator actions over durable follow-up publication handoffs, exposed
 * through the admin API and the packaged CLI. None of them delete retained
 * worktrees or commits, and every mutation serializes under the pull request's
 * processing lease against the row re-read under it; release additionally
 * requires the recorded agent proven gone first.
 */

type OperatorLeaseResult<T> = { value: T } | { refused: 'lease_held_by_live_writer' | 'superseded' };

/**
 * Runs an operator mutation under the pull request's processing lease, taken
 * over only from the handoff's recorded token, against the row re-read under
 * that lease. Authorization, resume and release all take it, so none of them
 * can change the handoff while another is between its checks and its
 * worktree or database mutations; a row that moved on since the caller read
 * it is refused as superseded instead of acted on from the stale snapshot.
 */
async function underOperatorLease<T>(
    record: FollowupHandoffRecord,
    deps: { store: FollowupHandoffStoreDeps; redis: HandoffRedis },
    action: string,
    run: (fresh: FollowupHandoffRecord) => Promise<T>,
): Promise<OperatorLeaseResult<T>> {
    const successorToken = `handoff-${action}:${record.incarnation}:${randomUUID()}`;
    const adoption = await adoptPRProcessingLock(deps.redis, record.lock_key, {
        predecessorToken: record.lock_token, successorToken,
    });
    if (adoption !== 'adopted') return { refused: 'lease_held_by_live_writer' };
    try {
        const fresh = await loadFollowupHandoff(deps.store, record);
        if (!fresh || fresh.task_id !== record.task_id || fresh.incarnation !== record.incarnation
            || fresh.generation !== record.generation) {
            return { refused: 'superseded' };
        }
        return { value: await run(fresh) };
    } finally {
        await releasePRProcessingLock(deps.redis, record.lock_key, successorToken);
    }
}

async function withOperatorRedis<T>(
    deps: FollowupHandoffRecoveryDeps,
    run: (redis: HandoffRedis) => Promise<T>,
): Promise<T> {
    const { redis, ownRedis } = await resolveHandoffRedis(deps);
    try {
        return await run(redis);
    } finally {
        if (ownRedis) await redis.quit?.();
    }
}

/**
 * Re-arms a cancelled, operator-held handoff for publication under explicit
 * operator authority. Null when the handoff is missing, not operator-held,
 * changed concurrently, or its pull request lease is held by another writer.
 * A refused release may already have recorded the claims as suppressed; that
 * evidence is revoked in the same transaction, so recovery's return of the
 * authorized request to the queue is never dropped at admission. A
 * scheduled usage-limit retry owns its request, so authorizing its hold only
 * re-arms recovery to hand the request to that retry, never to publish.
 */
export async function authorizeCancelledFollowupHandoff(
    key: FollowupHandoffKey,
    deps: FollowupHandoffRecoveryDeps = {},
): Promise<FollowupHandoffRecord | null> {
    const store = deps.store ?? {};
    const record = await loadFollowupHandoff(store, key);
    if (!record || record.status !== HANDOFF_AWAITING_OPERATOR) return null;
    const result = await withOperatorRedis(deps, redis => underOperatorLease(record, { store, redis }, 'authorize',
        fresh => inFollowupHandoffTransaction(store, async transactional => {
            const authorized = await advanceFollowupHandoff(transactional, fresh, retryOwnsClaims(fresh)
                ? { status: HANDOFF_ACTIVE, status_reason: 'usage_limit_retry' }
                : { status: HANDOFF_ACTIVE, status_reason: 'operator_authorized', operator_authorized: 1 });
            if (authorized) await revokeCancelledClaims(transactional, fresh);
            return authorized;
        })));
    return 'value' in result ? result.value : null;
}

export interface OperatorResumeResult { resumed: boolean; reason?: string }

/**
 * Reactivates an operator-held handoff after its blocking condition was
 * repaired (for example a restored worktree registration), without granting
 * cancelled-work publication authority: a cancellation hold still requires the
 * explicit authorization step.
 */
export async function resumeOperatorHeldFollowupHandoff(
    key: FollowupHandoffKey,
    deps: FollowupHandoffRecoveryDeps = {},
    options: { automatic?: boolean } = {},
): Promise<OperatorResumeResult> {
    const store = deps.store ?? {};
    const record = await loadFollowupHandoff(store, key);
    if (!record) return { resumed: false, reason: 'not_found' };
    if (record.status === HANDOFF_ACTIVE) return { resumed: true };
    if (record.status !== HANDOFF_AWAITING_OPERATOR) return { resumed: false, reason: 'released' };
    // A retry-owned hold is no user cancellation, and its resumption publishes
    // nothing: recovery hands the request to the scheduled retry.
    if (record.status_reason === 'cancelled_by_user' && !record.operator_authorized && !retryOwnsClaims(record)) {
        return { resumed: false, reason: 'requires_cancellation_authorization' };
    }
    // An unconfirmed usage-limit retry is resolved by this decision: the
    // operator found no retry job, so resuming returns the request to the queue.
    const result = await withOperatorRedis(deps, redis => underOperatorLease(record, { store, redis }, 'resume',
        async fresh => {
            if (options.automatic) {
                const resolved = await resolveRecoveryDeps({ ...deps, redis });
                // Recheck after acquiring the lease: the queue may have scheduled
                // a retry while this pass waited. Explicit operator resumes keep
                // their existing semantics.
                const state = (await resolved.stateManager.getTaskState(fresh.task_id))?.state;
                if (state && ![resolved.taskStates.COMPLETED, resolved.taskStates.FAILED].includes(state)) return null;
            }
            return advanceFollowupHandoff(store, fresh, {
                status: HANDOFF_ACTIVE, status_reason: 'operator_resumed',
                ...(fresh.settlement === SETTLEMENT_RETRY_SCHEDULING ? { settlement: null } : {}),
            });
        }));
    if (!('value' in result)) return { resumed: false, reason: result.refused };
    return result.value ? { resumed: true } : { resumed: false, reason: 'superseded' };
}

/**
 * Refusal reason while any linked worktree registration still holds the
 * branch, or when the registrations cannot be read; null once it is free.
 */
async function branchReleaseRefusal(
    git: FollowupHandoffGitOps,
    record: FollowupHandoffRecord,
): Promise<'branch_still_registered' | 'worktree_registrations_unavailable' | null> {
    try {
        const holders = await git.branchWorktreeRegistrations(record.local_repo_path, record.branch_name);
        return holders.length > 0 ? 'branch_still_registered' : null;
    } catch {
        return 'worktree_registrations_unavailable';
    }
}

/**
 * A cancelled request must never become executable through its release. A
 * recovery that restored the claimed comments can die before withdrawing them,
 * or its withdrawal can fail; either way the hold survives without proof the
 * comments left the pending list. The task state — not the mutable status
 * reason a later diagnostic overwrites — decides, and the idempotent
 * withdrawal must succeed before the row may stop blocking admission. A
 * follow-up may already have captured the comments before taking the PR
 * lease, so the claim IDs are first recorded as durable suppression evidence
 * that outlives this replaceable row; that write must succeed too.
 */
async function cancelledClaimsRefusal(
    record: FollowupHandoffRecord,
    deps: ResolvedRecoveryDeps,
): Promise<'cancelled_claims_withdrawal_failed' | null> {
    // A scheduled usage-limit retry owns the claims, and the CANCELLED state
    // its requeue left on the replaced attempt is no user cancellation.
    if (record.operator_authorized || retryOwnsClaims(record)) return null;
    try {
        const task = await deps.stateManager.getTaskState(record.task_id);
        if (record.status_reason !== 'cancelled_by_user' && task?.state !== deps.taskStates.CANCELLED) return null;
        const claimed = parseClaimedComments(record);
        await recordCancelledClaims(deps.store, record, claimed.map(comment => comment.id));
        await deps.withdrawRestoredComments(record, claimed);
        return null;
    } catch (error) {
        deps.log.warn({ taskId: record.task_id, repository: record.repository, pullRequest: record.pull_request, error: (error as Error).message },
            'Could not withdraw the claimed comments of a cancelled follow-up; the handoff is not released');
        return 'cancelled_claims_withdrawal_failed';
    }
}

/**
 * Releasing an unconfirmed usage-limit retry is the operator's decision that
 * the retry job exists and owns the request (resume is the decision that it
 * does not). The requeue left this attempt CANCELLED, so without persisting
 * that ownership first, the release and every later admission would read the
 * attempt as a user cancellation and suppress the retry's own comments. Any
 * suppression evidence this task recorded is revoked in the same transaction.
 */
async function confirmUnconfirmedRetryOwnership(
    record: FollowupHandoffRecord,
    store: FollowupHandoffStoreDeps,
): Promise<FollowupHandoffRecord | null> {
    if (record.settlement !== SETTLEMENT_RETRY_SCHEDULING) return record;
    return inFollowupHandoffTransaction(store, async transactional => {
        const confirmed = await advanceFollowupHandoff(transactional, record, { settlement: SETTLEMENT_RETRY_SCHEDULED });
        if (confirmed) await revokeCancelledClaims(transactional, record);
        return confirmed;
    });
}

/**
 * Marks a handoff released so recovery stops attempting it. Never deletes the
 * worktree or any commits: it only detaches the worktree HEAD to free the
 * branch, and refuses even that while unpublished work exists unless the
 * operator forces it (files and commits stay in the worktree either way).
 * The row is marked released only once no Git worktree registration holds the
 * branch any more; otherwise the obligation stays and the refusal names why.
 * The mutation runs only with the recorded agent proven gone and under the
 * pull request's processing lease, so it can never detach a live writer. A
 * cancelled request's claimed comments are withdrawn from the pending list
 * first; the release is refused until that withdrawal succeeds. Releasing an
 * unconfirmed usage-limit retry first records that the retry owns the request.
 */
export async function releaseFollowupHandoffRecord(
    key: FollowupHandoffKey,
    options: {
        force?: boolean;
        /** Recorded status reason; defaults to an operator release. */
        reason?: string;
        /**
         * Restart the freed branch from the remote head when it still carries the
         * attempt's unpublished commits (kept under refs/propr/superseded/), so the
         * next worktree does not inherit them; refused when that cannot be ensured.
         */
        restartBranch?: boolean;
    },
    deps: FollowupHandoffRecoveryDeps = {},
): Promise<{ released: boolean; reason?: string }> {
    const resolved = await resolveRecoveryDeps(deps);
    try {
        const record = await loadFollowupHandoff(resolved.store, key);
        if (!record) return { released: false, reason: 'not_found' };
        if (record.status === HANDOFF_RELEASED) return { released: true };
        const inspection = await resolved.inspectLiveness(record.task_id);
        const identityConflict = containerIdentityConflict(record, inspection);
        if (identityConflict) {
            await recordFailedClosed(record, resolved, identityConflict);
            return { released: false, reason: identityConflict };
        }
        if (inspection.liveness === 'running') return { released: false, reason: 'agent_still_running' };
        if (inspection.liveness !== 'stopped' && inspection.liveness !== 'not_found') {
            // Unverifiable liveness refuses even a forced release: a separate
            // explicit stop procedure must settle the agent first.
            return { released: false, reason: 'liveness_unavailable' };
        }
        // The checks above read an unlocked snapshot: a concurrent
        // authorization or resume may re-arm the handoff before this lease is
        // taken, so every worktree mutation acts on the row re-read under it.
        const result = await underOperatorLease(record, resolved, 'release', async read => {
            const fresh = await confirmUnconfirmedRetryOwnership(read, resolved.store);
            if (!fresh) return { released: false, reason: 'superseded' };
            const claimsRefusal = await cancelledClaimsRefusal(fresh, resolved);
            if (claimsRefusal) return { released: false, reason: claimsRefusal };
            const settled = await resolved.git.releaseSettledWorktree(fresh.local_repo_path, fresh.branch_name, fresh.worktree_path);
            if (!settled && !options.force) {
                return { released: false, reason: 'worktree_holds_unpublished_work' };
            }
            if (!settled && options.force) {
                const attachment = await resolved.git.worktreeAttachment(fresh.worktree_path, fresh.branch_name);
                if (attachment === 'attached') await resolved.git.detachWorktreeHead(fresh.worktree_path);
            }
            // Permission to attempt the release is not proof it happened: a
            // removed directory whose Git registration survives still holds
            // the branch, and admission ignores a released row. The
            // repository's own registrations must show the branch free.
            const refusal = await branchReleaseRefusal(resolved.git, fresh);
            if (refusal) return { released: false, reason: refusal };
            if (options.restartBranch && !await resolved.git.restartBranchFromRemoteHead(fresh.local_repo_path, fresh.branch_name)) {
                return { released: false, reason: 'unpublished_commits_still_on_branch' };
            }
            const advanced = await advanceFollowupHandoff(resolved.store, fresh, {
                status: HANDOFF_RELEASED,
                status_reason: options.reason ?? (options.force ? 'released_by_operator_force' : 'released_by_operator'),
            });
            return { released: Boolean(advanced), reason: advanced ? undefined : 'superseded' };
        });
        return 'value' in result ? result.value : { released: false, reason: result.refused };
    } finally {
        if (resolved.ownRedis) await resolved.redis.quit?.();
    }
}

export interface FollowupHandoffStatus {
    record: FollowupHandoffRecord;
    liveness: string;
    nextAction: string;
    predecessorTaskIds: string[];
    successorTaskId: string | null;
}

function handoffNextAction(record: FollowupHandoffRecord, liveness: string): string {
    if (record.status === HANDOFF_RELEASED) return 'none';
    if (retryOwnsClaims(record)) {
        return record.status === HANDOFF_AWAITING_OPERATOR
            ? 'resume to hand the request to the scheduled usage-limit retry (retained edits are never published), or release to stop tracking it'
            : 'the scheduled usage-limit retry owns the request; automatic recovery frees the branch and keeps retained edits unpublished';
    }
    if (record.status === HANDOFF_AWAITING_OPERATOR) {
        return record.status_reason === 'cancelled_by_user'
            ? 'resume --authorize-cancelled to publish the cancelled work, or release to stop tracking it'
            : record.status_reason === 'usage_limit_retry_unconfirmed'
                ? 'check the issue queue for the usage-limit retry job: release if it exists (the retry keeps the request; retained edits stay unpublished), or resume to return the request to the queue'
                : 'repair the reported condition, then resume to re-arm recovery, or release to stop tracking it';
    }
    if (record.phase === 'cleanup_pending') return 'publication is complete; automatic recovery retries the branch release';
    if (liveness === 'running') return 'wait for the live agent container to exit';
    if (liveness !== 'stopped' && liveness !== 'not_found') return 'restore container runtime visibility; recovery fails closed until liveness is known';
    return 'automatic recovery will resume the missing publication phase';
}

/** Non-destructive status for the operator CLI/API and task timeline. */
export async function inspectFollowupHandoffs(
    deps: FollowupHandoffRecoveryDeps = {},
    key?: FollowupHandoffKey,
): Promise<FollowupHandoffStatus[]> {
    const store: FollowupHandoffStoreDeps = deps.store ?? {};
    const inspectLiveness = deps.inspectLiveness
        ?? ((taskId: string): Promise<TaskContainerInspection> => inspectTaskContainerLivenessForTask(taskId));
    const records = key
        ? [await loadFollowupHandoff(store, key)].filter((record): record is FollowupHandoffRecord => Boolean(record))
        : await loadFollowupHandoffs(store);
    const statuses: FollowupHandoffStatus[] = [];
    for (const record of records) {
        const { liveness } = record.status === HANDOFF_ACTIVE
            ? await inspectLiveness(record.task_id)
            : { liveness: 'not_checked' };
        statuses.push({
            record, liveness, nextAction: handoffNextAction(record, liveness),
            predecessorTaskIds: parseSourceTaskIds(record),
            successorTaskId: record.successor_task_id,
        });
    }
    return statuses;
}
