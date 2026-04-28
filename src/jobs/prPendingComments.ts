import type { Logger } from 'pino';
import type { CommentJobData, UnprocessedComment } from '@propr/core';
import { getPendingPrCommentsKey } from '@propr/core';
import type { Redis } from 'ioredis';

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

export function applyPendingCommentCommandContext(jobData: CommentJobData, commentsToProcess: UnprocessedComment[], correlatedLogger: Logger): void {
    const latestCommandComment = [...commentsToProcess]
        .reverse()
        .find(comment => comment.commandMode && comment.commandMode !== 'default');
    const latestOverrideComment = [...commentsToProcess]
        .reverse()
        .find(comment => comment.llmOverride !== undefined);

    if (!latestCommandComment && !latestOverrideComment) return;

    if (latestCommandComment) {
        jobData.commandMeta = latestCommandComment.commandMeta;
        jobData.commandMode = latestCommandComment.commandMode;
        jobData.requestedModels = latestCommandComment.requestedModels;
        jobData.commandInstructions = latestCommandComment.commandInstructions;
    }

    if (latestOverrideComment?.llmOverride !== undefined) {
        jobData.llm = latestOverrideComment.llmOverride;
    }

    correlatedLogger.info({
        commandMode: jobData.commandMode,
        requestedModels: jobData.requestedModels,
        llmOverride: latestOverrideComment?.llmOverride,
        commandCommentId: latestCommandComment?.id,
        overrideCommentId: latestOverrideComment?.id,
    }, 'Applied command context from pending batched comment');
}

export async function pickUpPendingComments(commentsToProcess: UnprocessedComment[], options: { repoOwner: string; repoName: string; pullRequestNumber: number; correlatedLogger: Logger; redisClient: Redis }): Promise<UnprocessedComment[]> {
    const { repoOwner, repoName, pullRequestNumber, correlatedLogger, redisClient } = options;
    const pendingCommentsKey = getPendingPrCommentsKey(repoOwner, repoName, pullRequestNumber);
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
    return commentsToProcess;
}
