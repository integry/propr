/**
 * The public notice for a PR follow-up that failed: one plain-words cause, a
 * task link, and the receipts of the comments it consumed. Identical failures
 * on the same head within an hour are counted on the first notice.
 */
import { formatPushFailureMarkdown, redactSecrets, type PushFailureRecord } from '@propr/core';
import { describeFailureCause } from '@propr/shared';
import { buildWorkEvidenceMarker, filterRealComments } from '../shared/workEvidenceMarker.js';
import {
    failureCommentKey, publishFailureComment, readPullRequestHeadSha, taskPageUrl,
    type PublishFailureCommentResult,
} from './failureCommentDedupe.js';

type FailureOctokit = Parameters<typeof publishFailureComment>[0];

export interface FollowupFailureCommentOptions {
    octokit: FailureOctokit;
    repoOwner: string;
    repoName: string;
    pullRequestNumber: number;
    startingCommentId: number;
    authorsText: string;
    comments: ReadonlyArray<{ id: number; author: string }>;
    taskId: string;
    error: Error;
    pushFailure: PushFailureRecord | undefined;
    /** Handoff and publication markers the notice must carry. */
    prefix?: string;
    headSha?: string;
}

/** `Comment IDs: 1✓, 2✓` receipt for real GitHub comments only (never the synthetic id 0). */
export function followupCommentReceipt(comments: ReadonlyArray<{ id: number; author: string }>): string {
    const ids = filterRealComments(comments).map(comment => comment.id);
    const idLine = ids.length > 0 ? `Comment ID${ids.length > 1 ? 's' : ''}: ${ids.map(id => `${id}✓`).join(', ')}` : '';
    const evidence = buildWorkEvidenceMarker('failed', ids);
    return [idLine, evidence].filter(Boolean).join('\n');
}

export function buildFollowupFailureBody(options: Omit<FollowupFailureCommentOptions, 'octokit' | 'startingCommentId' | 'headSha'>): { body: string; cause: string } {
    const cause = options.pushFailure
        ? `push-rejected:${options.pushFailure.diagnosis.classification}`
        : redactSecrets(describeFailureCause(options.error.message));
    const detail = options.pushFailure ? formatPushFailureMarkdown(options.pushFailure) : `**Cause:** ${cause}`;
    const receipt = followupCommentReceipt(options.comments);
    const body = [
        `${options.prefix ?? ''}❌ **Failed to apply follow-up changes** requested by ${options.authorsText}`,
        detail,
        `[View task details](${taskPageUrl(options.taskId)})`,
        receipt ? `---\n${receipt}` : '',
    ].filter(Boolean).join('\n\n');
    return { body, cause };
}

export async function publishFollowupFailureComment(options: FollowupFailureCommentOptions): Promise<PublishFailureCommentResult> {
    const { octokit, repoOwner: owner, repoName: repo, pullRequestNumber: issueNumber } = options;
    const { body, cause } = buildFollowupFailureBody(options);
    const headSha = options.headSha ?? await readPullRequestHeadSha(octokit, { owner, repo, issueNumber });
    const receipt = followupCommentReceipt(options.comments);
    return publishFailureComment(octokit, {
        owner, repo, issueNumber, body,
        key: failureCommentKey({ kind: 'pr-followup', headSha, cause }),
        startingCommentId: options.startingCommentId,
        startingCommentReceipt: `${options.prefix ? `\n\n${options.prefix.trim()}` : ''}${receipt ? `\n\n---\n${receipt}` : ''}`,
    });
}
