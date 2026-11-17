import { getModelName } from '@propr/core';
import type { ReviewResult } from './prReviewRunner.js';
import { isReviewErrorComment } from './reviewCommentFormatter.js';

type CountedReview = Pick<ReviewResult, 'analysisResult' | 'commentBody'>;

/**
 * A review counts as posted only when the reviewer succeeded and its comment
 * shows a review. Output that could not be published is posted as an error
 * review, which is a failure here even though the provider call succeeded.
 */
export function isPostedReview(result: CountedReview): boolean {
    return result.analysisResult.success && !(result.commentBody && isReviewErrorComment(result.commentBody));
}

export function countReviewOutcomes(results: readonly CountedReview[]): { posted: number; failed: number } {
    const posted = results.filter(isPostedReview).length;
    return { posted, failed: results.length - posted };
}

const reviews = (count: number) => `${count} review${count === 1 ? '' : 's'}`;

/** The body the "starting review" comment is updated to once every reviewer has finished. */
export function buildReviewCompletionCommentBody(
    reviewResults: readonly Pick<ReviewResult, 'analysisResult' | 'commentBody' | 'commentUrl' | 'assignment'>[],
    options: { authorsText: string; taskUrl: string; evidence?: string },
): string {
    const { posted, failed } = countReviewOutcomes(reviewResults);
    const statusEmoji = failed === 0 ? '✅' : '⚠️';
    const statusText = failed === 0 ? `Posted ${reviews(posted)}` : `Posted ${reviews(posted)}, ${failed} failed`;
    const reviewLinks = reviewResults.filter(result => result.commentUrl)
        .map(result => `- [${getModelName(result.assignment.model)}](${result.commentUrl})${isPostedReview(result) ? '' : ' (failed)'}`)
        .join('\n');
    return `${statusEmoji} **AI Code Review Complete** requested by ${options.authorsText}\n\n${statusText}:\n${reviewLinks}\n\n[View Task Details](${options.taskUrl})${options.evidence ? `\n${options.evidence}` : ''}`;
}
