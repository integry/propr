import type { Logger } from 'pino';
import type { CommentJobData, UnprocessedComment } from '@propr/core';

interface CommentChronology {
    id: number;
    createdAt?: string;
    type?: UnprocessedComment['type'];
}

interface ModelOverride extends CommentChronology {
    commandMode?: UnprocessedComment['commandMode'];
    llmOverride?: string | null;
}

interface PendingCommandContext {
    queuedCommandChronology?: CommentChronology;
    latestCommandComment?: UnprocessedComment;
    latestPendingOverrideComment?: UnprocessedComment;
}

function compareCommentChronology(left: CommentChronology, right: CommentChronology): number {
    if (left.createdAt !== undefined && right.createdAt !== undefined) {
        const createdAtOrder = left.createdAt.localeCompare(right.createdAt);
        if (createdAtOrder !== 0) return createdAtOrder;

        if (left.type !== right.type) {
            if (left.type === undefined) return -1;
            if (right.type === undefined) return 1;
            return left.type === 'issue' ? -1 : 1;
        }
    }

    return left.id - right.id;
}

function findLatestComment(
    comments: UnprocessedComment[],
    predicate: (comment: UnprocessedComment) => boolean,
): UnprocessedComment | undefined {
    return comments.reduce<UnprocessedComment | undefined>((latest, comment) => {
        if (!predicate(comment)) return latest;
        return !latest || compareCommentChronology(comment, latest) > 0 ? comment : latest;
    }, undefined);
}

function inferQueuedCommandChronology(jobData: CommentJobData): CommentChronology | undefined {
    if (!jobData.commandMode || jobData.commandMode === 'default') return undefined;

    if (jobData.commandCommentId !== undefined) {
        const ownerComment = jobData.comments?.find(comment =>
            comment.id === jobData.commandCommentId
            && (jobData.commandCommentType === undefined || comment.type === jobData.commandCommentType));
        return {
            id: jobData.commandCommentId,
            createdAt: jobData.commandCommentCreatedAt ?? ownerComment?.createdAt,
            type: jobData.commandCommentType ?? ownerComment?.type,
        };
    }

    const queuedComments = jobData.comments
        ?? (jobData.commentId === undefined
            ? []
            : [{ id: jobData.commentId }]);
    return queuedComments.reduce<CommentChronology | undefined>((latest, comment) =>
        !latest || compareCommentChronology(comment, latest) > 0 ? comment : latest, undefined);
}

function resolvePendingCommandContext(jobData: CommentJobData, commentsToProcess: UnprocessedComment[]): PendingCommandContext {
    const queuedCommandChronology = inferQueuedCommandChronology(jobData);
    const isNewerThanQueuedCommand = (comment: UnprocessedComment): boolean =>
        queuedCommandChronology === undefined
        || compareCommentChronology(comment, queuedCommandChronology) > 0;
    const latestCommandComment = findLatestComment(commentsToProcess, comment =>
        !!comment.commandMode
        && comment.commandMode !== 'default'
        && isNewerThanQueuedCommand(comment));
    const latestPendingOverrideComment = findLatestComment(
        commentsToProcess,
        comment => comment.llmOverride !== undefined
            && isNewerThanQueuedCommand(comment),
    );
    return { queuedCommandChronology, latestCommandComment, latestPendingOverrideComment };
}

function getQueuedOverride(jobData: CommentJobData, queuedCommandChronology: CommentChronology | undefined): ModelOverride | undefined {
    return (
        queuedCommandChronology !== undefined
        && jobData.commandMode === 'use'
        && (jobData.requestedModels?.[0] ?? jobData.llm)
    ) ? {
        ...queuedCommandChronology,
        commandMode: 'use',
        llmOverride: jobData.requestedModels?.[0] ?? jobData.llm,
    } : undefined;
}

function applyCommandComment(jobData: CommentJobData, comment: UnprocessedComment): void {
    jobData.commandMeta = comment.commandMeta;
    jobData.commandMode = comment.commandMode;
    jobData.requestedModels = comment.requestedModels;
    jobData.commandInstructions = comment.commandInstructions;
    jobData.commandCommentId = comment.id;
    jobData.commandCommentCreatedAt = comment.createdAt;
    jobData.commandCommentType = comment.type;
    jobData.ultrafixMeta = comment.ultrafixMeta;
}

function applyModelOverride(jobData: CommentJobData, latestCommandComment: UnprocessedComment | undefined, latestOverrideComment: ModelOverride | undefined): void {
    if (latestOverrideComment?.llmOverride !== undefined) jobData.llm = latestOverrideComment.llmOverride;
    if (
        latestCommandComment?.commandMode === 'review'
        && !latestCommandComment.requestedModels?.length
        && latestOverrideComment?.commandMode === 'use'
        && latestOverrideComment.llmOverride
    ) {
        jobData.requestedModels = [latestOverrideComment.llmOverride];
    }
}

export function applyPendingCommentCommandContext(jobData: CommentJobData, commentsToProcess: UnprocessedComment[], correlatedLogger: Logger): void {
    const {
        queuedCommandChronology,
        latestCommandComment,
        latestPendingOverrideComment,
    } = resolvePendingCommandContext(jobData, commentsToProcess);

    if (!latestCommandComment && !latestPendingOverrideComment) return;

    const latestOverrideComment: ModelOverride | undefined = latestPendingOverrideComment
        ?? getQueuedOverride(jobData, queuedCommandChronology);
    if (latestCommandComment) applyCommandComment(jobData, latestCommandComment);
    applyModelOverride(jobData, latestCommandComment, latestOverrideComment);

    correlatedLogger.info({
        commandMode: jobData.commandMode,
        requestedModels: jobData.requestedModels,
        llmOverride: latestOverrideComment?.llmOverride,
        commandCommentId: latestCommandComment?.id,
        commandCommentCreatedAt: latestCommandComment?.createdAt,
        queuedCommandCommentId: queuedCommandChronology?.id,
        queuedCommandCommentCreatedAt: queuedCommandChronology?.createdAt,
        overrideCommentId: latestOverrideComment?.id,
    }, 'Applied command context from pending batched comment');
}
