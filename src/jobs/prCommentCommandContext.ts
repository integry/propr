import type { Logger } from 'pino';
import type { CommentJobData, UnprocessedComment } from '@propr/core';

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
