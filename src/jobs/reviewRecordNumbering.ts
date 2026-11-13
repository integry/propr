/**
 * Next PR-wide record numbers implied by previously published review comments.
 */

import { highestReviewRecordNumber, parseStructuredReview, type StructuredReviewResult } from './reviewOutputParser.js';

function getNextRecordNumber(
    reviewBodies: readonly (string | null | undefined)[],
    pickRecords: (review: StructuredReviewResult) => readonly { id: string }[],
): number {
    let highest = 0;
    for (const body of reviewBodies) {
        if (!body) continue;
        highest = Math.max(highest, highestReviewRecordNumber(pickRecords(parseStructuredReview(body))));
    }
    return highest + 1;
}

export function getNextActionableFindingNumber(reviewBodies: readonly (string | null | undefined)[]): number {
    return getNextRecordNumber(reviewBodies, review => review.actionableFindings);
}

/**
 * S# counterpart of `getNextActionableFindingNumber`. Suggestions carry the same
 * permanent-identifier guarantee as blockers, so `/fix S5` names one record for
 * the life of the pull request instead of a different one per review comment.
 */
export function getNextReviewSuggestionNumber(reviewBodies: readonly (string | null | undefined)[]): number {
    return getNextRecordNumber(reviewBodies, review => review.suggestions);
}
