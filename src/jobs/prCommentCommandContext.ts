import type { Logger } from 'pino';
import {
    dedupeUnprocessedComments,
    getUnprocessedCommentRevisionIdentity,
    type CommentJobData,
    type UnprocessedComment,
} from '@propr/core';

interface CommentChronology {
    id: number;
    createdAt?: string;
    updatedAt?: string;
    revisionIdentity?: string;
    type?: UnprocessedComment['type'];
    ingestionOrder?: number;
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

function compareOptionalStrings(left: string | undefined, right: string | undefined): number {
    if (left === right) return 0;
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    return left.localeCompare(right);
}

function compareOptionalNumbers(left: number | undefined, right: number | undefined): number {
    if (left === right) return 0;
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    return left - right;
}

function compareCommentRevisions(left: CommentChronology, right: CommentChronology): number {
    const updateOrder = compareOptionalStrings(
        left.updatedAt ?? left.createdAt,
        right.updatedAt ?? right.createdAt,
    );
    if (updateOrder !== 0) return updateOrder;

    const ingestionOrder = compareOptionalNumbers(left.ingestionOrder, right.ingestionOrder);
    return ingestionOrder !== 0
        ? ingestionOrder
        : compareOptionalStrings(left.revisionIdentity, right.revisionIdentity);
}

function compareCommentChronology(left: CommentChronology, right: CommentChronology, useCreatedAt: boolean): number {
    if (left.id === right.id && left.type === right.type) return compareCommentRevisions(left, right);

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

function orderedComments(comments: UnprocessedComment[]): Array<UnprocessedComment & CommentChronology> {
    return comments.map((comment, ingestionOrder) => ({
        ...comment,
        revisionIdentity: getUnprocessedCommentRevisionIdentity(comment),
        ingestionOrder,
    }));
}

function latestCommentRevisions(comments: Array<UnprocessedComment & CommentChronology>): Array<UnprocessedComment & CommentChronology> {
    const latestByComment = new Map<string, UnprocessedComment & CommentChronology>();
    for (const comment of comments) {
        const key = `${comment.type}:${comment.id}`;
        const latest = latestByComment.get(key);
        if (!latest || compareCommentChronology(comment, latest, true) > 0) latestByComment.set(key, comment);
    }
    return [...latestByComment.values()];
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
        const candidateComments = orderedComments(jobData.comments ?? []).filter(comment =>
            comment.id === jobData.commandCommentId
            && (jobData.commandCommentType === undefined || comment.type === jobData.commandCommentType));
        const ownerComment = candidateComments.find(comment =>
            jobData.commandCommentRevisionIdentity !== undefined
            && comment.revisionIdentity === jobData.commandCommentRevisionIdentity)
            ?? candidateComments.find(comment =>
                jobData.commandCommentUpdatedAt !== undefined
                && comment.updatedAt === jobData.commandCommentUpdatedAt)
            ?? candidateComments[0];
        return [{
            id: jobData.commandCommentId,
            createdAt: jobData.commandCommentCreatedAt ?? ownerComment?.createdAt,
            updatedAt: jobData.commandCommentUpdatedAt ?? ownerComment?.updatedAt,
            revisionIdentity: jobData.commandCommentRevisionIdentity ?? ownerComment?.revisionIdentity,
            type: jobData.commandCommentType ?? ownerComment?.type,
            ingestionOrder: ownerComment?.ingestionOrder,
        }];
    }

    return jobData.comments
        ?? (jobData.commentId === undefined
            ? []
            : [{ id: jobData.commentId }]);
}

function resolvePendingCommandContext(jobData: CommentJobData, commentsToProcess: UnprocessedComment[]): PendingCommandContext {
    const queuedCommandCandidates = getQueuedCommandChronologyCandidates(jobData);
    // Multiple webhook deliveries may contain revisions of one GitHub comment.
    // Only its newest revision participates in routing; all revisions remain in
    // jobData.comments for durable retry/recovery.
    const pendingChronologyRecords = latestCommentRevisions(orderedComments(commentsToProcess)).filter(comment =>
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
        pendingChronologyRecords,
        comment => !!comment.commandMode
            && comment.commandMode !== 'default'
            && isNewerThanQueuedCommand(comment),
        compareChronology,
    );
    const latestPendingOverrideComment = findLatestComment(
        pendingChronologyRecords,
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
    jobData.commandCommentUpdatedAt = comment.updatedAt;
    jobData.commandCommentRevisionIdentity = getUnprocessedCommentRevisionIdentity(comment);
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
    // The worker owns every comment it claimed. Persist that complete ordered
    // set before routing checks, provider retries, or superseded exits.
    jobData.comments = dedupeUnprocessedComments(commentsToProcess);
    const {
        queuedCommandChronology,
        latestCommandComment,
        latestPendingOverrideComment,
    } = resolvePendingCommandContext(jobData, jobData.comments);

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
        commandCommentUpdatedAt: latestCommandComment?.updatedAt,
        queuedCommandCommentId: queuedCommandChronology?.id,
        queuedCommandCommentCreatedAt: queuedCommandChronology?.createdAt,
        overrideCommentId: latestOverrideComment?.id,
    }, 'Applied command context from pending batched comment');
}
