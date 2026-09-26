import type { AnalysisResult } from '@propr/core';
import type { Redis } from 'ioredis';
import type { ReviewAssignment } from './prReviewRunner.js';
import { buildReviewComment, buildReviewErrorComment } from './reviewCommentFormatter.js';
import { parseStructuredReview } from './reviewOutputParser.js';

type ReviewRenderOptions = NonNullable<Parameters<typeof buildReviewComment>[3]>;
type ReviewIssueRef = { repoOwner: string; repoName: string; pullRequestNumber: number };
interface ReservedFindingRenderOptions extends Omit<ReviewRenderOptions, 'firstFindingNumber'> {
    redisClient: Pick<Redis, 'eval'>;
    issueRef: ReviewIssueRef;
    observedNextFindingNumber: number;
}

const RESERVE_FINDING_RANGE_SCRIPT = `
local observedHighest = tonumber(ARGV[1])
local rangeSize = tonumber(ARGV[2])
local reservedHighest = tonumber(redis.call('get', KEYS[1]))

if reservedHighest == nil or reservedHighest < observedHighest then
    reservedHighest = observedHighest
end

local firstFindingNumber = reservedHighest + 1
redis.call('set', KEYS[1], reservedHighest + rangeSize)
return firstFindingNumber
`;

export async function reserveActionableFindingRange(
    redisClient: Pick<Redis, 'eval'>,
    issueRef: ReviewIssueRef,
    observedNextFindingNumber: number,
    findingCount: number,
): Promise<number> {
    if (!Number.isSafeInteger(observedNextFindingNumber) || observedNextFindingNumber < 1) {
        throw new Error(`Invalid observed finding number: ${observedNextFindingNumber}`);
    }
    if (!Number.isSafeInteger(findingCount) || findingCount < 1) {
        throw new Error(`Invalid finding range size: ${findingCount}`);
    }

    const sequenceKey = [
        'review-finding-sequence',
        issueRef.repoOwner.toLowerCase(),
        issueRef.repoName.toLowerCase(),
        issueRef.pullRequestNumber,
    ].join(':');
    const reservedStart = Number(await redisClient.eval(
        RESERVE_FINDING_RANGE_SCRIPT,
        1,
        sequenceKey,
        observedNextFindingNumber - 1,
        findingCount,
    ));
    if (!Number.isSafeInteger(reservedStart) || reservedStart < 1) {
        throw new Error(`Failed to reserve actionable finding range for ${sequenceKey}`);
    }
    return reservedStart;
}

export async function buildReviewCommentWithReservedFindingRange(
    assignment: ReviewAssignment,
    analysisResult: AnalysisResult,
    taskUrl: string | undefined,
    options: ReservedFindingRenderOptions,
): Promise<{ reviewCommentBody: string; findingCount: number }> {
    if (!analysisResult.success) {
        return {
            reviewCommentBody: buildReviewErrorComment(
                assignment.label,
                assignment.model,
                analysisResult.error || 'Unknown error',
            ),
            findingCount: 0,
        };
    }

    const { redisClient, issueRef, observedNextFindingNumber, ...renderOptions } = options;
    const renderComment = (firstFindingNumber: number): string => buildReviewComment(
        assignment,
        analysisResult,
        taskUrl,
        { ...renderOptions, firstFindingNumber },
    );
    const provisionalCommentBody = renderComment(observedNextFindingNumber);
    const findingCount = parseStructuredReview(provisionalCommentBody).actionableFindings.length;
    if (findingCount === 0) {
        return { reviewCommentBody: provisionalCommentBody, findingCount };
    }

    // The public-comment maximum is a recovery floor; Redis serializes all
    // reservations made from the same (possibly stale) GitHub snapshot.
    const reservedStart = await reserveActionableFindingRange(
        redisClient,
        issueRef,
        observedNextFindingNumber,
        findingCount,
    );
    return {
        reviewCommentBody: reservedStart === observedNextFindingNumber
            ? provisionalCommentBody
            : renderComment(reservedStart),
        findingCount,
    };
}
