import type { CommentJobData } from '@propr/core';
import { buildWorkNotificationRecap, fullNotificationSummary } from './notificationRecap.js';
import { selectedReviewFeedbackIds } from './reviewFindingSelector.js';
import type { AIReviewComment } from './reviewCommentGatherer.js';

/**
 * Work summary fields of a published follow-up's completed-state history entry:
 * the notification recap and summary, the review comments the run consumed, and
 * the findings and suggestions it addressed, so the task history distinguishes
 * required corrections from optional follow-ups.
 */
export function followUpWorkHistoryMetadata(
    jobData: CommentJobData,
    completion: { commitResult: { filesChanged?: string[] } | null; changesSummary: string },
    partial: boolean,
    reviewComments: AIReviewComment[],
): Record<string, unknown> {
    const { commitResult, changesSummary } = completion;
    const addressed = selectedReviewFeedbackIds(reviewComments);
    return {
        notificationRecap: buildWorkNotificationRecap(changesSummary, {
            commandMode: jobData.commandMode || 'default',
            filesChanged: commitResult?.filesChanged?.length,
            noChanges: !commitResult,
            partial,
        }),
        notificationSummary: fullNotificationSummary(changesSummary),
        ...(reviewComments.length > 0 && { consumedReviewCommentIds: reviewComments.map(comment => comment.id) }),
        ...(addressed.findingIds.length > 0 && { addressedFindingIds: addressed.findingIds }),
        ...(addressed.suggestionIds.length > 0 && { addressedSuggestionIds: addressed.suggestionIds }),
    };
}
