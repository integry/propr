import { Job } from 'bullmq';
import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import {
    commitChanges,
    db,
    getRepoUrl,
    getAuthenticatedOctokit,
    pushBranch,
    TaskStates,
} from '@propr/core';
import type {
    ClaudeCodeResponse,
    CommentJobData,
    UnprocessedComment,
    WorkerStateManager,
    WorktreeInfo,
} from '@propr/core';
import { buildCompletionComment } from './prCompletionComment.js';
import { AI_COMMIT_AUTHOR } from './commitAuthor.js';
import { buildCommitMessage } from './prCommentJobUtils.js';
import { markReviewCommentsProcessed } from './reviewCommentGatherer.js';
import type { AIReviewComment } from './reviewCommentGatherer.js';
import { resolveUltrafixHistoryMeta } from './ultrafixJobHelpers.js';
import type { GitHubToken } from './githubTypes.js';

interface PostExecutionState {
    octokit: Awaited<ReturnType<typeof getAuthenticatedOctokit>> | null;
    worktreeInfo: WorktreeInfo | undefined;
    claudeResult: ClaudeCodeResponse | null;
    authorsText: string;
    unprocessedComments: UnprocessedComment[];
    startingWorkComment: { data: { id: number; html_url: string } } | null;
}

interface ReadyPostExecutionState extends PostExecutionState {
    octokit: Awaited<ReturnType<typeof getAuthenticatedOctokit>>;
    worktreeInfo: WorktreeInfo;
    claudeResult: ClaudeCodeResponse;
    startingWorkComment: { data: { id: number; html_url: string } };
}

interface PostExecutionContext {
    pullRequestNumber: number;
    repoOwner: string;
    repoName: string;
    correlatedLogger: Logger;
}

interface PostExecutionParams {
    state: PostExecutionState;
    job: Job<CommentJobData>;
    taskId: string;
    stateManager: WorkerStateManager;
    context: PostExecutionContext;
    unprocessedReviewComments: AIReviewComment[];
    llm: string | null | undefined;
    redisClient: Redis;
}

interface UndoContextParams {
    commitResult: Awaited<ReturnType<typeof commitChanges>>;
    unprocessedComments: UnprocessedComment[];
    repoOwner: string;
    repoName: string;
    pullRequestNumber: number;
    branchName: string;
}

async function commitAndPush(
    state: ReadyPostExecutionState,
    issueRef: { repoOwner: string; repoName: string; pullRequestNumber: number },
    llm: string | null | undefined
) {
    const changesSummary = state.claudeResult.summary || state.claudeResult.finalResult?.result || '';
    const commitMessage = buildCommitMessage({ changesSummary, unprocessedComments: state.unprocessedComments, pullRequestNumber: issueRef.pullRequestNumber, claudeResult: state.claudeResult, llm, authorsText: state.authorsText });
    const commitResult = await commitChanges(state.worktreeInfo.worktreePath, commitMessage, AI_COMMIT_AUTHOR, { issueNumber: issueRef.pullRequestNumber, issueTitle: 'Follow-up changes' });

    if (commitResult) {
        const repoUrl = getRepoUrl({ repoOwner: issueRef.repoOwner, repoName: issueRef.repoName });
        const githubToken = await state.octokit.auth({ type: "installation" }) as GitHubToken;
        const pushResult = await pushBranch(state.worktreeInfo.worktreePath, state.worktreeInfo.branchName, {
            repoUrl,
            authToken: githubToken.token,
            rebaseOnNonFastForward: true,
        });
        if (pushResult.rebased && pushResult.commitHash) {
            commitResult.commitHash = pushResult.commitHash;
        }
    }

    return { commitResult, changesSummary, commitMessage };
}

async function persistCommitHash(taskId: string, commitHash: string | undefined, correlatedLogger: Logger): Promise<void> {
    if (!commitHash) return;
    try {
        await db('tasks')
            .where({ task_id: taskId })
            .update({ commit_hash: commitHash });
        correlatedLogger.info({ taskId, commitHash }, 'Saved commit hash to tasks table');
    } catch (dbError) {
        correlatedLogger.warn({ taskId, error: (dbError as Error).message }, 'Failed to save commit hash to database');
    }
}

function buildUndoContext(params: UndoContextParams) {
    const { commitResult, unprocessedComments, repoOwner, repoName, pullRequestNumber, branchName } = params;
    const instructionCommentId = unprocessedComments.length > 0 ? unprocessedComments[0].id : 0;
    if (!commitResult || !instructionCommentId) return undefined;
    return { repoOwner, repoName, prNumber: pullRequestNumber, branchName, instructionCommentId };
}

function requirePostExecutionState(state: PostExecutionState): asserts state is ReadyPostExecutionState {
    if (!state.claudeResult) throw new Error('Cannot finish PR comment processing before agent execution completes');
    if (!state.worktreeInfo) throw new Error('Cannot finish PR comment processing without a worktree');
    if (!state.octokit) throw new Error('Cannot finish PR comment processing without an authenticated GitHub client');
    if (!state.startingWorkComment) throw new Error('Cannot finish PR comment processing without a starting work comment');
}

export async function handlePostExecution(params: PostExecutionParams, taskUrl: string): Promise<{ commitHash?: string }> {
    const { state, job, taskId, stateManager, context, unprocessedReviewComments, llm, redisClient } = params;
    const { repoOwner, repoName, pullRequestNumber, correlatedLogger } = context;

    requirePostExecutionState(state);
    if (!state.claudeResult.success) throw new Error(`Agent execution failed: ${state.claudeResult.error || 'Unknown error'}`);

    const { commitResult, changesSummary, commitMessage } = await commitAndPush(state, { repoOwner, repoName, pullRequestNumber }, llm);

    const undoContext = buildUndoContext({ commitResult, unprocessedComments: state.unprocessedComments, repoOwner, repoName, pullRequestNumber, branchName: state.worktreeInfo.branchName });
    const consumedReviewCommentIds = unprocessedReviewComments.length > 0 ? unprocessedReviewComments.map(c => c.id) : undefined;
    const prCommentBody = await buildCompletionComment(commitResult, state.unprocessedComments, { changesSummary, commitMessage, llm, authorsText: state.authorsText, undoContext, taskUrl, consumedReviewCommentIds }, state.claudeResult);
    const completionComment = await state.octokit.request('PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}', { owner: repoOwner, repo: repoName, comment_id: state.startingWorkComment.data.id, body: prCommentBody }) as { data: { html_url: string; body?: string } };
    correlatedLogger.info({ pullRequestNumber, commitHash: commitResult?.commitHash, commentUrl: completionComment.data.html_url }, 'Successfully applied follow-up changes');

    if (unprocessedReviewComments.length > 0) {
        await markReviewCommentsProcessed(unprocessedReviewComments.map(c => c.id), { repoOwner, repoName, pullRequestNumber, redisClient, correlatedLogger });
    }

    const ultrafixHistoryMeta = await resolveUltrafixHistoryMeta(job, { repoOwner, repoName, pullRequestNumber }, redisClient);

    await stateManager.updateTaskState(taskId, TaskStates.COMPLETED, {
        reason: 'PR comment processing completed successfully', commitHash: commitResult?.commitHash,
        historyMetadata: {
            commandMode: job.data.commandMode || 'default',
            githubComment: { url: completionComment.data.html_url, body: completionComment.data.body },
            ...(unprocessedReviewComments.length > 0 && { consumedReviewCommentIds: unprocessedReviewComments.map(c => c.id) }),
            ...ultrafixHistoryMeta,
        }
    });

    await persistCommitHash(taskId, commitResult?.commitHash, correlatedLogger);
    return { commitHash: commitResult?.commitHash };
}
