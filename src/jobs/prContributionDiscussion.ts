import type { getAuthenticatedOctokit } from '@propr/core';
import { findPRContinuation, type Contribution, type PullRequestReference } from './prContinuation.js';
import { buildCommentHistory } from './prCommentJobHelpers.js';
import { fetchAllComments } from './prCommentJobUtils.js';

export async function loadOriginalContributionDiscussion(
    octokit: Awaited<ReturnType<typeof getAuthenticatedOctokit>>,
    context: PullRequestReference & { correlationId: string },
): Promise<string> {
    const { repoOwner, repoName, pullRequestNumber, correlationId } = context;
    const continuation = await findPRContinuation(context);
    if (continuation && continuation.source_pr !== pullRequestNumber) {
        const sourceRef = { owner: repoOwner, repo: repoName, pull_number: continuation.source_pr };
        const originalPR = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', sourceRef) as { data: Contribution };
        const originalComments = await fetchAllComments(octokit, repoOwner, repoName, continuation.source_pr);
        return `\n\nOriginal contribution discussion (#${continuation.source_pr}):\n${buildCommentHistory(originalComments, originalPR, correlationId)}`;
    }
    return '';
}
