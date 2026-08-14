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
    agentAlias?: string;
    modelName?: string;
    modelLabel?: string;
}

interface PendingCommandContext {
    queuedCommandChronology?: CommentChronology;
    latestCommandComment?: UnprocessedComment;
    latestPendingOverrideComment?: UnprocessedComment;
}

type CommentChronologyComparator = (left: CommentChronology, right: CommentChronology) => number;

function compareCommentTypes(left: CommentChronology['type'], right: CommentChronology['type']): number {
    if (left === right) return 0;
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    return left === 'issue' ? -1 : 1;
}

function compareCommentChronology(left: CommentChronology, right: CommentChronology, useCreatedAt: boolean): number {
    if (useCreatedAt && left.createdAt !== undefined && right.createdAt !== undefined) {
        const createdAtOrder = left.createdAt.localeCompare(right.createdAt);
        if (createdAtOrder !== 0) return createdAtOrder;

        const typeOrder = compareCommentTypes(left.type, right.type);
        if (typeOrder !== 0) return typeOrder;
    }

    const idOrder = left.id - right.id;
    return idOrder !== 0 || useCreatedAt
        ? idOrder
        : compareCommentTypes(left.type, right.type);
}

function findLatestComment<T extends CommentChronology>(
    comments: T[],
    predicate: (comment: T) => boolean,
    compareChronology: CommentChronologyComparator,
): T | undefined {
    return comments.reduce<T | undefined>((latest, comment) => {
        if (!predicate(comment)) return latest;
        return !latest || compareChronology(comment, latest) > 0 ? comment : latest;
    }, undefined);
}

function getQueuedCommandChronologyCandidates(jobData: CommentJobData): CommentChronology[] {
    if (!jobData.commandMode || jobData.commandMode === 'default') return [];

    if (jobData.commandCommentId !== undefined) {
        const ownerComment = jobData.comments?.find(comment =>
            comment.id === jobData.commandCommentId
            && (jobData.commandCommentType === undefined || comment.type === jobData.commandCommentType));
        return [{
            id: jobData.commandCommentId,
            createdAt: jobData.commandCommentCreatedAt ?? ownerComment?.createdAt,
            type: jobData.commandCommentType ?? ownerComment?.type,
        }];
    }

    return jobData.comments
        ?? (jobData.commentId === undefined
            ? []
            : [{ id: jobData.commentId }]);
}

function resolvePendingCommandContext(jobData: CommentJobData, commentsToProcess: UnprocessedComment[]): PendingCommandContext {
    const queuedCommandCandidates = getQueuedCommandChronologyCandidates(jobData);
    const pendingChronologyRecords = commentsToProcess.filter(comment =>
        (!!comment.commandMode && comment.commandMode !== 'default')
        || comment.llmOverride !== undefined);
    const useCreatedAt = [...queuedCommandCandidates, ...pendingChronologyRecords]
        .every(comment => comment.createdAt !== undefined);
    const compareChronology: CommentChronologyComparator = (left, right) =>
        compareCommentChronology(left, right, useCreatedAt);
    const queuedCommandChronology = findLatestComment(
        queuedCommandCandidates,
        () => true,
        compareChronology,
    );
    const isNewerThanQueuedCommand = (comment: UnprocessedComment): boolean =>
        queuedCommandChronology === undefined
        || compareChronology(comment, queuedCommandChronology) > 0;
    const latestCommandComment = findLatestComment(
        commentsToProcess,
        comment => !!comment.commandMode
            && comment.commandMode !== 'default'
            && isNewerThanQueuedCommand(comment),
        compareChronology,
    );
    const latestPendingOverrideComment = findLatestComment(
        commentsToProcess,
        comment => comment.llmOverride !== undefined
            && isNewerThanQueuedCommand(comment),
        compareChronology,
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
        agentAlias: jobData.agentAlias,
        modelName: jobData.modelName,
        modelLabel: jobData.modelLabel,
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
    jobData.agentAlias = comment.agentAlias;
    jobData.modelName = comment.modelName;
    jobData.modelLabel = comment.modelLabel;
}

function applyModelOverride(jobData: CommentJobData, latestCommandComment: UnprocessedComment | undefined, latestOverrideComment: ModelOverride | undefined): void {
    if (latestOverrideComment?.llmOverride !== undefined) jobData.llm = latestOverrideComment.llmOverride;
    if (latestOverrideComment?.agentAlias) jobData.agentAlias = latestOverrideComment.agentAlias;
    if (latestOverrideComment?.modelName) jobData.modelName = latestOverrideComment.modelName;
    if (latestOverrideComment?.modelLabel) jobData.modelLabel = latestOverrideComment.modelLabel;
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
