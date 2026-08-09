import type { Logger } from 'pino';
import type { CommentJobData, UnprocessedComment } from '@propr/core';

function findLatestComment(
    comments: UnprocessedComment[],
    predicate: (comment: UnprocessedComment) => boolean,
): UnprocessedComment | undefined {
    return comments.reduce<UnprocessedComment | undefined>((latest, comment) => {
        if (!predicate(comment)) return latest;
        return !latest || comment.id > latest.id ? comment : latest;
    }, undefined);
}

function inferQueuedCommandCommentId(jobData: CommentJobData): number | undefined {
    if (jobData.commandCommentId !== undefined) return jobData.commandCommentId;
    if (!jobData.commandMode || jobData.commandMode === 'default') return undefined;
    const commentIds = jobData.comments?.map(comment => comment.id)
        ?? (jobData.commentId === undefined ? [] : [jobData.commentId]);
    return commentIds.length > 0 ? Math.max(...commentIds) : undefined;
}

export function applyPendingCommentCommandContext(jobData: CommentJobData, commentsToProcess: UnprocessedComment[], correlatedLogger: Logger): void {
    const queuedCommandCommentId = inferQueuedCommandCommentId(jobData);
    const latestCommandComment = findLatestComment(commentsToProcess, comment =>
        !!comment.commandMode
        && comment.commandMode !== 'default'
        && (queuedCommandCommentId === undefined || comment.id > queuedCommandCommentId));
    const latestOverrideComment = findLatestComment(
        commentsToProcess, comment => comment.llmOverride !== undefined,
    );

    if (!latestCommandComment && !latestOverrideComment) return;

    if (latestCommandComment) {
        jobData.commandMeta = latestCommandComment.commandMeta;
        jobData.commandMode = latestCommandComment.commandMode;
        jobData.requestedModels = latestCommandComment.requestedModels;
        jobData.commandInstructions = latestCommandComment.commandInstructions;
        jobData.commandCommentId = latestCommandComment.id;
        jobData.ultrafixMeta = latestCommandComment.ultrafixMeta;
    }

    if (latestOverrideComment?.llmOverride !== undefined) {
        jobData.llm = latestOverrideComment.llmOverride;
    }
    if (
        latestCommandComment?.commandMode === 'review'
        && !latestCommandComment.requestedModels?.length
        && latestOverrideComment?.commandMode === 'use'
        && latestOverrideComment.llmOverride
    ) {
        jobData.requestedModels = [latestOverrideComment.llmOverride];
    }

    correlatedLogger.info({
        commandMode: jobData.commandMode,
        requestedModels: jobData.requestedModels,
        llmOverride: latestOverrideComment?.llmOverride,
        commandCommentId: latestCommandComment?.id,
        queuedCommandCommentId,
        overrideCommentId: latestOverrideComment?.id,
    }, 'Applied command context from pending batched comment');
}
