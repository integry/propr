import type { CommentJobData } from '@propr/core';

type QueueReader = {
    getWaiting: () => Promise<Array<{ name?: string; data?: unknown } | undefined>>;
    getDelayed: () => Promise<Array<{ name?: string; data?: unknown } | undefined>>;
};

/**
 * Whether a waiting or delayed PR comment job will claim the PR's pending
 * comment list when it runs. Intake queues such a drain job for a comment it
 * stores behind a running job (#3686). A queue that cannot be read counts as
 * no pickup, so the caller queues one rather than risk leaving the list unread.
 */
export async function hasQueuedPRCommentPickup(
    queue: QueueReader,
    ref: { repoOwner: string; repoName: string; pullRequestNumber: number },
): Promise<boolean> {
    try {
        const jobs = [...await queue.getWaiting(), ...await queue.getDelayed()];
        return jobs.some(job => {
            const data = job?.data as Partial<CommentJobData> | undefined;
            return job?.name === 'processPullRequestComment'
                && data?.pullRequestNumber === ref.pullRequestNumber && data?.repoOwner === ref.repoOwner && data?.repoName === ref.repoName;
        });
    } catch {
        return false;
    }
}
