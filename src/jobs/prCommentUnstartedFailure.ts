import type { Job } from 'bullmq';
import { getAuthenticatedOctokit, isWorktreeDiskPressureError, logger, type CommentJobData } from '@propr/core';
import { sanitizeErrorMessage } from './errorSanitizer.js';
import { buildWorkEvidenceMarker, filterRealComments } from '../shared/workEvidenceMarker.js';

/**
 * A PR comment job can fail for good before its processor runs: worktree
 * admission refuses it under disk pressure, for instance. The processor's own
 * failure handling (task state, the ❌ comment) never ran, so without this the
 * request looks ignored on GitHub. The comment carries the same processed
 * markers as a normal failure, so polling does not queue the request again on
 * its own; the requester posts the command again once the cause is gone.
 */

export interface UnstartedFailureOctokit {
    request(route: string, params: Record<string, unknown>): Promise<unknown>;
}

type UnstartedJob = Pick<Job<CommentJobData>, 'data'> & { id?: string; attemptsMade?: number };

const COMMAND_NAMES: Record<string, string> = { fix: '`/fix`', review: '`/review`', ultrafix: '`/ultrafix`', switch: '`/switch`', use: '`/use`' };

function requestedComments(data: CommentJobData): Array<{ id: number; author: string }> {
    if (Array.isArray(data.comments) && data.comments.length) return filterRealComments(data.comments);
    if (data.commentId && data.commentAuthor) return filterRealComments([{ id: data.commentId, author: data.commentAuthor }]);
    return [];
}

function explanation(error: Error, attempts: number): string {
    if (isWorktreeDiskPressureError(error)) {
        return 'The ProPR worker refused the job because the disk that holds its working copies is nearly full. '
            + 'Nothing was changed on this pull request. Once space has been freed on the worker host, post the command again.';
    }
    const times = attempts > 1 ? ` ${attempts} times` : '';
    return `The job failed${times} before processing began:\n\n\`\`\`\n${sanitizeErrorMessage(error.message)}\n\`\`\`\n\nPost the command again once the cause is resolved.`;
}

export function unstartedPRCommentFailureBody(job: UnstartedJob, error: Error): string {
    const comments = requestedComments(job.data);
    const authors = [...new Set(comments.map(comment => comment.author))].map(author => `@${author}`).join(', ');
    const command = COMMAND_NAMES[job.data.commandMode ?? ''] ?? 'the follow-up';
    const ids = comments.map(comment => comment.id);
    const evidence = buildWorkEvidenceMarker('failed', ids);
    const footer = ids.length
        ? `\n\n---\nComment ID${ids.length > 1 ? 's' : ''}: ${ids.map(id => `${id}✓`).join(', ')}${evidence ? `\n${evidence}` : ''}`
        : '';
    return `❌ **ProPR could not start on ${command}**${authors ? ` requested by ${authors}` : ''}\n\n${explanation(error, job.attemptsMade ?? 1)}${footer}`;
}

/** Posts the explanation on the pull request; a failure to post is logged, never thrown. */
export async function postUnstartedPRCommentFailure(job: UnstartedJob, error: Error, octokit?: UnstartedFailureOctokit): Promise<boolean> {
    const { repoOwner, repoName, pullRequestNumber, correlationId } = job.data;
    const log = correlationId ? logger.withCorrelation(correlationId) : logger;
    try {
        const client = octokit ?? await getAuthenticatedOctokit();
        await client.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
            owner: repoOwner, repo: repoName, issue_number: pullRequestNumber,
            body: unstartedPRCommentFailureBody(job, error),
        });
        log.info({ jobId: job.id, pullRequestNumber, diskPressure: isWorktreeDiskPressureError(error) }, 'Reported a PR comment job that failed before it started on the pull request');
        return true;
    } catch (postError) {
        log.error({ jobId: job.id, pullRequestNumber, error: (postError as Error).message, cause: error.message }, 'Failed to report a PR comment job that failed before it started');
        return false;
    }
}
