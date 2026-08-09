import type { Logger } from 'pino';
import type { CommentJobData, UnprocessedComment } from '@propr/core';

function inferQueuedCommandOrder(jobData: CommentJobData): { sequence?: number; commentId?: number } {
    if (jobData.commandCommentId !== undefined || jobData.commandSequence !== undefined) {
        return { sequence: jobData.commandSequence, commentId: jobData.commandCommentId };
    }
    if (!jobData.commandMode || jobData.commandMode === 'default') return {};
    const commentIds = jobData.comments?.map(comment => comment.id)
        ?? (jobData.commentId === undefined ? [] : [jobData.commentId]);
    return { commentId: commentIds.length > 0 ? Math.max(...commentIds) : undefined };
}

function commandIsNewer(
    comment: UnprocessedComment,
    queuedOrder: { sequence?: number; commentId?: number },
): boolean {
    if (comment.commandSequence !== undefined) {
        return queuedOrder.sequence === undefined || comment.commandSequence > queuedOrder.sequence;
    }
    if (queuedOrder.sequence !== undefined) return false;
    return queuedOrder.commentId === undefined || comment.id > queuedOrder.commentId;
}

function compareCommandOrder(left: UnprocessedComment, right: UnprocessedComment): number {
    if (left.commandSequence !== undefined && right.commandSequence !== undefined) {
        return left.commandSequence - right.commandSequence;
    }
    if (left.commandSequence !== undefined) return 1;
    if (right.commandSequence !== undefined) return -1;
    return left.id - right.id;
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
    jobData.commandSequence = comment.commandSequence;
}

export function applyPendingCommentCommandContext(jobData: CommentJobData, commentsToProcess: UnprocessedComment[], correlatedLogger: Logger): void {
    const queuedOrder = inferQueuedCommandOrder(jobData);
    const newerCommands = commentsToProcess
        .filter(comment => !!comment.commandMode
            && comment.commandMode !== 'default'
            && commandIsNewer(comment, queuedOrder))
        .sort(compareCommandOrder);
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
        queuedCommandCommentId: queuedOrder.commentId,
        queuedCommandSequence: queuedOrder.sequence,
        overrideCommentId: latestOverrideComment?.id,
    }, 'Applied command context from pending batched comment');
}
