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
import {
    type ReviewFeedbackSelection,
    describeReviewFeedbackSelection,
    isEmptyReviewFeedbackSelection,
} from '@propr/shared';
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
    /** Requested identifiers no current review offers. */
    unresolved?: ReviewFeedbackSelection;
    /** Invalid identifiers or incompatible selector clauses, e.g. `S0` or `ALL S3`. */
    malformedIds?: string[];
}

export async function handleNoAuthorizedFindings(params: NoAuthorizedFindingsParams): Promise<void> {
    const {
        job, taskId, taskUrl, stateManager, octokit, unprocessedComments, redisClient,
        repoOwner, repoName, pullRequestNumber, correlatedLogger, correlationId,
        unresolved, malformedIds,
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
            historyMetadata: {
                commandMode: 'fix',
                notificationRecap: 'No files were changed because no actionable review findings remained.',
                ultrafixCycle: true,
                ultrafixNoAuthorizedFindings: true,
            },
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
    // Naming the failures is the difference between an actionable message and a
    // dead end. A user who typed `S0`, or named a suggestion from a superseded
    // review, otherwise has no way to tell a typo from a stale reference.
    const problems: string[] = [];
    if (malformedIds && malformedIds.length > 0) {
        if (malformedIds.some(clause => /^ALL[\s,]/i.test(clause))) {
            problems.push('`all` cannot be combined with `F#` or `S#` selectors on the command line. '
                + 'Nothing was applied. Use `/fix all` for every pending finding and suggestion, or name '
                + 'individual records, for example `/fix F3 S3`. To add instructions to `/fix all`, '
                + 'put them after `;` or on a following line.');
        } else {
            problems.push(`These are not valid review identifiers: ${malformedIds.join(', ')}. `
                + 'Nothing was applied, because a request that is partly not understood is not acted on. '
                + 'Correct them and run `/fix` again. Unsupported forms include ranges such as `F1-F2`: name each '
                + 'record separately, as `/fix F1 F2`. If that text was meant as instructions rather than a '
                + 'selection, put it on a line below the `/fix` line.');
        }
    }
    if (unresolved && !isEmptyReviewFeedbackSelection(unresolved)) {
        problems.push(`No current review offers ${describeReviewFeedbackSelection(unresolved)}. `
            + 'They may have been addressed already, or they belong to a review of an older head. '
            + 'Nothing was applied: a request that names a record no review offers is not acted on in part, '
            + 'so any records you named beside these were left untouched. Name only records a current review '
            + 'offers and run `/fix` again.');
    }
    const body = [
        'ℹ️ **No review findings or suggestions were selected.**',
        'No files were changed because this `/fix` command resolved to no review record.',
        ...problems,
        'Name at least one `F#` finding or `S#` suggestion from a current review comment, for example `/fix F20 S3`. '
            + 'Use `/fix all` to request every pending finding and suggestion. '
            + 'Any text after the identifiers, and every line below the command, is passed through as instructions.',
        `[View Task Execution](${taskUrl})`,
    ].join('\n\n') + `${commentIdsSuffix}${completedEvidence ? `\n${completedEvidence}` : ''}`;
    const completionComment = await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
        owner: repoOwner, repo: repoName, issue_number: pullRequestNumber, body,
    }) as { data: { html_url: string; body?: string } };
    await stateManager.updateTaskState(taskId, TaskStates.COMPLETED, {
        reason: 'Manual fix skipped because no authorized review findings were selected',
        historyMetadata: {
            commandMode: 'fix',
            notificationRecap: 'No files were changed because no authorized review findings were selected.',
            noAuthorizedReviewFindings: true,
            // Recorded only when something was actually named, so a bare `/fix`
            // with nothing pending keeps the recap it has always had.
            ...(malformedIds && malformedIds.length > 0 && { malformedReviewFeedbackIds: malformedIds }),
            ...(unresolved && !isEmptyReviewFeedbackSelection(unresolved) && {
                unresolvedReviewFeedback: { findingIds: unresolved.findingIds, suggestionIds: unresolved.suggestionIds },
            }),
            githubComment: { url: completionComment.data.html_url, body: completionComment.data.body ?? body },
        },
    });
}
