import { Job } from 'bullmq';
import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import {
    commitChanges,
    cleanupPreparedVisualPreviewEvidence,
    db,
    getAuthenticatedOctokit,
    loadRepositoryVisualPreviewSettings,
    prepareVisualPreviewEvidence,
    appendVisualPreviewSection,
    renderVisualPreviewSection,
    renderVisualPreviewUploadFailureSection,
    resolveAgentTerminationReason,
    sanitizeAgentReport,
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
import {
    isVisualPreviewUploadAuthenticationError,
    publishPullRequestCommentVisualPreviews,
} from '../github/visualPreviewAttachments.js';
import type { PullRequestPublication } from './prPublication.js';
import { savePublicationCheckpoint } from './prContinuation.js';
import { buildWorkNotificationRecap } from './notificationRecap.js';

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
    claudeResult: ClaudeCodeResponse;
    startingWorkComment: { data: { id: number; html_url: string } };
}

interface PostExecutionContext {
    pullRequestNumber: number;
    repoOwner: string;
    repoName: string;
    publication: PullRequestPublication;
    correlatedLogger: Logger;
}

/** Serializable inputs needed to finish the originating task after its worktree is gone. */
export interface PublicationCompletion {
    taskId: string;
    instructionCommentIds: number[];
    jobData: CommentJobData;
    claudeResult: ClaudeCodeResponse;
    authorsText: string;
    unprocessedComments: UnprocessedComment[];
    startingWorkComment: ReadyPostExecutionState['startingWorkComment'];
    unprocessedReviewComments: AIReviewComment[];
    llm?: string | null;
    taskUrl: string;
    commitResult: Awaited<ReturnType<typeof commitChanges>>;
    changesSummary: string;
    commitMessage: string;
}

interface PostExecutionParams {
    recoveredCompletion?: PublicationCompletion;
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
    context: PostExecutionContext,
    llm: string | null | undefined,
    completionInputs: Omit<PublicationCompletion, 'commitResult' | 'changesSummary' | 'commitMessage'>
) {
    if (!state.worktreeInfo) throw new Error('Cannot commit PR comment changes without a worktree');
    const changesSummary = sanitizeAgentReport(state.claudeResult.summary || state.claudeResult.finalResult?.result || '');
    const commitMessage = buildCommitMessage({ changesSummary, unprocessedComments: state.unprocessedComments, pullRequestNumber: context.pullRequestNumber, claudeResult: state.claudeResult, llm, authorsText: state.authorsText });
    const commitResult = await commitChanges(state.worktreeInfo.worktreePath, commitMessage, AI_COMMIT_AUTHOR, { issueNumber: context.pullRequestNumber, issueTitle: 'Follow-up changes' });

    if (commitResult) {
        const pushResult = await context.publication.push(state.worktreeInfo.worktreePath, { ...completionInputs, commitResult, changesSummary, commitMessage });
        if (pushResult.commitHash) {
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
    visualPreviewEvidence?: Awaited<ReturnType<typeof prepareVisualPreviewEvidence>>['evidence'];
}

async function updateCompletionComment(state: ReadyPostExecutionState, context: PostExecutionContext, body: string) {
    const { repoOwner: owner, repoName: repo, pullRequestNumber: issue_number } = context;
    try {
        return await state.octokit.request('PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}', {
            owner, repo, comment_id: state.startingWorkComment.data.id, body,
        });
    } catch (error) {
        if ((error as { status?: number }).status !== 404) throw error;
        const replacement = await state.octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
            owner, repo, issue_number, body,
        });
        state.startingWorkComment = { data: { id: replacement.data.id, html_url: replacement.data.html_url } };
        const completion = context.publication.pendingCompletion;
        if (completion) {
            completion.startingWorkComment = state.startingWorkComment;
            const record = context.publication.continuation!;
            // Retain the replacement before later completion steps can fail and retry.
            await savePublicationCheckpoint(record, record.publication_bundle, JSON.stringify(completion));
        }
        return replacement;
    }
}

async function publishCompletionComment(options: CompletionCommentPublicationOptions): Promise<{ data: { html_url: string; body?: string } }> {
    const { state, context, commitResult, changesSummary, commitMessage, llm, taskUrl, unprocessedReviewComments, visualPreviewEvidence = { assets: [], toolSuggestions: [] } } = options;
    const { repoOwner, repoName, pullRequestNumber, correlatedLogger } = context;
    const hasVisualPreviewContent = visualPreviewEvidence.assets.length > 0
        || visualPreviewEvidence.toolSuggestions.length > 0;
    const visualPreviewSection = hasVisualPreviewContent
        ? renderVisualPreviewSection({ assets: [], toolSuggestions: visualPreviewEvidence.toolSuggestions }, {})
        : '';
    const undoContext = context.publication.continuation || !state.worktreeInfo ? undefined : buildUndoContext({ commitResult, unprocessedComments: state.unprocessedComments, repoOwner, repoName, pullRequestNumber, branchName: state.worktreeInfo.branchName });
    const consumedReviewCommentIds = unprocessedReviewComments.length > 0 ? unprocessedReviewComments.map(comment => comment.id) : undefined;
    const completionBody = await buildCompletionComment(commitResult, state.unprocessedComments, {
        changesSummary,
        commitMessage,
        llm,
        authorsText: state.authorsText,
        undoContext,
        taskUrl,
        consumedReviewCommentIds,
        visualPreviewSection: hasVisualPreviewContent ? VISUAL_PREVIEW_SLOT : undefined
    }, state.claudeResult);
    const prCommentTemplate = [context.publication.status, completionBody].filter(Boolean).join('\n\n');
    const prCommentBody = appendVisualPreviewSection(prCommentTemplate, visualPreviewSection);

    if (visualPreviewEvidence.assets.length === 0) {
        return updateCompletionComment(state, context, prCommentBody);
    }

    if (!state.worktreeInfo) throw new Error('Cannot publish visual previews without a worktree');
    try {
        const published = await publishPullRequestCommentVisualPreviews({
            owner: repoOwner,
            repo: repoName,
            pullRequestNumber,
            body: prCommentTemplate,
            evidence: visualPreviewEvidence,
            worktreePath: state.worktreeInfo.worktreePath,
            octokit: state.octokit,
            startingCommentId: state.startingWorkComment.data.id
        });
        return { data: published };
    } catch (previewError) {
        correlatedLogger.warn({ pullRequestNumber, error: (previewError as Error).message }, 'Could not upload visual previews; publishing a text-only explanation');
        return updateCompletionComment(state, context,
            appendVisualPreviewSection(prCommentTemplate, renderVisualPreviewUploadFailureSection(
                visualPreviewEvidence,
                { authenticationFailure: isVisualPreviewUploadAuthenticationError(previewError) }
            ))
        );
    }
}

function requirePartialExecutionChanges(
    partial: boolean,
    commitResult: Awaited<ReturnType<typeof commitChanges>>,
    terminationReason: ReturnType<typeof resolveAgentTerminationReason>,
): void {
    if (partial && !commitResult) {
        throw new Error(`Agent execution ${terminationReason === 'timeout' ? 'timed out' : 'reached the maximum turn limit'} before producing changes to publish`);
    }
}

async function preparePostExecutionPreviews(state: ReadyPostExecutionState, repository: string, taskId: string) {
    if (!state.worktreeInfo) return;
    return prepareVisualPreviewEvidence({
        worktreePath: state.worktreeInfo.worktreePath,
        settings: await loadRepositoryVisualPreviewSettings(repository),
        taskId,
    });
}

function buildPostExecutionRecap(
    jobData: CommentJobData,
    completion: Pick<PublicationCompletion, 'commitResult' | 'changesSummary'>,
    partial: boolean,
): string {
    const { commitResult, changesSummary } = completion;
    return buildWorkNotificationRecap(changesSummary, {
        commandMode: jobData.commandMode || 'default',
        filesChanged: commitResult?.filesChanged?.length,
        noChanges: !commitResult,
        partial,
    });
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

    let preparedVisualPreview: Awaited<ReturnType<typeof prepareVisualPreviewEvidence>> | undefined;
    try {
        preparedVisualPreview = await preparePostExecutionPreviews(state, `${repoOwner}/${repoName}`, taskId);
        const { commitResult, changesSummary, commitMessage } = params.recoveredCompletion ?? await commitAndPush(state, context, llm, {
            taskId, instructionCommentIds: state.unprocessedComments.map(comment => comment.id),
            jobData: job.data, claudeResult: state.claudeResult, authorsText: state.authorsText,
            unprocessedComments: state.unprocessedComments, startingWorkComment: state.startingWorkComment,
            unprocessedReviewComments, llm, taskUrl,
        });
        requirePartialExecutionChanges(partial, commitResult, terminationReason);
        if (commitResult?.filesChanged?.length) state.claudeResult.modifiedFiles = commitResult.filesChanged;

        const completionComment = await publishCompletionComment({
            state,
            context,
            commitResult,
            changesSummary,
            commitMessage,
            llm,
            taskUrl,
            unprocessedReviewComments,
            visualPreviewEvidence: preparedVisualPreview?.evidence
        });
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
                continuation: context.publication.continuation ? {
                    ...context.publication.continuation, publication_bundle: null, publication_completion: null,
                } : undefined,
                githubComment: { url: completionComment.data.html_url, body: completionComment.data.body },
                notificationRecap: buildPostExecutionRecap(job.data, { commitResult, changesSummary }, partial),
                ...(unprocessedReviewComments.length > 0 && { consumedReviewCommentIds: unprocessedReviewComments.map(c => c.id) }),
                ...(partial && { incompleteExecution: { reason: terminationReason } }),
                ...ultrafixHistoryMeta,
            }
        });

        await persistCommitHash(taskId, commitResult?.commitHash, correlatedLogger);
        return { commitHash: commitResult?.commitHash, partial };
    } finally {
        try {
            await cleanupPreparedVisualPreviewEvidence(preparedVisualPreview);
        } catch (cleanupError) {
            correlatedLogger.warn({ error: (cleanupError as Error).message }, 'Could not clean up staged visual previews');
        }
    }
}
