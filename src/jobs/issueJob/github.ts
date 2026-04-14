/**
 * GitHub operations for issue job processing.
 */

import type { Logger } from 'pino';
import { logger, handleError, getAuthenticatedOctokit, withRetry, retryConfigs, filterCommentByAuthor } from '@propr/core';
import type { IssueJobData } from '@propr/core';
import type { JobContext, LabelCheckResult, IssueComment } from './types.js';

export async function getAuthenticatedClient(context: JobContext): Promise<Awaited<ReturnType<typeof getAuthenticatedOctokit>>> {
  const { correlationId, stateManager, taskId, correlatedLogger, issueRef } = context;
  try {
    return await withRetry(() => getAuthenticatedOctokit(), { ...retryConfigs.githubApi, correlationId }, 'get_authenticated_octokit');
  } catch (authError) {
    const errorDetails = handleError(authError, 'Worker: Failed to get authenticated Octokit instance', { correlationId, issueRef });
    try {
      await stateManager.markTaskFailed(taskId, authError as Error, { errorCategory: errorDetails.category });
    } catch (stateError) {
      correlatedLogger.warn({ error: (stateError as Error).message }, 'Failed to update task state to failed');
    }
    throw authError;
  }
}

export function checkLabelConditions(currentLabels: string[], context: JobContext): LabelCheckResult {
  const { jobId, issueRef, AI_PRIMARY_TAG, AI_DONE_TAG } = context;
  if (!currentLabels.includes(AI_PRIMARY_TAG)) {
    logger.warn({ jobId, issueNumber: issueRef.number }, `Issue no longer has primary tag '${AI_PRIMARY_TAG}'. Skipping.`);
    return { skip: true, reason: 'Primary tag missing' };
  }
  if (currentLabels.includes(AI_DONE_TAG)) {
    logger.warn({ jobId, issueNumber: issueRef.number }, `Issue already has '${AI_DONE_TAG}' tag. Skipping.`);
    return { skip: true, reason: 'Already done' };
  }
  return { skip: false };
}

export async function fetchIssueComments(
  octokit: Awaited<ReturnType<typeof getAuthenticatedOctokit>>,
  issueRef: IssueJobData,
  correlatedLogger: Logger
): Promise<IssueComment[]> {
  try {
    // Fetch ALL comments with pagination to handle issues with 100+ comments
    const allComments: IssueComment[] = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const commentsResp = await octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', {
        owner: issueRef.repoOwner, repo: issueRef.repoName, issue_number: issueRef.number, per_page: 100, page,
        mediaType: { format: 'full' }  // Get body_html with signed image URLs
      });
      const pageComments = commentsResp.data as IssueComment[];
      allComments.push(...pageComments);

      // Check if there are more pages
      const linkHeader = (commentsResp.headers as Record<string, string | undefined>).link;
      hasMore = Boolean(linkHeader && linkHeader.includes('rel="next"'));
      page++;
    }

    return allComments.filter(comment => {
      const filterResult = filterCommentByAuthor(comment.user.login, comment.user.type);
      return !filterResult.shouldFilter;
    });
  } catch (commentError) {
    correlatedLogger.warn({ issueNumber: issueRef.number, error: (commentError as Error).message }, 'Failed to fetch issue comments, continuing without them');
    return [];
  }
}
