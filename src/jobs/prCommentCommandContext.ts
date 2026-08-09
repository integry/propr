import type { Logger } from 'pino';
import type { CommentJobData, UnprocessedComment } from '@propr/core';

function inferQueuedCommandCommentId(jobData: CommentJobData): number | undefined {
    if (jobData.commandCommentId !== undefined) return jobData.commandCommentId;
    if (!jobData.commandMode || jobData.commandMode === 'default') return undefined;
    const commentIds = jobData.comments?.map(comment => comment.id)
        ?? (jobData.commentId === undefined ? [] : [jobData.commentId]);
    return commentIds.length > 0 ? Math.max(...commentIds) : undefined;
}

function applyLatestCommand(jobData: CommentJobData, comment: UnprocessedComment): void {
    const isModelModifier = comment.commandMode === 'use' || comment.commandMode === 'switch';
    const preservesConcreteAction = isModelModifier
        && (jobData.commandMode === 'fix' || jobData.commandMode === 'review');
    if (!preservesConcreteAction) {
        jobData.commandMeta = comment.commandMeta;
        jobData.commandMode = comment.commandMode;
        jobData.requestedModels = comment.requestedModels;
        jobData.commandInstructions = comment.commandInstructions;
        jobData.ultrafixMeta = comment.ultrafixMeta;
    } else {
        const modifierModels = comment.requestedModels?.length
            ? comment.requestedModels
            : comment.llmOverride ? [comment.llmOverride] : undefined;
        if (modifierModels) jobData.requestedModels = modifierModels;
    }
    if (comment.llmOverride !== undefined) jobData.llm = comment.llmOverride;
    jobData.commandCommentId = comment.id;
}

export function applyPendingCommentCommandContext(jobData: CommentJobData, commentsToProcess: UnprocessedComment[], correlatedLogger: Logger): void {
    const queuedCommandCommentId = inferQueuedCommandCommentId(jobData);
    const newerCommands = commentsToProcess
        .filter(comment => !!comment.commandMode
            && comment.commandMode !== 'default'
            && (queuedCommandCommentId === undefined || comment.id > queuedCommandCommentId))
        .sort((left, right) => left.id - right.id);
    if (newerCommands.length === 0) return;

    for (const comment of newerCommands) applyLatestCommand(jobData, comment);

    const latestCommandComment = newerCommands.at(-1)!;
    const latestOverrideComment = [...newerCommands].reverse().find(
        comment => comment.llmOverride !== undefined,
    );
    if (
        jobData.commandMode === 'review'
        && !jobData.requestedModels?.length
        && latestOverrideComment?.llmOverride
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
