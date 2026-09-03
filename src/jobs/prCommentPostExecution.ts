import { Job } from 'bullmq';
import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import {
    commitChanges,
    collectVisualPreviewEvidence,
    db,
    getRepoUrl,
    getAuthenticatedOctokit,
    loadRepositoryVisualPreviewSettings,
    pushBranch,
    appendVisualPreviewSection,
    renderVisualPreviewSection,
    resolveAgentTerminationReason,
    TaskStates,
    VISUAL_PREVIEW_SLOT,
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
import { markReviewFindingsProcessed } from './reviewCommentGatherer.js';
import type { AIReviewComment } from './reviewCommentGatherer.js';
import { resolveUltrafixHistoryMeta } from './ultrafixJobHelpers.js';
import type { GitHubToken } from './githubTypes.js';
import { publishPullRequestCommentVisualPreviews } from '../github/visualPreviewAttachments.js';

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
    prProcessingLockKey: string;
    prProcessingLockToken: string;
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

export function getPostExecutionDisposition(result: ClaudeCodeResponse): 'complete' | 'partial' | 'failed' {
    if (result.success) return 'complete';
    return resolveAgentTerminationReason(result) ? 'partial' : 'failed';
}

interface CompletionCommentPublicationOptions {
    state: ReadyPostExecutionState;
    context: PostExecutionContext;
    commitResult: Awaited<ReturnType<typeof commitChanges>>;
    changesSummary: string;
    commitMessage: string;
    llm: string | null | undefined;
    taskUrl: string;
    unprocessedReviewComments: AIReviewComment[];
}

async function publishCompletionComment(options: CompletionCommentPublicationOptions): Promise<{ data: { html_url: string; body?: string } }> {
    const { state, context, commitResult, changesSummary, commitMessage, llm, taskUrl, unprocessedReviewComments } = options;
    const { repoOwner, repoName, pullRequestNumber, correlatedLogger } = context;
    const visualPreviewSettings = await loadRepositoryVisualPreviewSettings(`${repoOwner}/${repoName}`);
    const visualPreviewEvidence = await collectVisualPreviewEvidence({
        worktreePath: state.worktreeInfo.worktreePath,
        changedFiles: commitResult?.filesChanged || [],
        settings: visualPreviewSettings
    });
    const hasVisualPreviewContent = visualPreviewEvidence.assets.length > 0 || visualPreviewEvidence.toolSuggestions.length > 0;
    const visualPreviewSection = commitResult && hasVisualPreviewContent
        ? renderVisualPreviewSection(visualPreviewEvidence, { owner: repoOwner, repo: repoName, commitHash: commitResult.commitHash })
        : '';
    const undoContext = buildUndoContext({ commitResult, unprocessedComments: state.unprocessedComments, repoOwner, repoName, pullRequestNumber, branchName: state.worktreeInfo.branchName });
    const consumedReviewCommentIds = unprocessedReviewComments.length > 0 ? unprocessedReviewComments.map(comment => comment.id) : undefined;
    const prCommentTemplate = await buildCompletionComment(commitResult, state.unprocessedComments, {
        changesSummary,
        commitMessage,
        llm,
        authorsText: state.authorsText,
        undoContext,
        taskUrl,
        consumedReviewCommentIds,
        visualPreviewSection: hasVisualPreviewContent ? VISUAL_PREVIEW_SLOT : undefined
    }, state.claudeResult);
    const prCommentBody = appendVisualPreviewSection(prCommentTemplate, visualPreviewSection);

    if (!commitResult || visualPreviewEvidence.assets.length === 0) {
        return state.octokit.request('PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}', {
            owner: repoOwner,
            repo: repoName,
            comment_id: state.startingWorkComment.data.id,
            body: prCommentBody
        }) as Promise<{ data: { html_url: string; body?: string } }>;
    }

    try {
        const githubToken = await state.octokit.auth({ type: 'installation' }) as GitHubToken;
        const published = await publishPullRequestCommentVisualPreviews({
            owner: repoOwner,
            repo: repoName,
            pullRequestNumber,
            commitHash: commitResult.commitHash,
            body: prCommentTemplate,
            evidence: visualPreviewEvidence,
            authToken: githubToken.token,
            worktreePath: state.worktreeInfo.worktreePath,
            octokit: state.octokit,
            startingCommentId: state.startingWorkComment.data.id
        });
        return { data: published };
    } catch (previewError) {
        correlatedLogger.warn({ pullRequestNumber, error: (previewError as Error).message }, 'Could not upload visual previews; publishing committed-file links in the completion comment');
        return state.octokit.request('PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}', {
            owner: repoOwner,
            repo: repoName,
            comment_id: state.startingWorkComment.data.id,
            body: prCommentBody
        }) as Promise<{ data: { html_url: string; body?: string } }>;
    }
}

export async function handlePostExecution(params: PostExecutionParams, taskUrl: string): Promise<{ commitHash?: string; partial: boolean }> {
    const {
        state,
        job,
        taskId,
        stateManager,
        context,
        unprocessedReviewComments,
        llm,
        redisClient,
        prProcessingLockKey,
        prProcessingLockToken,
    } = params;
    const { repoOwner, repoName, pullRequestNumber, correlatedLogger } = context;

    requirePostExecutionState(state);
    const disposition = getPostExecutionDisposition(state.claudeResult);
    const terminationReason = resolveAgentTerminationReason(state.claudeResult);
    const partial = disposition === 'partial';
    if (disposition === 'failed') {
        throw new Error(`Agent execution failed: ${state.claudeResult.error || 'Unknown error'}`);
    }

    const { commitResult, changesSummary, commitMessage } = await commitAndPush(state, { repoOwner, repoName, pullRequestNumber }, llm);
    if (partial && !commitResult) {
        throw new Error(`Agent execution ${terminationReason === 'timeout' ? 'timed out' : 'reached the maximum turn limit'} before producing changes to publish`);
    }
    if (commitResult?.filesChanged?.length) state.claudeResult.modifiedFiles = commitResult.filesChanged;

    const completionComment = await publishCompletionComment({ state, context, commitResult, changesSummary, commitMessage, llm, taskUrl, unprocessedReviewComments });
    correlatedLogger.info({ pullRequestNumber, commitHash: commitResult?.commitHash, commentUrl: completionComment.data.html_url, partial, terminationReason }, partial ? 'Published partial follow-up changes after interrupted execution' : 'Successfully applied follow-up changes');

    if (unprocessedReviewComments.length > 0) {
        await markReviewFindingsProcessed(unprocessedReviewComments, {
            repoOwner,
            repoName,
            pullRequestNumber,
            redisClient,
            correlatedLogger,
            prProcessingLockKey,
            prProcessingLockToken,
        });
    }

    const ultrafixHistoryMeta = await resolveUltrafixHistoryMeta(job, { repoOwner, repoName, pullRequestNumber }, redisClient);

    await stateManager.updateTaskState(taskId, TaskStates.COMPLETED, {
        reason: partial ? 'PR comment processing published partial work after interrupted execution' : 'PR comment processing completed successfully',
        commitHash: commitResult?.commitHash,
        historyMetadata: {
            commandMode: job.data.commandMode || 'default',
            githubComment: { url: completionComment.data.html_url, body: completionComment.data.body },
            ...(unprocessedReviewComments.length > 0 && { consumedReviewCommentIds: unprocessedReviewComments.map(c => c.id) }),
            ...(partial && { incompleteExecution: { reason: terminationReason } }),
            ...ultrafixHistoryMeta,
        }
    });

    await persistCommitHash(taskId, commitResult?.commitHash, correlatedLogger);
    return { commitHash: commitResult?.commitHash, partial };
}
