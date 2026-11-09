import { safeUpdateLabels, type IssueJobData } from '@propr/core';
import type { Logger } from 'pino';

/** The trigger and processing labels a completion releases. */
export function releasedTriggerLabels(triggeringLabel: string | undefined, processingTag: string): string[] {
    // Context derives these tags from PRIMARY_PROCESSING_LABELS when old jobs lack triggeringLabel.
    return [triggeringLabel ?? processingTag.replace(/-processing$/, ''), processingTag];
}

interface CompletionLabelOptions {
    octokit: Parameters<typeof safeUpdateLabels>[0]['octokit'];
    issueRef: IssueJobData;
    AI_PROCESSING_TAG: string;
    AI_DONE_TAG: string;
    correlatedLogger: Logger;
}

export interface CompletionLabelResult {
    /** The done marker is on the issue. */
    published: boolean;
    /** The trigger and processing labels are off the issue. */
    released: boolean;
    errors: string[];
}

async function updateCompletionLabels({
    octokit, issueRef, AI_PROCESSING_TAG, AI_DONE_TAG, correlatedLogger,
}: CompletionLabelOptions, releaseUnpublished: boolean): Promise<CompletionLabelResult> {
    const context = { octokit, owner: issueRef.repoOwner, repo: issueRef.repoName,
        issueNumber: issueRef.number, logger: correlatedLogger };
    const completed = await safeUpdateLabels(context, [], [AI_DONE_TAG]);
    if (!completed.success) {
        // Without the marker the trigger is the only record of the request; keep it.
        if (releaseUnpublished) await safeUpdateLabels(context, [AI_PROCESSING_TAG], []);
        return { published: false, released: false, errors: completed.errors };
    }
    const released = await safeUpdateLabels(context, releasedTriggerLabels(issueRef.triggeringLabel, AI_PROCESSING_TAG), []);
    return { published: true, released: released.success, errors: released.errors };
}

/**
 * Publish completion before releasing the trigger that admitted this job, and
 * throw when either step fails. Only callers holding a retained obligation that
 * a later job replays may use this: the throw leaves that obligation owed.
 */
export async function completeIssueLabels(options: CompletionLabelOptions): Promise<void> {
    const result = await updateCompletionLabels(options, false);
    if (result.errors.length) throw new Error(result.errors.join('; '));
}

/**
 * Publish completion for a run whose work is already published (a pull request
 * exists, or the failure comment still has to be posted). A failed label
 * mutation is logged and the caller continues: the epic handoff removes a
 * leftover trigger once the done marker is present, and reconcile retries it.
 */
export async function completeIssueLabelsBestEffort(options: CompletionLabelOptions): Promise<CompletionLabelResult> {
    const result = await updateCompletionLabels(options, true);
    if (result.errors.length) {
        options.correlatedLogger.warn({
            issueNumber: options.issueRef.number, published: result.published, errors: result.errors,
            leftoverLabels: result.published ? releasedTriggerLabels(options.issueRef.triggeringLabel, options.AI_PROCESSING_TAG) : [options.AI_PROCESSING_TAG],
        }, result.published
            ? 'Published completion but could not release the trigger labels; continuing post-processing'
            : 'Could not publish the completion label; continuing post-processing');
    }
    return result;
}
