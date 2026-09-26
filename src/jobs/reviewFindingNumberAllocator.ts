import type { AnalysisResult } from '@propr/core';
import type { Redis } from 'ioredis';
import type { ReviewAssignment } from './prReviewRunner.js';
import { buildReviewComment, buildReviewErrorComment } from './reviewCommentFormatter.js';
import { parseStructuredReview } from './reviewOutputParser.js';

type ReviewRenderOptions = NonNullable<Parameters<typeof buildReviewComment>[3]>;
type ReviewIssueRef = { repoOwner: string; repoName: string; pullRequestNumber: number };

/** The two independently numbered kinds of record a review publishes. */
export type ReviewRecordKind = 'finding' | 'suggestion';

const RECORD_SEQUENCE_KEY_PREFIX: Record<ReviewRecordKind, string> = {
    finding: 'review-finding-sequence',
    suggestion: 'review-suggestion-sequence',
};

interface ReservedRecordRenderOptions extends Omit<ReviewRenderOptions, 'firstFindingNumber' | 'firstSuggestionNumber'> {
    redisClient: Pick<Redis, 'eval'>;
    issueRef: ReviewIssueRef;
    observedNextFindingNumber: number;
    observedNextSuggestionNumber: number;
}

const RESERVE_RECORD_RANGE_SCRIPT = `
local observedHighest = tonumber(ARGV[1])
local rangeSize = tonumber(ARGV[2])
local reservedHighest = tonumber(redis.call('get', KEYS[1]))

if reservedHighest == nil or reservedHighest < observedHighest then
    reservedHighest = observedHighest
end

local firstRecordNumber = reservedHighest + 1
redis.call('set', KEYS[1], reservedHighest + rangeSize)
return firstRecordNumber
`;

/**
 * Reserve a contiguous block of PR-wide identifiers for one record kind. F# and
 * S# use separate sequences: sharing one would leave gaps in both and make a
 * suggestion's number depend on how many blockers happened to be found.
 */
export async function reserveReviewRecordRange(
    redisClient: Pick<Redis, 'eval'>,
    issueRef: ReviewIssueRef,
    range: { kind: ReviewRecordKind; observedNextNumber: number; recordCount: number },
): Promise<number> {
    const { kind, observedNextNumber, recordCount } = range;
    if (!Number.isSafeInteger(observedNextNumber) || observedNextNumber < 1) {
        throw new Error(`Invalid observed ${kind} number: ${observedNextNumber}`);
    }
    if (!Number.isSafeInteger(recordCount) || recordCount < 1) {
        throw new Error(`Invalid ${kind} range size: ${recordCount}`);
    }

    const sequenceKey = [
        RECORD_SEQUENCE_KEY_PREFIX[kind],
        issueRef.repoOwner.toLowerCase(),
        issueRef.repoName.toLowerCase(),
        issueRef.pullRequestNumber,
    ].join(':');
    const reservedStart = Number(await redisClient.eval(
        RESERVE_RECORD_RANGE_SCRIPT,
        1,
        sequenceKey,
        observedNextNumber - 1,
        recordCount,
    ));
    if (!Number.isSafeInteger(reservedStart) || reservedStart < 1) {
        throw new Error(`Failed to reserve ${kind} range for ${sequenceKey}`);
    }
    return reservedStart;
}

export async function buildReviewCommentWithReservedRecordRanges(
    assignment: ReviewAssignment,
    analysisResult: AnalysisResult,
    taskUrl: string | undefined,
    options: ReservedRecordRenderOptions,
): Promise<{ reviewCommentBody: string; findingCount: number; suggestionCount: number }> {
    if (!analysisResult.success) {
        return {
            reviewCommentBody: buildReviewErrorComment(
                assignment.label,
                assignment.model,
                analysisResult.error || 'Unknown error',
            ),
            findingCount: 0,
            suggestionCount: 0,
        };
    }

    const {
        redisClient, issueRef, observedNextFindingNumber, observedNextSuggestionNumber, ...renderOptions
    } = options;
    const renderComment = (firstFindingNumber: number, firstSuggestionNumber: number): string => buildReviewComment(
        assignment,
        analysisResult,
        taskUrl,
        { ...renderOptions, firstFindingNumber, firstSuggestionNumber },
    );
    const provisionalCommentBody = renderComment(observedNextFindingNumber, observedNextSuggestionNumber);
    const provisionalReview = parseStructuredReview(provisionalCommentBody);
    const findingCount = provisionalReview.actionableFindings.length;
    const suggestionCount = provisionalReview.suggestions.length;
    if (findingCount === 0 && suggestionCount === 0) {
        return { reviewCommentBody: provisionalCommentBody, findingCount, suggestionCount };
    }

    // The public-comment maximum is a recovery floor; Redis serializes all
    // reservations made from the same (possibly stale) GitHub snapshot.
    const [reservedFindingStart, reservedSuggestionStart] = await Promise.all([
        findingCount === 0
            ? observedNextFindingNumber
            : reserveReviewRecordRange(redisClient, issueRef, {
                kind: 'finding', observedNextNumber: observedNextFindingNumber, recordCount: findingCount,
            }),
        suggestionCount === 0
            ? observedNextSuggestionNumber
            : reserveReviewRecordRange(redisClient, issueRef, {
                kind: 'suggestion', observedNextNumber: observedNextSuggestionNumber, recordCount: suggestionCount,
            }),
    ]);
    const keepsProvisionalNumbers = reservedFindingStart === observedNextFindingNumber
        && reservedSuggestionStart === observedNextSuggestionNumber;
    return {
        reviewCommentBody: keepsProvisionalNumbers
            ? provisionalCommentBody
            : renderComment(reservedFindingStart, reservedSuggestionStart),
        findingCount,
        suggestionCount,
    };
}
