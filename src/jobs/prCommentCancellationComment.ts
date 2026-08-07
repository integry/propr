import type { Logger } from 'pino';
import type { getAuthenticatedOctokit } from '@propr/core';

interface CancellationCommentParams {
    octokit: Awaited<ReturnType<typeof getAuthenticatedOctokit>>;
    repoOwner: string;
    repoName: string;
    commentId: number;
    correlatedLogger: Logger;
    assertLease: () => Promise<void>;
    signal: AbortSignal;
}

export async function postCancellationComment(params: CancellationCommentParams): Promise<void> {
    const { octokit, repoOwner, repoName, commentId, correlatedLogger, assertLease, signal } = params;
    await assertLease();
    try {
        await octokit.request('PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}', {
            owner: repoOwner,
            repo: repoName,
            comment_id: commentId,
            body: `🛑 **Execution Cancelled**\n\nThe task processing was stopped by user request.\n\nYou can post a new comment to restart processing.`,
            request: { signal },
        });
    } catch (commentError) {
        signal.throwIfAborted();
        await assertLease();
        correlatedLogger.error({ error: (commentError as Error).message }, 'Failed to post cancellation comment');
        return;
    }
    await assertLease();
}
