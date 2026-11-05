import {
    advanceFollowupHandoff, finalizeFollowupHandoff, parseClaimedComments, parseSourceTaskIds, retryOwnsClaims,
    HANDOFF_AWAITING_OPERATOR, SETTLEMENT_RETRY_SCHEDULING, SETTLEMENT_RETURNED_TO_QUEUE,
    type FollowupHandoffRecord,
} from './followupHandoffStore.js';

import { isNonFastForwardPushError } from './followupHandoffGitOps.js';
import { handoffCommentMarker } from './followupHandoffMarker.js';
import { pendingRetryHold } from './followupHandoffTaskState.js';
import {
    deliveredOutcome, failedOutcomes, interruptedWithoutChangesBody, normalDelivery, recoveredCompletionBody, recoveredNoChangeCompletionBody,
    recoveredTaskReasons, recoveredTaskRecaps, recoveryCommitMessage, worktreeWasLost, WORKTREE_LOST_REASON,
    type OwedCommentDelivery, type RecoveredTaskOutcome,
} from './followupHandoffMessages.js';

import {
    splitHandoffRepository, type HandoffTaskStates, type IssueComment, type ResumeFollowupHandoffParams, type ResumeOutcome,
} from './followupHandoffResumeTypes.js';

export { createFollowupHandoffGitOps, type FollowupHandoffGitOps, type WorktreeAttachment } from './followupHandoffGitOps.js';
export {
    splitHandoffRepository, type HandoffOctokit, type HandoffStateManager, type HandoffTaskStates, type LoggerLike,
    type ResumeFollowupHandoffParams, type ResumeOutcome,
} from './followupHandoffResumeTypes.js';

/**
 * Resumes the exact missing publication phase of an adopted follow-up handoff.
 * Every step is idempotent: committing is skipped when the worktree is clean,
 * pushing an already-published head is up to date, the owed comment is
 * deduplicated by a durable marker, and the task finalizer refuses terminal
 * states — so duplicate recovery passes can never publish twice. The handoff
 * row itself survives until the branch is proven free again (cleanup_pending),
 * so a crash around branch release retries cleanup without republishing.
 */


export { handoffCommentMarker } from './followupHandoffMarker.js';

type ResumeStep = { record: FollowupHandoffRecord } | { done: ResumeOutcome };

async function holdForOperator(params: ResumeFollowupHandoffParams, record: FollowupHandoffRecord, reason: string): Promise<ResumeOutcome> {
    const advanced = await advanceFollowupHandoff(params.store, record, {
        status: HANDOFF_AWAITING_OPERATOR, status_reason: reason,
    });
    if (!advanced) return { outcome: 'superseded' };
    await reportHandoffOnTaskTimeline(params, advanced, `awaiting operator: ${reason}`);
    params.log.warn({ taskId: record.task_id, repository: record.repository, pullRequest: record.pull_request, reason, worktreePath: record.worktree_path },
        'Follow-up handoff needs an operator decision; retained work is preserved');
    return { outcome: 'awaiting_operator', reason };
}

/** Best-effort recovery status on the originating task's timeline for the UI/API. */
export async function reportHandoffOnTaskTimeline(
    params: Pick<ResumeFollowupHandoffParams, 'stateManager' | 'log' | 'recoveredBy'>,
    record: FollowupHandoffRecord,
    nextAction: string,
): Promise<void> {
    try {
        const current = await params.stateManager.getTaskState(record.task_id);
        if (!current) return;
        // Host filesystem paths stay off the member-visible timeline; the
        // operator-only status API exposes the retained worktree path instead.
        await params.stateManager.updateHistoryMetadata(record.task_id, current.state, {
            followupPublicationHandoff: {
                phase: record.phase, status: record.status, statusReason: record.status_reason,
                branchName: record.branch_name,
                predecessorTaskIds: parseSourceTaskIds(record),
                ...(successorTaskId(params, record) ? { successorTaskId: successorTaskId(params, record) } : {}),
                nextAction,
            },
        });
    } catch (error) {
        params.log.warn({ taskId: record.task_id, error: (error as Error).message }, 'Could not record follow-up handoff status on the task timeline');
    }
}

function successorTaskId(params: Pick<ResumeFollowupHandoffParams, 'recoveredBy'>, record: FollowupHandoffRecord): string | null {
    return params.recoveredBy ?? record.successor_task_id ?? null;
}

/** True (and logged) when the PR processing lease was lost: no further mutation may run. */
function ownershipLost(params: ResumeFollowupHandoffParams, record: FollowupHandoffRecord): boolean {
    if (!params.isOwnershipLost?.()) return false;
    params.log.warn({ taskId: record.task_id, repository: record.repository, pullRequest: record.pull_request },
        'Lost the PR processing lease during follow-up handoff recovery; stopping before further mutations');
    return true;
}

/**
 * Best effort by necessity: the operator hold that follows is the durable
 * obligation, and a withdrawal failure is logged rather than letting it skip
 * that hold. The release of a cancelled hold repeats the withdrawal and
 * refuses until it succeeds, so a failed withdrawal is never forgotten.
 */
async function withdrawCancelledClaims(params: ResumeFollowupHandoffParams, record: FollowupHandoffRecord): Promise<void> {
    if (!params.withdrawRestoredComments) return;
    try {
        await params.withdrawRestoredComments(record, parseClaimedComments(record));
    } catch (error) {
        params.log.error({ taskId: record.task_id, repository: record.repository, pullRequest: record.pull_request, error: (error as Error).message },
            'Could not withdraw restored comments of a cancelled follow-up from the pending list');
    }
}

/**
 * Holds a cancelled handoff after conservatively withdrawing its claimed
 * comments from the pending list. Whether an earlier pass restored them is
 * unknowable after a crash between the restoration and its own withdrawal,
 * and withdrawing comments that were never restored is a no-op, so every
 * cancellation hold reconciles the withdrawal — not only the pass that
 * observed the cancellation while restoring.
 */
async function holdCancelled(params: ResumeFollowupHandoffParams, record: FollowupHandoffRecord): Promise<ResumeOutcome> {
    await withdrawCancelledClaims(params, record);
    return holdForOperator(params, record, 'cancelled_by_user');
}

/**
 * User cancellation is authoritative: re-checked before every publication
 * step. The task-state read is itself awaited, so a lease loss it observed is
 * reported too — neither an operator hold nor the caller's mutation may follow.
 */
async function cancellationHold(params: ResumeFollowupHandoffParams, record: FollowupHandoffRecord): Promise<ResumeOutcome | null> {
    if (record.operator_authorized) return ownershipLost(params, record) ? { outcome: 'ownership_lost' } : null;
    const taskState = await params.stateManager.getTaskState(record.task_id);
    if (ownershipLost(params, record)) return { outcome: 'ownership_lost' };
    if (taskState?.state !== params.taskStates.CANCELLED) return null;
    return holdCancelled(params, record);
}

/**
 * Revalidates publication authority immediately before the push: the pull
 * request must still have the head/base refs the handoff was bound to, and the
 * remote branch head must be our own baseline or our own earlier push. A
 * retargeted PR or an externally advanced head fails closed and preserves the
 * handoff for an operator.
 */
async function validatePublicationBinding(params: ResumeFollowupHandoffParams, record: FollowupHandoffRecord): Promise<ResumeOutcome | null> {
    if (record.head_ref || record.base_ref) {
        const { owner, repo } = splitHandoffRepository(record.repository);
        const { data } = await params.octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
            owner, repo, pull_number: record.pull_request,
        });
        const pr = data as { head?: { ref?: string }; base?: { ref?: string } };
        if ((record.head_ref && pr.head?.ref !== record.head_ref) || (record.base_ref && pr.base?.ref !== record.base_ref)) {
            return holdForOperator(params, record, 'pr_binding_mismatch');
        }
    }
    const remoteHead = await params.git.remoteBranchHead(record.worktree_path, record.branch_name);
    if (remoteHead && remoteHead !== record.head_sha && !(await params.git.isAncestorOfHead(record.worktree_path, remoteHead))) {
        return holdForOperator(params, record, 'head_advanced_externally');
    }
    return null;
}

/**
 * Publishes the owed comment exactly once, keyed by the handoff's durable
 * marker. Delivered evidence is reconciled first: the normal path publishes
 * its completion (carrying the same marker) before checkpointing the URL, so a
 * worker death in that window leaves a delivered comment this recovery must
 * checkpoint unchanged, never overwrite through the starting comment or
 * duplicate. The lease can be lost — and the user can cancel — while any of
 * these GitHub requests is awaited, so both are re-checked immediately before
 * each mutation: the starting-comment PATCH and the fallback POST (which also
 * covers a PATCH that found its comment deleted).
 *
 * A found normal failure notice is delivered evidence for a no-change
 * outcome, but not for publishing recovered work: with `supersedeFailure` it
 * is overwritten in place by the recovered completion, exactly as the failure
 * settlement's later recovery would have overwritten the starting comment.
 */
async function publishOwedComment(
    params: ResumeFollowupHandoffParams,
    record: FollowupHandoffRecord,
    body: string,
    { supersedeFailure = false }: { supersedeFailure?: boolean } = {},
): Promise<OwedCommentDelivery | { done: ResumeOutcome }> {
    if (record.completion_comment_url) return { url: record.completion_comment_url, delivery: 'recovery' };
    const { owner, repo } = splitHandoffRepository(record.repository);
    const marker = handoffCommentMarker(record);
    const comments = await params.octokit.paginate('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', {
        owner, repo, issue_number: record.pull_request, per_page: 100,
    }) as IssueComment[];
    const existing = comments.find(comment => comment.body?.includes(marker));
    const existingDelivery = existing && normalDelivery(existing.body);
    if (existing && !(supersedeFailure && existingDelivery === 'normal_failure')) {
        return { url: existing.html_url ?? null, delivery: existingDelivery ?? 'recovery' };
    }
    const patchTarget = existing?.id ?? record.starting_comment_id;
    if (patchTarget) {
        const hold = await cancellationHold(params, record);
        if (hold) return { done: hold };
        try {
            const { data } = await params.octokit.request('PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}', {
                owner, repo, comment_id: patchTarget, body,
            });
            return { url: (data as IssueComment).html_url ?? null, delivery: 'recovery' };
        } catch (error) {
            if ((error as { status?: number }).status !== 404) throw error;
        }
    }
    const hold = await cancellationHold(params, record);
    if (hold) return { done: hold };
    const { data } = await params.octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
        owner, repo, issue_number: record.pull_request, body,
    });
    return { url: (data as IssueComment).html_url ?? null, delivery: 'recovery' };
}

const terminalStates = (taskStates: HandoffTaskStates): Set<string> =>
    new Set([taskStates.COMPLETED, taskStates.FAILED, taskStates.CANCELLED]);

/**
 * Settles the originating task. Reports 'ownership_lost', without touching
 * the task, when the lease was lost during the state read. For a no-change
 * outcome — whose claimed comments were just returned to the queue — a
 * cancellation found here (the last read before cleanup) reports 'cancelled'
 * so the caller withdraws them, instead of treating the cancelled task as
 * already final and letting the queued follow-up execute them. The same holds
 * for a cancellation that lands while the final transition is awaited, which
 * the state manager reports by returning the cancelled state.
 */
async function finalizeRecoveredTask(
    params: ResumeFollowupHandoffParams,
    record: FollowupHandoffRecord,
    outcome: RecoveredTaskOutcome,
): Promise<'finalized' | 'ownership_lost' | 'cancelled'> {
    const { stateManager, taskStates } = params;
    const current = await stateManager.getTaskState(record.task_id);
    if (ownershipLost(params, record)) return 'ownership_lost';
    if (outcome === 'no_changes' && current?.state === taskStates.CANCELLED && !record.operator_authorized) return 'cancelled';
    const historyMetadata = {
        followupPublicationHandoff: {
            recovered: true, phase: record.phase, branchName: record.branch_name,
            predecessorTaskIds: parseSourceTaskIds(record),
            ...(successorTaskId(params, record) ? { successorTaskId: successorTaskId(params, record) } : {}),
        },
        notificationRecap: recoveredTaskRecaps[outcome],
    };
    if (current && terminalStates(taskStates).has(current.state)) {
        await reportHandoffOnTaskTimeline(params, record, 'publication recovered; task already final');
        return 'finalized';
    }
    const updated = await stateManager.updateTaskState(record.task_id, failedOutcomes.has(outcome) ? taskStates.FAILED : taskStates.COMPLETED, {
        reason: recoveredTaskReasons[outcome],
        ...(outcome === 'published' && record.commit_hash ? { commitHash: record.commit_hash } : {}),
        historyMetadata,
    });
    // The state manager re-reads inside its CAS loop and returns a concurrent
    // cancellation unchanged instead of applying the transition: honor it.
    if (outcome === 'no_changes' && !record.operator_authorized
        && updated?.state === taskStates.CANCELLED) return 'cancelled';
    return 'finalized';
}

/**
 * What a retired handoff reports: published work, an interrupted request
 * this recovery returned to the queue, or a completion/failure the normal
 * path had already delivered (settled without republishing or requeueing).
 * The durable settlement — never the diagnostic status reason a later
 * liveness warning can overwrite — classifies a returned request.
 */
function retiredOutcome(record: FollowupHandoffRecord): ResumeOutcome {
    if (record.commit_hash) return { outcome: 'published', commitHash: record.commit_hash };
    return record.settlement === SETTLEMENT_RETURNED_TO_QUEUE ? { outcome: 'no_changes' } : { outcome: 'settled' };
}

/**
 * A scheduled usage-limit retry owns the request, so edits the replaced
 * attempt left in its worktree are never published: the worktree HEAD is
 * detached in place (every file stays) to free the branch for the retry.
 */
async function detachRetryOwnedWorktree(params: ResumeFollowupHandoffParams, record: FollowupHandoffRecord): Promise<boolean> {
    if (!retryOwnsClaims(record)) return false;
    await params.git.detachWorktreeHead(record.worktree_path);
    params.log.info({ taskId: record.task_id, repository: record.repository, pullRequest: record.pull_request, worktreePath: record.worktree_path },
        'Detached the retained worktree of a retry-owned follow-up in place; its unpublished edits are kept, never published');
    return true;
}

/**
 * Retires the handoff only once the branch is proven free of the retained
 * worktree. A failed or interrupted release keeps the row at cleanup_pending,
 * so a later pass retries cleanup without republishing anything.
 */
async function attemptHandoffCleanup(params: ResumeFollowupHandoffParams, record: FollowupHandoffRecord): Promise<ResumeOutcome> {
    if (ownershipLost(params, record)) return { outcome: 'ownership_lost' };
    let released = false;
    try {
        const attachment = await params.git.worktreeAttachment(record.worktree_path, record.branch_name);
        // The lease can be lost while the attachment is inspected; the branch
        // release then belongs to the successor that now owns the handoff.
        if (ownershipLost(params, record)) return { outcome: 'ownership_lost' };
        if (attachment !== 'attached'
            || await params.git.releaseSettledWorktree(record.local_repo_path, record.branch_name, record.worktree_path)
            || await detachRetryOwnedWorktree(params, record)) {
            // Release proof is the repository's own worktree registrations, not
            // the directory: a worktree removed (or detached) by normal cleanup
            // is free, but a removed directory whose registration survives
            // still holds the branch, and the row must stay discoverable.
            released = (await params.git.branchWorktreeRegistrations(record.local_repo_path, record.branch_name)).length === 0;
        }
    } catch (error) {
        params.log.warn({ taskId: record.task_id, repository: record.repository, pullRequest: record.pull_request, error: (error as Error).message },
            'Branch release from the settled worktree failed; the handoff is retained to retry cleanup');
    }
    if (!released) {
        await reportHandoffOnTaskTimeline(params, record, 'publication complete; branch release pending retry');
        return { outcome: 'cleanup_pending' };
    }
    // A loss observed during the release leaves the row for the successor,
    // whose cleanup pass proves the free branch and retires it.
    if (ownershipLost(params, record)) return { outcome: 'ownership_lost' };
    await finalizeFollowupHandoff(params.store, record);
    const retired = retiredOutcome(record);
    params.log.info({ taskId: record.task_id, repository: record.repository, pullRequest: record.pull_request, commitHash: record.commit_hash, outcome: retired.outcome },
        retired.outcome === 'published'
            ? 'Recovered and published an interrupted follow-up exactly once'
            : retired.outcome === 'no_changes'
                ? 'Interrupted follow-up produced no changes; its branch is free again'
                : 'Follow-up outcome was already delivered; its branch is free again');
    return retired;
}

/**
 * The normal error path reported the failure (with this handoff's marker) and
 * died before settling the handoff. Its failure settlement would have retired
 * a worktree without publishable work, so recovery reconciles to the same
 * end: the delivered notice is recorded unchanged, the task stays failed and
 * the answered request is never requeued. Every step is repeatable.
 */
async function finishDeliveredFailure(params: ResumeFollowupHandoffParams, record: FollowupHandoffRecord, url: string | null): Promise<ResumeOutcome> {
    const finalized = await finalizeRecoveredTask(params, record, 'failure_delivered');
    if (finalized !== 'finalized') return { outcome: 'ownership_lost' };
    const advanced = await advanceFollowupHandoff(params.store, record, {
        phase: 'cleanup_pending', completion_comment_url: url, status_reason: 'failure_delivered',
    });
    if (!advanced) return { outcome: 'superseded' };
    params.log.info({ taskId: record.task_id, repository: record.repository, pullRequest: record.pull_request },
        'Recorded the follow-up failure the normal path delivered before a worker restart; nothing was requeued');
    return attemptHandoffCleanup(params, advanced);
}

/**
 * The normal usage-limit path scheduled its retry — which carries the claimed
 * comments — and died before settling the handoff, or left unpublished edits
 * in the worktree. The retry job owns those comments, so recovery reconciles
 * to the settlement's own outcome: nothing is committed, published, returned
 * to the queue or scheduled, the starting comment is left alone, and the task
 * ends as the requeued attempt the job result would have recorded.
 */
async function finishRetryOwnedClaims(params: ResumeFollowupHandoffParams, record: FollowupHandoffRecord): Promise<ResumeOutcome> {
    if (ownershipLost(params, record)) return { outcome: 'ownership_lost' };
    // Checkpoint first: a cancelled task found by a later pass would otherwise
    // be held as a user cancellation instead of retiring.
    const advanced = await advanceFollowupHandoff(params.store, record, { phase: 'cleanup_pending', status_reason: 'usage_limit_retry' });
    if (!advanced) return { outcome: 'superseded' };
    try {
        const current = await params.stateManager.getTaskState(record.task_id);
        if (current && !terminalStates(params.taskStates).has(current.state) && !ownershipLost(params, advanced)) {
            await params.stateManager.updateTaskState(record.task_id, params.taskStates.CANCELLED, {
                reason: 'PR comment job requeued: usage_limit',
                historyMetadata: { followupPublicationHandoff: { recovered: true, phase: record.phase, branchName: record.branch_name, nextAction: 'the scheduled usage-limit retry owns the request' } },
            });
        }
    } catch (error) {
        params.log.warn({ taskId: record.task_id, error: (error as Error).message }, 'Could not record the requeued attempt after a usage-limit retry was scheduled');
    }
    params.log.info({ taskId: record.task_id, repository: record.repository, pullRequest: record.pull_request },
        'The usage-limit retry scheduled before a worker restart owns the claimed comments; nothing was returned to the queue');
    return attemptHandoffCleanup(params, advanced);
}

/**
 * Something outside ProPR (a host cleanup, a manual rm -rf) deleted the worktree. Commits and the branch
 * live in the shared clone, so it is rebuilt at its recorded path. The loss is recorded durably before
 * the rebuild: the deleted folder took the run's uncommitted edits with it, so a recorded agent success
 * is invalidated (`agent_completed` null = lost) in the fenced write, and a worker that dies after the
 * rebuild leaves no record a later pass can mistake for an intact, answered run. A failed attempt whose
 * retry is pending is left to that retry. Returns the advanced record when restored, else the hold.
 */
async function restoreDeletedWorktree(params: ResumeFollowupHandoffParams, record: FollowupHandoffRecord): Promise<ResumeStep> {
    if (!params.git.restoreMissingWorktree) return { done: await holdForOperator(params, record, 'worktree_missing') };
    const hold = await cancellationHold(params, record) ?? await pendingRetryHold(record, params);
    if (hold) return { done: hold };
    const marked = await advanceFollowupHandoff(params.store, record, { agent_completed: null, agent_summary: null, status_reason: WORKTREE_LOST_REASON });
    if (!marked) return { done: { outcome: 'superseded' } };
    const context = { taskId: record.task_id, repository: record.repository, pullRequest: record.pull_request, worktreePath: record.worktree_path };
    const restored = await params.git.restoreMissingWorktree(record.local_repo_path, record.worktree_path, record.branch_name)
        .catch(error => { params.log.warn({ ...context, error: (error as Error).message }, 'Could not rebuild a deleted follow-up worktree'); return false; });
    // Restore failures are not retried automatically, unlike worktree_missing.
    if (!restored) return { done: await holdForOperator(params, marked, 'worktree_restore_failed') };
    params.log.warn(context, 'Rebuilt a follow-up worktree deleted outside ProPR from its branch; recovery continues');
    await reportHandoffOnTaskTimeline(params, marked, 'worktree was deleted; rebuilt it from the branch');
    return { record: marked };
}

async function finishWithoutChanges(params: ResumeFollowupHandoffParams, record: FollowupHandoffRecord): Promise<ResumeOutcome> {
    // Cancellation or lease loss may land while the Git evidence or the notice
    // request is awaited: publication re-checks both before its mutation, and
    // they are re-checked again before restoring the claimed comments, or a
    // cancelled request would be requeued (or a successor's raced).
    const notice = await publishOwedComment(params, record, interruptedWithoutChangesBody(record));
    if ('done' in notice) return notice.done;
    if (notice.delivery === 'normal_completion') {
        // The normal path already delivered its (no-change) completion and the
        // claimed comments were answered: record it, never requeue them.
        const delivered = await advanceFollowupHandoff(params.store, record, { phase: 'comment_published', completion_comment_url: notice.url });
        return delivered ? finishPublishedComment(params, delivered) : { outcome: 'superseded' };
    }
    if (notice.delivery === 'normal_failure') return finishDeliveredFailure(params, record, notice.url);
    const hold = await cancellationHold(params, record);
    if (hold) return hold;
    await params.restoreComments(record, parseClaimedComments(record));
    // A successor that adopts this phase restores (deduplicated) and schedules
    // again. A cancellation that landed while the restoration was awaited must
    // not schedule replacement work: the restored claims are withdrawn from
    // the pending list (so no follow-up job picks them up) before the handoff
    // is held for an explicit operator decision. A worker death before that
    // withdrawal is reconciled by the next pass's initial cancellation hold.
    const lateHold = await cancellationHold(params, record);
    if (lateHold) return lateHold;
    await params.scheduleRestoredComments?.(record);
    // The user can cancel while the follow-up job is being queued, too. The
    // finalizer's state read is the last one before cleanup: a cancellation it
    // finds withdraws the restored claims and holds the handoff, so the job
    // already queued finds neither the claims nor a free admission gate.
    const finalized = await finalizeRecoveredTask(params, record, 'no_changes');
    if (finalized === 'ownership_lost') return { outcome: 'ownership_lost' };
    if (finalized === 'cancelled') return holdCancelled(params, record);
    const advanced = await advanceFollowupHandoff(params.store, record, {
        phase: 'cleanup_pending', status_reason: SETTLEMENT_RETURNED_TO_QUEUE, settlement: SETTLEMENT_RETURNED_TO_QUEUE,
    });
    if (!advanced) return { outcome: 'superseded' };
    params.log.info({ taskId: record.task_id, repository: record.repository, pullRequest: record.pull_request },
        'Interrupted follow-up produced no changes; claimed comments were returned to the queue');
    return attemptHandoffCleanup(params, advanced);
}

/**
 * The agent exited reporting full success without changing any file (for
 * example, the requested correction was already present) and the worker died
 * before the normal no-change completion was delivered. The request is
 * answered, not interrupted: recovery delivers that completion — with the
 * analysis persisted at the exit checkpoint — and checkpoints it before the
 * task completes, instead of returning the comments for another agent run. A
 * completion or failure the normal path already delivered is reconciled
 * unchanged, and a repeated pass finds its own marked comment.
 */
async function finishCompletedWithoutChanges(params: ResumeFollowupHandoffParams, record: FollowupHandoffRecord): Promise<ResumeOutcome> {
    const delivered = await publishOwedComment(params, record, recoveredNoChangeCompletionBody(record));
    if ('done' in delivered) return delivered.done;
    if (delivered.delivery === 'normal_failure') return finishDeliveredFailure(params, record, delivered.url);
    const published = await advanceFollowupHandoff(params.store, record, { phase: 'comment_published', completion_comment_url: delivered.url });
    if (!published) return { outcome: 'superseded' };
    params.log.info({ taskId: record.task_id, repository: record.repository, pullRequest: record.pull_request, delivery: delivered.delivery },
        'Delivered the completion of a successful no-change follow-up interrupted before publication; nothing was requeued');
    return finishPublishedComment(params, published, delivered.delivery === 'recovery' ? 'completed_without_changes' : undefined);
}

/**
 * Collects the exited agent's output from the retained worktree: commits any
 * uncommitted work, or recognizes already-committed-but-unpushed work, or
 * settles the handoff without changes — as a delivered completion when the
 * agent recorded full success, or as an interrupted request otherwise.
 */
async function collectAgentOutput(
    params: ResumeFollowupHandoffParams,
    record: FollowupHandoffRecord,
): Promise<{ record: FollowupHandoffRecord } | { done: ResumeOutcome }> {
    const { git } = params;
    let attachment = await git.worktreeAttachment(record.worktree_path, record.branch_name);
    if (attachment === 'missing') {
        const restored = await restoreDeletedWorktree(params, record);
        if ('done' in restored) return restored;
        record = restored.record;
        attachment = await git.worktreeAttachment(record.worktree_path, record.branch_name);
    }
    if (attachment === 'missing') return { done: await holdForOperator(params, record, 'worktree_missing') };
    if (attachment === 'not_on_branch') return { done: await holdForOperator(params, record, 'worktree_not_on_branch') };
    let commitHash: string | null = null;
    if (await git.hasUncommittedChanges(record.worktree_path)) {
        // Cancellation or lease loss during the worktree inspection stops the
        // commit; the later push check alone would leave a cancelled commit.
        const hold = await cancellationHold(params, record);
        if (hold) return { done: hold };
        commitHash = (await git.commitWork(record.worktree_path, recoveryCommitMessage(record), record.pull_request))?.commitHash ?? null;
    }
    // A dirty worktree can still hold nothing publishable: committing unstages
    // generated runtime output and then creates no commit. Only a verified
    // commit hash may reach the committed phase; otherwise already committed
    // but unpushed work is recognized, or the run produced no changes.
    if (!commitHash && await git.hasUnpushedCommits(record.worktree_path, record.branch_name)) {
        commitHash = await git.head(record.worktree_path);
    }
    if (!commitHash) {
        // Only the exit checkpoint's recorded success distinguishes an answered
        // request from a lost or stopped-short run that produced nothing. A
        // deleted worktree took the run's uncommitted edits with it: the rebuild
        // durably invalidated any recorded success, so a pass interrupted after
        // it (the folder intact again) still returns the request to the queue.
        return { done: record.agent_completed === 1 && !worktreeWasLost(record)
            ? await finishCompletedWithoutChanges(params, record)
            : await finishWithoutChanges(params, record) };
    }
    const advanced = await advanceFollowupHandoff(params.store, record, { phase: 'committed', commit_hash: commitHash });
    return advanced ? { record: advanced } : { done: { outcome: 'superseded' } };
}

/** Pushes the committed work after revalidating cancellation, binding, worktree identity and lease ownership. */
async function pushCommittedWork(params: ResumeFollowupHandoffParams, record: FollowupHandoffRecord): Promise<ResumeStep> {
    const { git } = params;
    const hold = await cancellationHold(params, record) ?? await validatePublicationBinding(params, record);
    if (hold) return { done: hold };
    // A committed handoff publishes exactly the recorded worktree, branch and
    // commit. A detached/switched worktree or a replaced HEAD (for example
    // during manual recovery) is held for an operator, never pushed.
    let attachment = await git.worktreeAttachment(record.worktree_path, record.branch_name);
    if (attachment === 'missing') {
        // The recorded commit is on the clone's branch; the HEAD check below still guards the push.
        const restored = await restoreDeletedWorktree(params, record);
        if ('done' in restored) return restored;
        record = restored.record;
        attachment = await git.worktreeAttachment(record.worktree_path, record.branch_name);
    }
    if (attachment !== 'attached') {
        return { done: await holdForOperator(params, record, attachment === 'missing' ? 'worktree_missing' : 'worktree_not_on_branch') };
    }
    if (!record.commit_hash || await git.head(record.worktree_path) !== record.commit_hash) {
        return { done: await holdForOperator(params, record, 'recorded_commit_mismatch') };
    }
    // Binding validation and the worktree evidence above are lengthy awaits; a
    // cancellation or lease loss that landed during them must stop the push.
    const lateHold = await cancellationHold(params, record);
    if (lateHold) return { done: lateHold };
    const { owner, repo } = splitHandoffRepository(record.target_repository);
    let pushed: Awaited<ReturnType<typeof git.push>>;
    try {
        pushed = await git.push(record.worktree_path, { repoOwner: owner, repoName: repo, branchName: record.branch_name });
    } catch (error) {
        // An externally advanced head rejects the stale push; fail closed for
        // an operator instead of rebasing over the other actor's work.
        if (isNonFastForwardPushError(error)) {
            return { done: await holdForOperator(params, record, 'head_advanced_externally') };
        }
        throw error;
    }
    const commitHash = (pushed && typeof pushed === 'object' && pushed.commitHash) || record.commit_hash;
    const advanced = await advanceFollowupHandoff(params.store, record, { phase: 'pushed', commit_hash: commitHash });
    return advanced ? { record: advanced } : { done: { outcome: 'superseded' } };
}

/** Publishes the owed completion comment; cancellation and lease ownership are re-checked before each comment mutation. */
async function publishPushedCompletion(params: ResumeFollowupHandoffParams, record: FollowupHandoffRecord): Promise<ResumeStep> {
    const published = await publishOwedComment(params, record, recoveredCompletionBody(record), { supersedeFailure: true });
    if ('done' in published) return published;
    const advanced = await advanceFollowupHandoff(params.store, record, { phase: 'comment_published', completion_comment_url: published.url });
    return advanced ? { record: advanced } : { done: { outcome: 'superseded' } };
}

/** Finalizes the task for a recorded completion comment, then frees the branch while keeping the worktree. */
async function finishPublishedComment(
    params: ResumeFollowupHandoffParams,
    record: FollowupHandoffRecord,
    outcome: RecoveredTaskOutcome = deliveredOutcome(record),
): Promise<ResumeOutcome> {
    let current = record;
    if (current.phase === 'comment_published') {
        if (await finalizeRecoveredTask(params, current, outcome) !== 'finalized') return { outcome: 'ownership_lost' };
        const advanced = await advanceFollowupHandoff(params.store, current, { phase: 'cleanup_pending' });
        if (!advanced) return { outcome: 'superseded' };
        current = advanced;
    }
    return attemptHandoffCleanup(params, current);
}

/**
 * Called under the pull request's processing lease with a record whose agent
 * is proven exited/lost. Adopts the existing retained worktree in place; it
 * never checks out the already-attached branch anywhere else.
 */
export async function resumeFollowupHandoff(params: ResumeFollowupHandoffParams): Promise<ResumeOutcome> {
    let record = params.record;
    // A scheduled usage-limit retry is the request's one owner. Its requeue
    // leaves this attempt CANCELLED, which is no user cancellation, and even
    // an operator's authorization of such a hold grants no publication: the
    // retained edits stay in the worktree while the retry runs the request.
    if (retryOwnsClaims(record) && record.phase !== 'cleanup_pending') return finishRetryOwnedClaims(params, record);
    // The worker died around the retry's queue add: the retry may already own
    // the request, so neither retained edits nor the claimed comments may be
    // published, committed or returned — either would run it twice. Held
    // before any collection (and before a cancellation hold an operator could
    // authorize) until an operator resolves the owner: release if the retry
    // exists, or resume to make this attempt the owner again.
    if (record.settlement === SETTLEMENT_RETRY_SCHEDULING && record.phase !== 'cleanup_pending') return holdForOperator(params, record, 'usage_limit_retry_unconfirmed');
    if (record.phase !== 'cleanup_pending') {
        // User cancellation is authoritative: never publish without explicit operator authorization.
        const hold = await cancellationHold(params, record);
        if (hold) return hold;
        if (record.is_fork) return holdForOperator(params, record, 'fork_publication_unsupported');
    }

    if (record.phase === 'agent_running' || record.phase === 'agent_exited') {
        const collected = await collectAgentOutput(params, record);
        if ('done' in collected) return collected.done;
        record = collected.record;
    }
    if (record.phase === 'committed') {
        const step = await pushCommittedWork(params, record);
        if ('done' in step) return step.done;
        record = step.record;
    }
    if (record.phase === 'pushed') {
        const step = await publishPushedCompletion(params, record);
        if ('done' in step) return step.done;
        record = step.record;
    }
    if (record.phase === 'comment_published' || record.phase === 'cleanup_pending') return finishPublishedComment(params, record);
    return { outcome: 'superseded' };
}
