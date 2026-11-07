import { safeUpdateLabels, type IssueJobData } from '@propr/core';
import type { Logger } from 'pino';

/** The trigger and processing labels a completion releases. */
export function releasedTriggerLabels(triggeringLabel: string | undefined, processingTag: string): string[] {
    // Context derives these tags from PRIMARY_PROCESSING_LABELS when old jobs lack triggeringLabel.
    return [triggeringLabel ?? processingTag.replace(/-processing$/, ''), processingTag];
}

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
    const completed = await safeUpdateLabels(context, [], [AI_DONE_TAG]);
    if (!completed.success) throw new Error(completed.errors.join('; '));
    const released = await safeUpdateLabels(context, releasedTriggerLabels(issueRef.triggeringLabel, AI_PROCESSING_TAG), []);
    if (!released.success) throw new Error(released.errors.join('; '));
}
