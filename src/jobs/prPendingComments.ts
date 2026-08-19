import type { Logger } from 'pino';
import type { UnprocessedComment } from '@propr/core';
import {
    dedupeUnprocessedComments,
    getPendingPrCommentsKey,
    getUnprocessedCommentIdentity,
    restorePendingCommentsIdempotently,
} from '@propr/core';
import type { Redis } from 'ioredis';

export { applyPendingCommentCommandContext } from './prCommentCommandContext.js';

export function parsePendingComment(commentJson: string, correlatedLogger: Logger): UnprocessedComment | null {
    try {
        return JSON.parse(commentJson) as UnprocessedComment;
    } catch (parseError) {
        correlatedLogger.warn({ error: (parseError as Error).message }, 'Failed to parse pending comment');
        return null;
    }
}

export function processPendingComments(commentsToProcess: UnprocessedComment[], pendingComments: string[], correlatedLogger: Logger): void {
    const seen = new Set(commentsToProcess.map(getUnprocessedCommentIdentity));
    for (const commentJson of pendingComments) {
        const pendingComment = parsePendingComment(commentJson, correlatedLogger);
        if (pendingComment && !seen.has(getUnprocessedCommentIdentity(pendingComment))) {
            commentsToProcess.push(pendingComment);
            seen.add(getUnprocessedCommentIdentity(pendingComment));
        }
    }
}

export interface PendingCommentPickup {
    commentsToProcess: UnprocessedComment[];
    pickedUpComments: UnprocessedComment[];
}

const CLAIM_PENDING_COMMENTS_SCRIPT = `
if redis.call('EXISTS', KEYS[2]) == 1 then
    return redis.call('LRANGE', KEYS[2], 0, -1)
end
local pending = redis.call('LRANGE', KEYS[1], 0, -1)
if #pending > 0 then
    redis.call('DEL', KEYS[1])
    for _, value in ipairs(pending) do redis.call('RPUSH', KEYS[2], value) end
    redis.call('EXPIRE', KEYS[2], 86400)
end
return pending
`;

function pendingCommentClaimKey(pendingCommentsKey: string, claimId: string): string {
    return `${pendingCommentsKey}:claim:${claimId}`;
}

export async function acknowledgePendingCommentClaim(
    options: { repoOwner: string; repoName: string; pullRequestNumber: number; claimId: string; redisClient: Redis },
): Promise<void> {
    const pendingCommentsKey = getPendingPrCommentsKey(options.repoOwner, options.repoName, options.pullRequestNumber);
    await options.redisClient.del(pendingCommentClaimKey(pendingCommentsKey, options.claimId));
}

export async function pickUpPendingCommentsWithClaim(commentsToProcess: UnprocessedComment[], options: { repoOwner: string; repoName: string; pullRequestNumber: number; correlatedLogger: Logger; redisClient: Redis; claimId?: string }): Promise<PendingCommentPickup> {
    const { repoOwner, repoName, pullRequestNumber, correlatedLogger, redisClient, claimId } = options;
    const pendingCommentsKey = getPendingPrCommentsKey(repoOwner, repoName, pullRequestNumber);
    const originalCommentIds = new Set(commentsToProcess.map(getUnprocessedCommentIdentity));
    try {
        const pendingComments = claimId
            ? await redisClient.eval(
                CLAIM_PENDING_COMMENTS_SCRIPT,
                2,
                pendingCommentsKey,
                pendingCommentClaimKey(pendingCommentsKey, claimId),
            ) as string[]
            : await redisClient.lrange(pendingCommentsKey, 0, -1);
        if (pendingComments.length > 0) {
            if (!claimId) await redisClient.del(pendingCommentsKey);
            processPendingComments(commentsToProcess, pendingComments, correlatedLogger);
            correlatedLogger.info({ pullRequestNumber, pendingCount: pendingComments.length, totalCount: commentsToProcess.length }, 'Picked up pending comments from Redis');
        }
    } catch (redisError) {
        correlatedLogger.warn({ error: (redisError as Error).message }, 'Failed to fetch pending comments from Redis');
    }
    return {
        commentsToProcess: dedupeUnprocessedComments(commentsToProcess),
        pickedUpComments: commentsToProcess.filter(comment => !originalCommentIds.has(getUnprocessedCommentIdentity(comment))),
    };
}

export async function pickUpPendingComments(commentsToProcess: UnprocessedComment[], options: { repoOwner: string; repoName: string; pullRequestNumber: number; correlatedLogger: Logger; redisClient: Redis }): Promise<UnprocessedComment[]> {
    return (await pickUpPendingCommentsWithClaim(commentsToProcess, options)).commentsToProcess;
}

/** Return comments claimed by a cancelled job to the head of the shared pending list. */
export async function restorePendingComments(comments: UnprocessedComment[], options: { repoOwner: string; repoName: string; pullRequestNumber: number; redisClient: Redis }): Promise<void> {
    const { repoOwner, repoName, pullRequestNumber, redisClient } = options;
    const pendingCommentsKey = getPendingPrCommentsKey(repoOwner, repoName, pullRequestNumber);
    await restorePendingCommentsIdempotently(redisClient, pendingCommentsKey, comments);
}

/** Restore a stale provider retry and clear its routing before cleanup queues a successor. */
export async function restoreSupersededProviderLimitComments(
    context: { commentsToProcess: UnprocessedComment[]; llm: string | null | undefined; agentAlias?: string; modelName?: string; modelLabel?: string },
    options: { repoOwner: string; repoName: string; pullRequestNumber: number; redisClient: Redis },
): Promise<void> {
    await restorePendingComments(context.commentsToProcess, options);
    context.llm = null;
    context.agentAlias = undefined;
    context.modelName = undefined;
    context.modelLabel = undefined;
}
