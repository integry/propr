import type { Logger } from 'pino';
import type { UnprocessedComment } from '@propr/core';
import { getPendingPrCommentsKey } from '@propr/core';
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
    for (const commentJson of pendingComments) {
        const pendingComment = parsePendingComment(commentJson, correlatedLogger);
        if (pendingComment && !commentsToProcess.some(c => c.id === pendingComment.id)) {
            commentsToProcess.push(pendingComment);
        }
    }
}

export interface PendingCommentPickup {
    commentsToProcess: UnprocessedComment[];
    pickedUpComments: UnprocessedComment[];
}

export async function pickUpPendingCommentsWithClaim(commentsToProcess: UnprocessedComment[], options: { repoOwner: string; repoName: string; pullRequestNumber: number; correlatedLogger: Logger; redisClient: Redis }): Promise<PendingCommentPickup> {
    const { repoOwner, repoName, pullRequestNumber, correlatedLogger, redisClient } = options;
    const pendingCommentsKey = getPendingPrCommentsKey(repoOwner, repoName, pullRequestNumber);
    const originalCommentIds = new Set(commentsToProcess.map(comment => comment.id));
    try {
        const pendingComments = await redisClient.lrange(pendingCommentsKey, 0, -1);
        if (pendingComments.length > 0) {
            await redisClient.del(pendingCommentsKey);
            processPendingComments(commentsToProcess, pendingComments, correlatedLogger);
            correlatedLogger.info({ pullRequestNumber, pendingCount: pendingComments.length, totalCount: commentsToProcess.length }, 'Picked up pending comments from Redis');
        }
    } catch (redisError) {
        correlatedLogger.warn({ error: (redisError as Error).message }, 'Failed to fetch pending comments from Redis');
    }
    return {
        commentsToProcess,
        pickedUpComments: commentsToProcess.filter(comment => !originalCommentIds.has(comment.id)),
    };
}

export async function pickUpPendingComments(commentsToProcess: UnprocessedComment[], options: { repoOwner: string; repoName: string; pullRequestNumber: number; correlatedLogger: Logger; redisClient: Redis }): Promise<UnprocessedComment[]> {
    return (await pickUpPendingCommentsWithClaim(commentsToProcess, options)).commentsToProcess;
}

/** Return comments claimed by a cancelled job to the head of the shared pending list. */
export async function restorePendingComments(comments: UnprocessedComment[], options: { repoOwner: string; repoName: string; pullRequestNumber: number; redisClient: Redis }): Promise<void> {
    if (comments.length === 0) return;
    const { repoOwner, repoName, pullRequestNumber, redisClient } = options;
    const pendingCommentsKey = getPendingPrCommentsKey(repoOwner, repoName, pullRequestNumber);
    const serializedComments = comments.map(comment => JSON.stringify(comment)).reverse();
    await redisClient.lpush(pendingCommentsKey, ...serializedComments);
    await redisClient.expire(pendingCommentsKey, 3600);
}
