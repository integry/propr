import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import {
    commitChanges,
    getRepoUrl,
    getAuthenticatedOctokit,
    pushBranch,
    resolveAgentTerminationReason,
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
import type { AIReviewComment } from './reviewCommentGatherer.js';
import type { GitHubToken } from './githubTypes.js';
import {
    checkpointPRCommentPublication,
    finalizePRCommentPublication,
    type PRCommentPublicationState,
} from './prCommentPublicationRecovery.js';

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
    prProcessingLockToken: string;
    assertLease: () => Promise<void>;
    signal: AbortSignal;
    /** Runs fenced continuation work immediately before terminal completion. */
    beforeCompletion: () => Promise<void>;
}

interface UndoContextParams {
    commitResult: Awaited<ReturnType<typeof commitChanges>>;
    unprocessedComments: UnprocessedComment[];
    repoOwner: string;
    repoName: string;
    pullRequestNumber: number;
    branchName: string;
}

async function commitForPublication(
    state: ReadyPostExecutionState,
    pullRequestNumber: number,
    options: { llm: string | null | undefined; assertLease: () => Promise<void>; signal: AbortSignal },
) {
    const { llm, assertLease, signal } = options;
    const changesSummary = state.claudeResult.summary || state.claudeResult.finalResult?.result || '';
    const commitMessage = buildCommitMessage({ changesSummary, unprocessedComments: state.unprocessedComments, pullRequestNumber, claudeResult: state.claudeResult, llm, authorsText: state.authorsText });
    await assertLease();
    const commitResult = await commitChanges(state.worktreeInfo.worktreePath, commitMessage, AI_COMMIT_AUTHOR, {
        issueNumber: pullRequestNumber,
        issueTitle: 'Follow-up changes',
        signal,
    });
    return { commitResult, changesSummary, commitMessage };
}

async function pushCommittedChanges(
    state: ReadyPostExecutionState,
    commitResult: NonNullable<Awaited<ReturnType<typeof commitChanges>>>,
    issueRef: { repoOwner: string; repoName: string },
    options: { assertLease: () => Promise<void>; signal: AbortSignal },
): Promise<boolean> {
    await options.assertLease();
    const repoUrl = getRepoUrl(issueRef);
    const githubToken = await state.octokit.auth({ type: 'installation' }) as GitHubToken;
    await options.assertLease();
    const pushResult = await pushBranch(state.worktreeInfo.worktreePath, state.worktreeInfo.branchName, {
        repoUrl,
        authToken: githubToken.token,
        rebaseOnNonFastForward: true,
        signal: options.signal,
    });
    if (pushResult.rebased && pushResult.commitHash) {
        commitResult.commitHash = pushResult.commitHash;
    }
    return Boolean(pushResult.rebased && pushResult.commitHash);
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

function buildPublicationState(
    options: {
        state: ReadyPostExecutionState;
        body: string;
        commitHash: string | undefined;
        reviewCommentIds: number[];
        partial: boolean;
        terminationReason: ReturnType<typeof resolveAgentTerminationReason>;
    },
): PRCommentPublicationState {
    const { state, body, commitHash, reviewCommentIds, partial, terminationReason } = options;
    return {
        branchName: state.worktreeInfo.branchName,
        claudeSuccess: state.claudeResult.success,
        commitHash,
        completionComment: {
            id: state.startingWorkComment.data.id,
            htmlUrl: '',
            body,
        },
        reviewCommentIds,
        partial,
        terminationReason,
    };
}

export async function handlePostExecution(params: PostExecutionParams, taskUrl: string): Promise<{ commitHash?: string; partial: boolean }> {
    const { state, context, unprocessedReviewComments, llm, assertLease, signal } = params;
    const { repoOwner, repoName, pullRequestNumber, correlatedLogger } = context;

    requirePostExecutionState(state);
    const disposition = getPostExecutionDisposition(state.claudeResult);
    const terminationReason = resolveAgentTerminationReason(state.claudeResult);
    const partial = disposition === 'partial';
    if (disposition === 'failed') {
        throw new Error(`Agent execution failed: ${state.claudeResult.error || 'Unknown error'}`);
    }

    const { commitResult, changesSummary, commitMessage } = await commitForPublication(
        state,
        pullRequestNumber,
        { llm, assertLease, signal },
    );
    if (partial && !commitResult) {
        const reason = terminationReason === 'timeout' ? 'timed out' : 'reached the maximum turn limit';
        throw new Error(`Agent execution ${reason} before producing changes to publish`);
    }
    if (commitResult?.filesChanged?.length) state.claudeResult.modifiedFiles = commitResult.filesChanged;

    const undoContext = buildUndoContext({ commitResult, unprocessedComments: state.unprocessedComments, repoOwner, repoName, pullRequestNumber, branchName: state.worktreeInfo.branchName });
    const reviewCommentIds = unprocessedReviewComments.map(comment => comment.id);
    let prCommentBody = await buildCompletionComment(commitResult, state.unprocessedComments, {
        changesSummary,
        commitMessage,
        llm,
        authorsText: state.authorsText,
        undoContext,
        taskUrl,
        consumedReviewCommentIds: reviewCommentIds.length > 0 ? reviewCommentIds : undefined,
    }, state.claudeResult);
    const publication = buildPublicationState({
        state,
        body: prCommentBody,
        commitHash: commitResult?.commitHash,
        reviewCommentIds,
        partial,
        terminationReason,
    });
    if (commitResult) {
        const rebased = await pushCommittedChanges(
            state,
            commitResult,
            { repoOwner, repoName },
            { assertLease, signal },
        );
        publication.commitHash = commitResult.commitHash;
        // Persist immediately after the irreversible push. If a rebase changed
        // the SHA, the prepared body is corrected in the next checkpoint.
        await checkpointPRCommentPublication(params, publication, 'branch_pushed');
        if (rebased) {
            prCommentBody = await buildCompletionComment(commitResult, state.unprocessedComments, {
                changesSummary,
                commitMessage,
                llm,
                authorsText: state.authorsText,
                undoContext,
                taskUrl,
                consumedReviewCommentIds: reviewCommentIds.length > 0 ? reviewCommentIds : undefined,
            }, state.claudeResult);
            publication.completionComment.body = prCommentBody;
            await checkpointPRCommentPublication(params, publication, 'branch_pushed');
        }
    } else {
        await checkpointPRCommentPublication(params, publication, 'branch_pushed');
    }

    await assertLease();
    const completionComment = await state.octokit.request('PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}', {
        owner: repoOwner,
        repo: repoName,
        comment_id: publication.completionComment.id,
        body: publication.completionComment.body,
        request: { signal },
    }) as { data: { html_url: string; body?: string } };
    publication.completionComment.htmlUrl = completionComment.data.html_url;
    publication.completionComment.body = completionComment.data.body ?? publication.completionComment.body;
    await checkpointPRCommentPublication(params, publication, 'completion_comment_published');

    correlatedLogger.info(
        { pullRequestNumber, commitHash: publication.commitHash, commentUrl: publication.completionComment.htmlUrl, partial, terminationReason },
        partial ? 'Published partial follow-up changes after interrupted execution' : 'Successfully applied follow-up changes',
    );
    await finalizePRCommentPublication(params, publication, 'completion_comment_published');
    return { commitHash: publication.commitHash, partial };
}
