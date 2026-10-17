import fs from 'fs-extra';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import {
    commitChanges, createHooklessGit, inspectTaskContainerLivenessForTask, TaskStates,
    type JobResult, type UnprocessedComment, type WorkerStateManager,
} from '@propr/core';
import { AI_COMMIT_AUTHOR } from './commitAuthor.js';
import { isContainerCollisionCancellation, schedulePRCommentRecovery } from './prCommentCollisionRecovery.js';
import { PullRequestPublication } from './prPublication.js';
import { findPRContinuation, type Contribution } from './prContinuation.js';
import { recordPushSalvageEvent } from './pushSalvageTimeline.js';
import type { ExecuteProcessingParams } from './prPublicationRecovery.js';
import {
    advanceFollowupHandoffPhase, claimFollowupHandoffSuccessor, completeFollowupHandoff,
    decideFollowupHandoffRecovery, findOpenFollowupHandoff, parseClaimedHandoffComments,
    recordFollowupHandoffNextAction, type FollowupHandoffRecord,
} from './followupHandoffStore.js';

const TERMINAL_STATES: ReadonlySet<string> = new Set([TaskStates.COMPLETED, TaskStates.FAILED, TaskStates.CANCELLED]);

export interface FollowupHandoffRecoveryOptions {
    redisClient: Redis;
    pickedUpComments: UnprocessedComment[];
}

/** An explicit `/recover` comment is the operator action that authorizes adopting
 * retained work whose originating task a user cancelled. */
export function isExplicitFollowupRecoveryRequest(comments: Array<Pick<UnprocessedComment, 'body'>>): boolean {
    return comments.some(comment => /^\s*\/recover\b/im.test(comment.body ?? ''));
}

const isPureRecoverCommand = (comment: Pick<UnprocessedComment, 'body'>) => /^\s*\/recover\s*$/i.test(comment.body ?? '');

const handoffMarker = (kind: 'recovered' | 'operator', predecessorTaskId: string) =>
    `<!-- propr-followup-handoff:${kind}:${predecessorTaskId} -->`;

/** Recovery state surfaced on task status/timeline entries. */
export function followupHandoffTimelineMetadata(
    handoff: FollowupHandoffRecord,
    extra: { successorTaskId: string; nextAction?: string | null },
): Record<string, unknown> {
    return {
        followupRecovery: {
            recoveryPhase: handoff.phase,
            predecessorTaskId: handoff.task_id,
            successorTaskId: extra.successorTaskId,
            retainedWorktreePath: handoff.worktree_path,
            nextAction: extra.nextAction ?? handoff.next_action ?? null,
        },
    };
}

/** Posts at most one copy of a marker-tagged notice on the pull request. */
async function publishHandoffNoticeOnce(
    params: ExecuteProcessingParams, marker: string, body: string,
): Promise<void> {
    const { state, context } = params;
    const octokit = state.octokit!;
    const { repoOwner: owner, repoName: repo, pullRequestNumber: issue_number } = context;
    const existing = await octokit.paginate('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', {
        owner, repo, issue_number, per_page: 100,
    }) as Array<{ body?: string }>;
    if (existing.some(comment => comment.body?.includes(marker))) return;
    await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
        owner, repo, issue_number, body: `${body}\n\n${marker}`,
    });
}

/** Closes the predecessor's attempt, or annotates an already-terminal one. */
async function finalizePredecessor(
    stateManager: WorkerStateManager, handoff: FollowupHandoffRecord,
    outcome: { successorTaskId: string; reason: string; commitHash?: string; nextAction?: string | null },
): Promise<void> {
    const current = await stateManager.getTaskState(handoff.task_id);
    if (!current) return;
    const historyMetadata = followupHandoffTimelineMetadata(handoff, outcome);
    if (TERMINAL_STATES.has(current.state)) {
        await stateManager.updateHistoryMetadata(handoff.task_id, current.state, historyMetadata);
        return;
    }
    await stateManager.updateTaskState(handoff.task_id, TaskStates.COMPLETED, {
        reason: outcome.reason,
        ...(outcome.commitHash ? { commitHash: outcome.commitHash } : {}),
        historyMetadata,
    });
}

interface RetainedWorktreeInspection {
    holdsBranch: boolean;
    uncommitted?: boolean;
    headSha?: string;
}

async function inspectRetainedWorktree(handoff: FollowupHandoffRecord): Promise<RetainedWorktreeInspection> {
    const git = createHooklessGit(handoff.worktree_path);
    const run = (args: string[]) => git.raw(['-c', `safe.directory=${handoff.worktree_path}`, ...args]);
    if ((await run(['branch', '--show-current'])).trim() !== handoff.branch_name) return { holdsBranch: false };
    const uncommitted = (await run(['status', '--porcelain', '--untracked-files=all'])).trim().length > 0;
    const headSha = (await run(['rev-parse', 'HEAD'])).trim();
    return { holdsBranch: true, uncommitted, headSha };
}

/** Triggers stay owed: re-queue the predecessor's claimed comments on this run. */
function mergeOwedComments(context: ExecuteProcessingParams['context'], handoff: FollowupHandoffRecord): void {
    for (const comment of parseClaimedHandoffComments(handoff)) {
        if (!context.commentsToProcess.some(existing => existing.id === comment.id)) {
            context.commentsToProcess.push(comment);
        }
    }
}

function recoveryCommitMessage(handoff: FollowupHandoffRecord): string {
    return [
        `Recover interrupted follow-up changes for PR #${handoff.pull_request_number}`,
        '',
        `Edits were produced by task ${handoff.task_id} before a worker restart interrupted publication. They are committed unchanged by the recovery pass.`,
    ].join('\n');
}

/** The published head of the handoff branch, or undefined when it has none yet. */
async function remoteBranchHead(
    octokit: NonNullable<ExecuteProcessingParams['state']['octokit']>,
    target: { repoOwner: string; repoName: string; branchName: string },
): Promise<string | undefined> {
    try {
        const response = await octokit.request('GET /repos/{owner}/{repo}/git/ref/{ref}', {
            owner: target.repoOwner, repo: target.repoName, ref: `heads/${target.branchName}`,
        });
        return (response.data as { object?: { sha?: string } }).object?.sha;
    } catch (error) {
        if ((error as { status?: number }).status === 404) return undefined;
        throw error;
    }
}

async function waitForPredecessor(
    params: ExecuteProcessingParams, options: FollowupHandoffRecoveryOptions,
    handoff: FollowupHandoffRecord, reason: string,
): Promise<JobResult> {
    const { job, taskId, stateManager, context } = params;
    const replacementTaskId = await schedulePRCommentRecovery({
        job, taskId, stateManager, redisClient: options.redisClient,
        pickedUpComments: options.pickedUpComments, delay: 60000,
        reason, correlatedLogger: context.correlatedLogger,
        containerCollisionTaskId: handoff.task_id,
    });
    return { status: 'rescheduled', reason, replacementTaskId, pullRequestNumber: context.pullRequestNumber };
}

async function blockOnOperatorAction(
    params: ExecuteProcessingParams, handoff: FollowupHandoffRecord, nextAction: string,
): Promise<JobResult> {
    const { taskId, stateManager, context } = params;
    await recordFollowupHandoffNextAction(handoff.task_id, nextAction);
    await publishHandoffNoticeOnce(params, handoffMarker('operator', handoff.task_id), [
        '⏸️ **Retained follow-up work needs an explicit decision**',
        '',
        `The previous follow-up on this pull request (task \`${handoff.task_id}\`) was cancelled by a user after its agent produced work that was never published. The retained work is preserved and new follow-ups will not overwrite or publish it automatically.`,
        '',
        nextAction,
    ].join('\n'));
    await stateManager.updateTaskState(taskId, TaskStates.FAILED, {
        reason: 'A cancelled predecessor retained unpublished work; post /recover to adopt it',
        historyMetadata: followupHandoffTimelineMetadata(handoff, { successorTaskId: taskId, nextAction }),
    });
    context.correlatedLogger.warn({ predecessorTaskId: handoff.task_id, worktreePath: handoff.worktree_path },
        'Retained follow-up work from a user-cancelled task requires an explicit /recover');
    return { status: 'blocked', reason: 'retained_followup_requires_operator_recovery', pullRequestNumber: context.pullRequestNumber };
}

/** Publishes any unique retained work, then settles ownership and the comment debt. */
async function adoptRetainedFollowupWork(
    params: ExecuteProcessingParams, options: FollowupHandoffRecoveryOptions, handoff: FollowupHandoffRecord,
): Promise<JobResult | undefined> {
    const { taskId, stateManager, context } = params;
    const log: Logger = context.correlatedLogger;
    if (!await claimFollowupHandoffSuccessor(handoff.task_id, taskId)) {
        return waitForPredecessor(params, options, handoff, 'followup_handoff_claimed_by_other_successor');
    }
    if (!await fs.pathExists(handoff.worktree_path)) {
        await finalizePredecessor(stateManager, handoff, {
            successorTaskId: taskId, reason: 'Interrupted follow-up left no retained worktree; its trigger was re-queued',
        });
        await completeFollowupHandoff(handoff.task_id, 'worktree_missing_trigger_requeued');
        mergeOwedComments(context, handoff);
        return undefined;
    }
    let inspection: RetainedWorktreeInspection;
    try {
        inspection = await inspectRetainedWorktree(handoff);
    } catch (error) {
        log.warn({ predecessorTaskId: handoff.task_id, error: (error as Error).message }, 'Could not inspect the retained follow-up worktree');
        await recordFollowupHandoffNextAction(handoff.task_id, 'inspect_retained_worktree_manually');
        return undefined;
    }
    if (!inspection.holdsBranch) {
        // Already detached by failure cleanup or a prior pass; nothing blocks the branch.
        await completeFollowupHandoff(handoff.task_id, 'worktree_released_before_recovery');
        mergeOwedComments(context, handoff);
        return undefined;
    }
    await advanceFollowupHandoffPhase(handoff.task_id, 'changes-inspected');
    return publishRetainedWork(params, handoff, inspection, log);
}

async function publishRetainedWork(
    params: ExecuteProcessingParams, handoff: FollowupHandoffRecord,
    inspection: RetainedWorktreeInspection, log: Logger,
): Promise<JobResult | undefined> {
    const { taskId, stateManager, state, context } = params;
    const octokit = state.octokit!;
    const ref = { repoOwner: context.repoOwner, repoName: context.repoName, pullRequestNumber: context.pullRequestNumber };
    let commitHash: string | undefined;
    if (inspection.uncommitted) {
        const commit = await commitChanges(handoff.worktree_path, recoveryCommitMessage(handoff), AI_COMMIT_AUTHOR,
            { issueNumber: handoff.pull_request_number, issueTitle: 'Recovered follow-up changes' });
        commitHash = commit?.commitHash;
        await advanceFollowupHandoffPhase(handoff.task_id, 'committed', { commitHash });
    }
    const prData = (await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
        owner: ref.repoOwner, repo: ref.repoName, pull_number: ref.pullRequestNumber,
    })).data as Contribution & { state?: string };
    const publication = new PullRequestPublication(octokit, ref, prData);
    const continuation = await findPRContinuation(ref);
    if (continuation?.branch_name === handoff.branch_name) publication.continuation = continuation;
    else if (!continuation && prData.head.ref !== handoff.branch_name) {
        // The retained branch no longer belongs to this PR; never publish it blindly.
        await recordFollowupHandoffNextAction(handoff.task_id, 'retained_branch_no_longer_matches_pr');
        return undefined;
    }
    if (prData.state === 'closed') {
        await recordFollowupHandoffNextAction(handoff.task_id, 'pr_closed_review_retained_work_manually');
        return undefined;
    }
    const publishedHead = await remoteBranchHead(octokit, publication.target);
    // The recovery commit above, when one was made, is the worktree's new HEAD.
    const headSha = commitHash ?? inspection.headSha;
    if (!inspection.uncommitted && publishedHead === headSha && !handoff.commit_hash) {
        // The agent left nothing unique behind; the trigger is still owed a run.
        await finalizePredecessor(stateManager, handoff, {
            successorTaskId: taskId, reason: 'Interrupted follow-up produced no changes; its trigger was re-queued',
        });
        await completeFollowupHandoff(handoff.task_id, 'no_unique_changes_trigger_requeued');
        mergeOwedComments(context, handoff);
        return undefined;
    }
    if (publishedHead !== headSha) {
        const pushResult = await publication.push(handoff.worktree_path, undefined, {
            salvage: { taskId: handoff.task_id, onEvent: recordPushSalvageEvent(stateManager, handoff.task_id, log) },
        });
        commitHash = pushResult.commitHash ?? commitHash ?? headSha;
    } else {
        commitHash = commitHash ?? headSha;
    }
    await advanceFollowupHandoffPhase(handoff.task_id, 'pushed', { commitHash });
    return finishAdoptedRecovery(params, handoff, commitHash);
}

async function finishAdoptedRecovery(
    params: ExecuteProcessingParams, handoff: FollowupHandoffRecord, commitHash: string | undefined,
): Promise<JobResult | undefined> {
    const { taskId, stateManager, context } = params;
    await publishHandoffNoticeOnce(params, handoffMarker('recovered', handoff.task_id), [
        '🔁 **Recovered interrupted follow-up**',
        '',
        `A worker restart interrupted the previous follow-up (task \`${handoff.task_id}\`) after its agent produced changes but before they were published. The retained work was adopted and published${commitHash ? ` as \`${commitHash}\`` : ''}.`,
    ].join('\n'));
    await advanceFollowupHandoffPhase(handoff.task_id, 'comment-published');
    await finalizePredecessor(stateManager, handoff, {
        successorTaskId: taskId, commitHash,
        reason: 'Recovered and published the interrupted follow-up after a worker restart',
    });
    await completeFollowupHandoff(handoff.task_id);
    context.correlatedLogger.info({ predecessorTaskId: handoff.task_id, successorTaskId: taskId, commitHash },
        'Recovered and published an interrupted follow-up from its retained worktree');
    const recoveredIds = new Set(parseClaimedHandoffComments(handoff).map(comment => comment.id));
    context.commentsToProcess = context.commentsToProcess
        .filter(comment => !recoveredIds.has(comment.id) && !isPureRecoverCommand(comment));
    if (context.commentsToProcess.length > 0) {
        // This request keeps running on the recovered HEAD with its own instructions.
        const current = await stateManager.getTaskState(taskId);
        if (current) await stateManager.updateHistoryMetadata(taskId, current.state, followupHandoffTimelineMetadata(handoff, { successorTaskId: taskId }));
        return undefined;
    }
    if (taskId !== handoff.task_id) {
        await stateManager.updateTaskState(taskId, TaskStates.COMPLETED, {
            reason: 'Recovered and published the interrupted follow-up', commitHash,
            historyMetadata: {
                ...followupHandoffTimelineMetadata(handoff, { successorTaskId: taskId }),
                notificationRecap: 'Recovered and published the interrupted follow-up result.',
            },
        });
    }
    return { status: 'complete', commit: commitHash, pullRequestNumber: context.pullRequestNumber };
}

/**
 * Runs under the PR lease before validation or agent execution. Resolves an
 * open predecessor handoff: waits on a live container, blocks on a user
 * cancellation until `/recover`, finishes cleanup of published work, or adopts
 * the retained worktree and completes commit/push/result publication.
 */
export async function recoverInterruptedFollowupHandoff(
    params: ExecuteProcessingParams, options: FollowupHandoffRecoveryOptions,
): Promise<JobResult | undefined> {
    const { stateManager, context } = params;
    const handoff = await findOpenFollowupHandoff(context);
    if (!handoff) return undefined;
    const predecessorState = await stateManager.getTaskState(handoff.task_id);
    const inspection = await inspectTaskContainerLivenessForTask(handoff.task_id);
    const decision = decideFollowupHandoffRecovery({
        handoff,
        containerLiveness: inspection.liveness,
        predecessorTaskState: predecessorState?.state ?? null,
        predecessorCancelledByUser: predecessorState?.state === TaskStates.CANCELLED
            && !isContainerCollisionCancellation(predecessorState),
        explicitRecoveryRequested: isExplicitFollowupRecoveryRequest(context.commentsToProcess),
    });
    context.correlatedLogger.info({
        predecessorTaskId: handoff.task_id, phase: handoff.phase, decision: decision.action,
        containerLiveness: inspection.liveness, retainedWorktreePath: handoff.worktree_path,
    }, 'Evaluated interrupted follow-up handoff');
    switch (decision.action) {
        case 'ignore': return undefined;
        case 'finalize':
            await completeFollowupHandoff(handoff.task_id, 'finalized_published_predecessor');
            return undefined;
        case 'wait': return waitForPredecessor(params, options, handoff, `followup_handoff_${decision.reason}`);
        case 'operator': return blockOnOperatorAction(params, handoff, decision.nextAction);
        case 'adopt': return adoptRetainedFollowupWork(params, options, handoff);
    }
}
