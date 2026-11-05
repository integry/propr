import type { FollowupHandoffRecoveryDeps, ResolvedRecoveryDeps } from './followupHandoffDeps.js';
import {
    advanceFollowupHandoff, loadFollowupHandoffs, parseClaimedComments, recordCancelledClaims, retryOwnsClaims,
    HANDOFF_ACTIVE, HANDOFF_AWAITING_OPERATOR, HANDOFF_RELEASED,
    type FollowupHandoffRecord,
} from './followupHandoffStore.js';
import { releaseFollowupHandoffRecord, resumeOperatorHeldFollowupHandoff } from './followupHandoffOperator.js';
import { reportHandoffOnTaskTimeline, splitHandoffRepository, type LoggerLike } from './followupHandoffResume.js';
import { taskAttemptEnded } from './followupHandoffTaskState.js';

/**
 * Settles operator holds that no longer protect anything, so a stuck
 * follow-up never leaves members debugging the queue. A hold is releasable
 * when its attempt is over and its worktree can publish nothing more: the
 * failure (or the cancellation) was already reported, and the next run
 * redoes the request from the current branch. Release never deletes files:
 * it only frees the branch, and a cancelled request's comments are withdrawn.
 * Holds that need a real decision (an unconfirmed usage-limit retry, fork or
 * binding mismatches) stay for an operator.
 */

/** Hold reasons that say only that the attempt's own worktree can no longer publish. */
const WORKTREE_GAVE_UP_HOLDS = new Set(['worktree_not_on_branch', 'worktree_missing', 'worktree_restore_failed', 'head_advanced_externally', 'recorded_commit_mismatch']);
const RELEASABLE_HOLDS = new Set([...WORKTREE_GAVE_UP_HOLDS, 'cancelled_by_user']);

/** Holds older than this are released by the background pass even when no new comment is waiting. */
function staleHoldMs(): number {
    const hours = Number(process.env.FOLLOWUP_HOLD_AUTO_RELEASE_HOURS ?? 24);
    return (Number.isFinite(hours) && hours > 0 ? hours : 24) * 3_600_000;
}

const HOLD_EXPLANATIONS: Record<string, string> = {
    cancelled_by_user: 'had been cancelled',
    worktree_not_on_branch: 'had already failed and given up its working copy',
    worktree_missing: 'had lost its working copy',
    worktree_restore_failed: 'had lost its working copy',
    head_advanced_externally: 'was overtaken by newer commits on the branch',
    recorded_commit_mismatch: 'was overtaken by newer commits on the branch',
};

/** Whether the held attempt is over; a missing task state counts as ended (see taskAttemptEnded). */
const heldTaskEnded = (record: FollowupHandoffRecord, resolved: ResolvedRecoveryDeps) => taskAttemptEnded(resolved, record.task_id);

/**
 * Whether the job of `currentTaskId` may release this predecessor instead of
 * waiting. A job of the same task is the request's automatic retry: it takes
 * over its own failed attempt once that attempt gave up the branch (a crash
 * redelivery whose worktree is still on the branch keeps normal recovery).
 * Any later job releases a hold whose attempt is over and cannot publish.
 */
export async function predecessorReleasable(record: FollowupHandoffRecord, resolved: ResolvedRecoveryDeps, currentTaskId: string): Promise<boolean> {
    if (record.operator_authorized || retryOwnsClaims(record)) return false;
    const reason = record.status_reason ?? '';
    if (record.status === HANDOFF_ACTIVE) {
        return record.task_id === currentTaskId && reason === 'publication_failed'
            && await resolved.git.worktreeAttachment(record.worktree_path, record.branch_name) !== 'attached';
    }
    if (record.status !== HANDOFF_AWAITING_OPERATOR) return false;
    if (record.task_id === currentTaskId) return WORKTREE_GAVE_UP_HOLDS.has(reason);
    return RELEASABLE_HOLDS.has(reason) && await heldTaskEnded(record, resolved);
}

/** Tells the pull request, briefly, that a stuck follow-up was cleared; failures never block the release. */
async function announceRelease(record: FollowupHandoffRecord, resolved: ResolvedRecoveryDeps): Promise<void> {
    await reportHandoffOnTaskTimeline({ stateManager: resolved.stateManager, log: resolved.log }, record,
        'released automatically: the attempt was over and could not publish');
    try {
        const { owner, repo } = splitHandoffRepository(record.repository);
        const octokit = await resolved.getOctokit();
        const { data: pull } = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
            owner, repo, pull_number: record.pull_request,
        });
        const state = pull as { state?: string; merged?: boolean };
        if (state.state !== 'open' || state.merged) return;
        const why = HOLD_EXPLANATIONS[record.status_reason ?? ''] ?? 'could not publish anything more';
        await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
            owner, repo, issue_number: record.pull_request,
            body: `ℹ️ **Cleared a stuck follow-up** so new requests on this pull request can run.\n\nAn earlier follow-up (task \`${record.task_id}\`) ${why}, so nothing more could be published from it. If its request still matters, comment again.`,
        });
    } catch (error) {
        resolved.log.warn({ taskId: record.task_id, repository: record.repository, pullRequest: record.pull_request, error: (error as Error).message },
            'Could not post the automatic follow-up release notice');
    }
}

/**
 * Releases a predecessor in-line under the caller's PR lease (already held,
 * liveness already checked). Returns the comment IDs of a cancelled request,
 * which the caller drops from its own batch, or null when the branch is
 * still held and the caller must keep waiting.
 */
export async function releasePredecessorInline(record: FollowupHandoffRecord, resolved: ResolvedRecoveryDeps, currentTaskId: string, log: LoggerLike): Promise<number[] | null> {
    const { git } = resolved;
    // The hold reason counts as well as the task state: a cancelled hold whose
    // task state was lost must still withdraw its claims (see taskAttemptEnded).
    const cancelled = record.task_id !== currentTaskId
        && (record.status_reason === 'cancelled_by_user'
            || (await resolved.stateManager.getTaskState(record.task_id))?.state === resolved.taskStates.CANCELLED);
    const claimIds = cancelled ? parseClaimedComments(record).map(comment => comment.id) : [];
    if (cancelled) {
        // Durable suppression first, so a job that already captured them drops them too.
        await recordCancelledClaims(resolved.store, record, claimIds);
        await resolved.withdrawRestoredComments(record, parseClaimedComments(record));
    }
    // A refused release means the worktree still holds unpublished work: it
    // is detached in place, so the commits stay recoverable from that checkout
    // (see maintenance.md) while the branch is freed. A deleted folder has
    // nothing to detach; core's release then detaches its surviving Git
    // registration instead, so the branch check below sees it free.
    if (!await git.releaseSettledWorktree(record.local_repo_path, record.branch_name, record.worktree_path)
        && await git.worktreeAttachment(record.worktree_path, record.branch_name) === 'attached') {
        await git.detachWorktreeHead(record.worktree_path);
    }
    if ((await git.branchWorktreeRegistrations(record.local_repo_path, record.branch_name)).length > 0) return null;
    // Freeing the branch is not enough: the attempt's unpublished commits may
    // still be its tip (a refused release detached the worktree at them, a
    // deleted worktree's registration was detached at them, a salvaged push
    // left them), and a reused branch keeps commits it is ahead by. The next
    // worktree would inherit them and the cancelled or failed work would land
    // on the pull request. The branch restarts from the remote head, with the
    // commits kept under refs/propr/superseded/; if that cannot be ensured the
    // hold stands.
    if (!await git.restartBranchFromRemoteHead(record.local_repo_path, record.branch_name)) {
        log.warn({ repository: record.repository, pullRequest: record.pull_request, taskId: record.task_id, currentTaskId },
            'The branch could not be restarted from the pull request head; the follow-up hold stands');
        return null;
    }
    const ownRetry = record.task_id === currentTaskId;
    const released = await advanceFollowupHandoff(resolved.store, record, {
        status: HANDOFF_RELEASED, status_reason: ownRetry ? 'superseded_by_retry' : 'auto_released_for_new_request',
    });
    if (!released) return null;
    log.info({ repository: record.repository, pullRequest: record.pull_request, taskId: record.task_id, currentTaskId, previousReason: record.status_reason },
        ownRetry ? 'The retry of a failed follow-up took over from its own failed attempt; that worktree is kept but not published'
            : 'Released a stuck follow-up hold for a new request; its worktree is kept but not published');
    // The retry runs the same request, so only a release for a new request is announced.
    if (!ownRetry) await announceRelease(record, resolved);
    return claimIds;
}

/**
 * Background pass. A hold parked only because its worktree was deleted is
 * re-armed (recovery rebuilds the worktree); any other releasable hold whose
 * attempt is over is released once it is older than the stale cutoff, so a
 * pull request nobody comments on does not keep a stuck entry either.
 */
export async function settleStuckHolds(deps: FollowupHandoffRecoveryDeps, resolved: ResolvedRecoveryDeps): Promise<void> {
    const held = (await loadFollowupHandoffs(resolved.store, { status: HANDOFF_AWAITING_OPERATOR }))
        .filter(record => RELEASABLE_HOLDS.has(record.status_reason ?? '') && !record.operator_authorized && !retryOwnsClaims(record));
    const shared = { ...deps, store: resolved.store, redis: resolved.redis, git: resolved.git, log: resolved.log, stateManager: resolved.stateManager };
    const now = Date.now();
    for (const record of held) {
        try {
            const cancelled = (await resolved.stateManager.getTaskState(record.task_id))?.state === resolved.taskStates.CANCELLED;
            if (record.status_reason === 'worktree_missing' && !cancelled) {
                // Legacy holds lack publication_failed, so their task state is
                // the only evidence that a queued retry still owns the attempt.
                if (!await heldTaskEnded(record, resolved)) continue;
                // The operator resume re-arms without granting publication
                // authority: operator_authorized stays 0, so a re-armed hold
                // that fails its rebuild is still releasable here and above.
                const result = await resumeOperatorHeldFollowupHandoff(record, shared, { automatic: true });
                resolved.log.info({ repository: record.repository, pullRequest: record.pull_request, taskId: record.task_id, result },
                    'Re-armed a follow-up held only because its worktree was deleted; recovery rebuilds the worktree');
                continue;
            }
            if (now - Number(record.updated_at) < staleHoldMs() || !await heldTaskEnded(record, resolved)) continue;
            const result = await releaseFollowupHandoffRecord(record, { force: true, restartBranch: true, reason: 'auto_released_stale_hold' }, shared);
            resolved.log.info({ repository: record.repository, pullRequest: record.pull_request, taskId: record.task_id, previousReason: record.status_reason, result },
                'Released a stale follow-up hold whose attempt was over and could not publish');
            if (result.released) await announceRelease(record, resolved);
        } catch (error) {
            resolved.log.warn({ repository: record.repository, pullRequest: record.pull_request, taskId: record.task_id, error: (error as Error).message },
                'Could not settle a stuck follow-up hold; retrying on the next pass');
        }
    }
}
