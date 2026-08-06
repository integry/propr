import type { Job } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import {
    TaskStates,
    type CommentJobData,
    type UnprocessedComment,
    type WorkerStateManager,
    getAuthenticatedOctokit,
} from '@propr/core';
import { buildWorkEvidenceMarker, filterRealComments } from '../shared/workEvidenceMarker.js';
import { handleUltrafixContinuation } from './ultrafixJobHelpers.js';

interface NoAuthorizedFindingsParams {
    job: Job<CommentJobData>;
    taskId: string;
    taskUrl: string;
    stateManager: WorkerStateManager;
    octokit: Awaited<ReturnType<typeof getAuthenticatedOctokit>>;
    unprocessedComments: UnprocessedComment[];
    redisClient: Redis;
    repoOwner: string;
    repoName: string;
    pullRequestNumber: number;
    correlatedLogger: Logger;
    correlationId: string;
}

export async function handleNoAuthorizedFindings(params: NoAuthorizedFindingsParams): Promise<void> {
    const {
        job, taskId, taskUrl, stateManager, octokit, unprocessedComments, redisClient,
        repoOwner, repoName, pullRequestNumber, correlatedLogger, correlationId,
    } = params;
    if (job.data.ultrafixMeta) {
        const body = '⚠️ **Ultrafix could not apply this fix because no unprocessed actionable review findings remain.** The queued review may have been removed, consumed, or become invalid. Ultrafix will request a fresh review, or stop for manual review if its retry limit has been reached.';
        await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
            owner: repoOwner, repo: repoName, issue_number: pullRequestNumber, body,
        }).catch(commentError => correlatedLogger.warn(
            { error: (commentError as Error).message, pullRequestNumber },
            'Failed to post Ultrafix no-findings retry comment',
        ));
        await stateManager.updateTaskState(taskId, TaskStates.COMPLETED, {
            reason: 'Ultrafix fix skipped because no authorized review findings remained',
            historyMetadata: { commandMode: 'fix', ultrafixCycle: true, ultrafixNoAuthorizedFindings: true },
        });
        await handleUltrafixContinuation('fix', {
            job, stateManager, taskId, redisClient, repoOwner, repoName,
            pullRequestNumber, correlatedLogger, correlationId,
        });
        return;
    }

    const commentIds = filterRealComments(unprocessedComments).map(comment => comment.id);
    const completedEvidence = buildWorkEvidenceMarker('completed', commentIds);
    const commentIdsSuffix = commentIds.length > 0
        ? `\n\n---\n_Processing comment ID${commentIds.length > 1 ? 's' : ''}: ${commentIds.map(id => `${id}✓`).join(', ')}_`
        : '';
    const body = `ℹ️ **No authorized review findings were selected.**\n\nNo files were changed because this \`/fix\` command did not select an actionable F# finding or explicitly authorize a suggestion.\n\n[View Task Execution](${taskUrl})${commentIdsSuffix}${completedEvidence ? `\n${completedEvidence}` : ''}`;
    const completionComment = await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
        owner: repoOwner, repo: repoName, issue_number: pullRequestNumber, body,
    }) as { data: { html_url: string; body?: string } };
    await stateManager.updateTaskState(taskId, TaskStates.COMPLETED, {
        reason: 'Manual fix skipped because no authorized review findings were selected',
        historyMetadata: {
            commandMode: 'fix',
            noAuthorizedReviewFindings: true,
            githubComment: { url: completionComment.data.html_url, body: completionComment.data.body ?? body },
        },
    });
}
