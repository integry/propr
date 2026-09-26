import type { getAuthenticatedOctokit } from '@propr/core';
import type { Redis } from 'ioredis';
import { continuationStatus, type ContinuationRecord, type PullRequestReference } from './prContinuation.js';
import { stopLoop } from './ultrafixOrchestrationService.js';

/** Original-PR findings and check gates refer to the old head. Stop that cycle;
 * a new cycle on the continuation will gather fresh findings and checks.
 */
export async function stopOriginalPRReviewCycle(options: {
    ref: PullRequestReference;
    continuation?: ContinuationRecord;
    commandMode?: string;
    ultrafix: boolean;
    redis: Redis;
    octokit: Awaited<ReturnType<typeof getAuthenticatedOctokit>>;
}): Promise<string | undefined> {
    const { ref, continuation, commandMode, ultrafix, redis, octokit } = options;
    if (!continuation?.continuation_pr || continuation.source_pr !== ref.pullRequestNumber
        || (!ultrafix && commandMode !== 'review' && commandMode !== 'fix')) return;
    await stopLoop(redis, ref.repoOwner, ref.repoName, ref.pullRequestNumber);
    const destination = continuationStatus(continuation) || `Continuation branch: \`${continuation.branch_name}\`. Retry the implementation request to finish creating its PR.`;
    const body = `Automated review/fix processing has stopped on this original PR because implementation has moved. ${destination}\n\nRun /review, /fix, or /ultrafix on the continuation PR to review its current code. The original discussion remains available as context.`;
    await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
        owner: ref.repoOwner, repo: ref.repoName, issue_number: ref.pullRequestNumber, body,
    });
    return body;
}
