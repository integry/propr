import { safeUpdateLabels, type IssueJobData } from '@propr/core';
import type { Logger } from 'pino';

/** Publish completion before releasing the trigger that admitted this job. */
export async function completeIssueLabels({
    octokit, issueRef, AI_PROCESSING_TAG, AI_DONE_TAG, correlatedLogger,
}: {
    octokit: Parameters<typeof safeUpdateLabels>[0]['octokit'];
    issueRef: IssueJobData;
    AI_PROCESSING_TAG: string;
    AI_DONE_TAG: string;
    correlatedLogger: Logger;
}): Promise<void> {
    const context = { octokit, owner: issueRef.repoOwner, repo: issueRef.repoName,
        issueNumber: issueRef.number, logger: correlatedLogger };
    // Context derives these tags from PRIMARY_PROCESSING_LABELS when old jobs lack triggeringLabel.
    const primaryLabel = issueRef.triggeringLabel ?? AI_PROCESSING_TAG.replace(/-processing$/, '');
    const completed = await safeUpdateLabels(context, [], [AI_DONE_TAG]);
    if (!completed.success) throw new Error(completed.errors.join('; '));
    const released = await safeUpdateLabels(context, [primaryLabel, AI_PROCESSING_TAG], []);
    if (!released.success) throw new Error(released.errors.join('; '));
}
