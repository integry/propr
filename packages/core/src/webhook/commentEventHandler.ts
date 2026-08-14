/* eslint-disable max-lines */
import logger, { generateCorrelationId } from '../utils/logger.js';
import { handleError } from '../utils/errorHandler.js';
import { getIssueQueue, COMMENT_BATCH_DELAY_MS, type CommentJobData, type UnprocessedComment } from '../queue/taskQueue.js';
import { filterCommentByAuthor, checkCommentTrigger, checkCommentIgnore } from '../utils/commentFilters.js';
import { loadFollowupIgnoreKeywords, loadPrimaryProcessingLabels } from '../config/configManager.js';
import { getAuthenticatedOctokit } from '../auth/githubAuth.js';
import { getPendingPrCommentsKey } from '../utils/constants.js';
import { getUnprocessedCommentRevisionIdentity, restorePendingCommentsIdempotently } from '../utils/pendingComments.js';
import { withRetry } from '../utils/retryHandler.js';
import type { Job } from 'bullmq';
import type { Redis } from 'ioredis';
import {
    LabelTransitionLeaseError,
    withLabelTransitionLease,
    withUltrafixLabelTransition,
    type LabelTransitionLease,
} from '../utils/ultrafixLabelTransition.js';
import type { IssueCommentEvent, PullRequestReviewCommentEvent, Label } from '@octokit/webhooks-types';
import { extractLlmFromKeywords, stripKeywordsFromBody, buildCodeContext, isReviewComment, extractLlmFromLabels, modelLabelPrefix } from './commentEventHelpers.js';
import { handleMergeCommand } from './mergeConflictDetector.js';
import { parseSlashCommand, buildCommandMeta } from './slashCommandParser.js';
import type { CommandMeta, UltrafixCommandMeta } from './slashCommandParser.js';
import { safeUpdateLabels } from '../utils/github/labelOperations.js';
import { resolveModelAlias } from '../config/modelAliases.js';
import { getAllCustomLabels, resolveCanonicalModelSelection, type CanonicalModelSelection } from '../config/modelLabelResolution.js';
import { getBotUsername } from '../daemon/configLoader.js';
import type { DeliveryDisposition } from '../intake/routingWebSocketProtocol.js';

export interface UltrafixDeps {
    loadUltrafixRatingGoal: () => Promise<number>;
    loadUltrafixMaxCycles: () => Promise<number>;
    loadUltrafixPauseSeconds: () => Promise<number>;
    loadPrReviewModel: () => Promise<string>;
    startLoop: (redis: Redis, options: { owner: string; repo: string; pr: number; goal?: number; maxCycles?: number; pauseSeconds?: number; reviewModel?: string; workEpoch?: number }, hasPendingReviews: boolean) => Promise<{ state: unknown; initialAction: 'review' | 'fix' }>;
    clearStateIfCurrent: (redis: Redis, identity: { owner: string; repo: string; pr: number }, workEpoch: number) => Promise<boolean>;
    hasAutomaticWork: (redis: Redis, owner: string, repo: string, pr: number) => Promise<boolean>;
    reserveAutomaticWork: (redis: Redis, owner: string, repo: string, pr: number) => Promise<number>;
    invalidateAutomaticWork: (redis: Redis, identity: { owner: string; repo: string; pr: number; sourceCommentId: number; sourceCommentRevision: string }) => Promise<{ workEpoch: number; hadAutomaticWork: boolean }>;
    getPendingReviewState: (allComments: Array<{ id: number; body: string | null; user: { login: string; type?: string }; created_at: string }>, options: { repoOwner: string; repoName: string; pullRequestNumber: number; redisClient: Redis; correlatedLogger: ReturnType<typeof logger.withCorrelation> }) => Promise<{ hasPendingReview: boolean }>;
}

let _ultrafixDeps: UltrafixDeps | null = null;

export function setUltrafixDeps(deps: UltrafixDeps): void {
    _ultrafixDeps = deps;
}

function loadUltrafixDeps(): UltrafixDeps {
    if (!_ultrafixDeps) {
        throw new Error('Ultrafix dependencies not initialized. Call setUltrafixDeps() during app startup.');
    }
    return _ultrafixDeps;
}

export type CommentEventType = 'issue_comment' | 'pull_request_review_comment';

export interface CommentEventConfig {
    redisClient: Redis;
    PR_FOLLOWUP_TRIGGER_KEYWORDS: string[];
    MODEL_LABEL_PATTERN?: string;
    processCommentEvent?: typeof processCommentEvent;
}

export type CommentPayload = IssueCommentEvent | PullRequestReviewCommentEvent;

interface PRJobData extends CommentJobData {
    pullRequestNumber: number;
    repoOwner: string;
    repoName: string;
    comments?: UnprocessedComment[];
}

interface CommentContext { eventType: CommentEventType; prNumber: number; owner: string; repo: string }
interface StoreCommentConfig { redisClient: Redis; PR_FOLLOWUP_TRIGGER_KEYWORDS: string[] }
interface EnqueueCommentOptions { payload: IssueCommentEvent | PullRequestReviewCommentEvent; redisClient: Redis; PR_FOLLOWUP_TRIGGER_KEYWORDS: string[]; MODEL_LABEL_PATTERN?: string; correlationId: string; commandMeta?: CommandMeta; prefetchedPRData?: PRBranchAndLabels; ultrafixMeta?: UltrafixCommandMeta; commentRevisionIdentity?: string; modelSelection?: CanonicalModelSelection; pendingOnly?: boolean }
interface RepoContext { owner: string; repo: string; prNumber: number }
interface PRBranchAndLabels { branchName: string; prLabels: Label[] }
type BatchComment = Pick<UnprocessedComment, 'id' | 'body' | 'revisionIdentity' | 'commandMeta' | 'commandMode' | 'requestedModels' | 'commandInstructions' | 'llmOverride' | 'agentAlias' | 'modelName' | 'modelLabel' | 'ultrafixMeta'> & { created_at: string; updated_at: string; path?: string; line?: number | null; diff_hunk?: string; pull_request_review_id?: number };
type CommandJobFields = Pick<CommentJobData, 'commandMeta' | 'commandMode' | 'requestedModels' | 'commandInstructions'>;
type PRComment = { id: number; created_at: string; updated_at: string; body: string; user: { login: string; type?: string }; path?: string; line?: number | null; diff_hunk?: string; pull_request_review_id?: number };
type ManualCommandTakeover = { workEpoch: number; hadAutomaticWork: boolean; commentRevisionIdentity: string };

function getCommentRevisionIdentity(comment: Pick<PRComment, 'updated_at' | 'body'>, eventType: CommentEventType): string {
    return getUnprocessedCommentRevisionIdentity({
        updatedAt: comment.updated_at,
        body: comment.body,
        type: eventType === 'pull_request_review_comment' ? 'review' : 'issue',
    });
}

async function claimCommentForProcessing(redisClient: Redis, key: string): Promise<boolean> {
    const result = await redisClient.set(key, Date.now().toString(), 'EX', 86400, 'NX');
    return result === 'OK';
}

async function prHasProcessingLabel(prLabels: Label[]): Promise<boolean> {
    const processingLabels = await loadPrimaryProcessingLabels();
    return prLabels.some(label => processingLabels.includes(label.name));
}

function getCommentEventDetails(
    payload: IssueCommentEvent | PullRequestReviewCommentEvent,
    eventType: CommentEventType,
    repoFullName: string,
    correlatedLogger: ReturnType<typeof logger.withCorrelation>,
): { prNumber: number; comment: PRComment } | null {
    if (eventType === 'issue_comment') {
        const issuePayload = payload as IssueCommentEvent;
        if (!issuePayload.issue.pull_request) {
            correlatedLogger.debug({ repository: repoFullName }, 'Issue comment is not on a PR, skipping');
            return null;
        }

        return {
            prNumber: issuePayload.issue.number,
            comment: issuePayload.comment,
        };
    }

    if (eventType === 'pull_request_review_comment') {
        const prPayload = payload as PullRequestReviewCommentEvent;
        return {
            prNumber: prPayload.pull_request.number,
            comment: prPayload.comment,
        };
    }

    correlatedLogger.warn({ eventType }, 'Unknown event type for comment processing');
    return null;
}

export async function handleCommentDeleted(payload: IssueCommentEvent | PullRequestReviewCommentEvent, eventType: CommentEventType, correlationId: string, config: CommentEventConfig): Promise<void> {
    const { redisClient } = config;
    const correlatedLogger = logger.withCorrelation(correlationId);
    const owner = payload.repository.owner.login;
    const repo = payload.repository.name;
    const repoFullName = `${owner}/${repo}`;

    let prNumber: number, commentId: number;
    if (eventType === 'issue_comment') {
        const issuePayload = payload as IssueCommentEvent;
        if (!issuePayload.issue.pull_request) { correlatedLogger.debug({ repository: repoFullName }, 'Issue comment is not on a PR, skipping'); return; }
        prNumber = issuePayload.issue.number;
        commentId = issuePayload.comment.id;
    } else if (eventType === 'pull_request_review_comment') {
        const prPayload = payload as PullRequestReviewCommentEvent;
        prNumber = prPayload.pull_request.number;
        commentId = prPayload.comment.id;
    } else { correlatedLogger.warn({ eventType }, 'Unknown event type for comment deletion'); return; }

    correlatedLogger.info({ repository: repoFullName, pullRequestNumber: prNumber, commentId }, 'Comment deleted, aborting any active jobs for this PR');
    const allJobs = await getExistingPRCommentJobs(prNumber, owner, repo);

    for (const job of allJobs) {
        const jobCommentIds = job.data.comments?.map(c => c.id) || [];
        if (jobCommentIds.includes(commentId)) {
            correlatedLogger.info({ jobId: job.id, pullRequestNumber: prNumber, repository: repoFullName }, 'Aborting job due to comment deletion');
            const taskId = job.id ?? `${owner}-${repo}-${prNumber}`;
            await redisClient.set(`worker:abort:${taskId}`, JSON.stringify({ timestamp: new Date().toISOString(), reason: 'comment_deleted', commentId }), 'EX', 3600);
            await job.remove();
            correlatedLogger.info({ jobId: job.id, taskId }, 'Job aborted and removed from queue');
        }
    }
    await redisClient.del(`pr-comment-processed:${owner}:${repo}:${prNumber}:${commentId}`);
}

export async function handleCommentEdited(payload: IssueCommentEvent | PullRequestReviewCommentEvent, eventType: CommentEventType, correlationId: string, config: CommentEventConfig): Promise<void> {
    const { redisClient, processCommentEvent: processCommentEventFn } = config;
    const correlatedLogger = logger.withCorrelation(correlationId);
    const owner = payload.repository.owner.login;
    const repo = payload.repository.name;
    const repoFullName = `${owner}/${repo}`;

    let prNumber: number, commentId: number;
    if (eventType === 'issue_comment') {
        const issuePayload = payload as IssueCommentEvent;
        if (!issuePayload.issue.pull_request) { correlatedLogger.debug({ repository: repoFullName }, 'Issue comment is not on a PR, skipping'); return; }
        prNumber = issuePayload.issue.number;
        commentId = issuePayload.comment.id;
    } else if (eventType === 'pull_request_review_comment') {
        const prPayload = payload as PullRequestReviewCommentEvent;
        prNumber = prPayload.pull_request.number;
        commentId = prPayload.comment.id;
    } else { correlatedLogger.warn({ eventType }, 'Unknown event type for comment edit'); return; }

    correlatedLogger.info({ repository: repoFullName, pullRequestNumber: prNumber, commentId }, 'Comment edited, restarting any active jobs for this PR');
    const allJobs = await getExistingPRCommentJobs(prNumber, owner, repo);

    let foundJob: Job<PRJobData> | null = null;
    for (const job of allJobs) {
        const jobCommentIds = job.data.comments?.map(c => c.id) || [];
        if (jobCommentIds.includes(commentId)) { foundJob = job; break; }
    }

    if (foundJob) {
        correlatedLogger.info({ jobId: foundJob.id, pullRequestNumber: prNumber, repository: repoFullName }, 'Aborting existing job due to comment edit');
        const taskId = foundJob.id ?? `${owner}-${repo}-${prNumber}`;
        await redisClient.set(`worker:abort:${taskId}`, JSON.stringify({ timestamp: new Date().toISOString(), reason: 'comment_edited', commentId }), 'EX', 3600);
        await foundJob.remove();
    }

    await redisClient.del(`pr-comment-processed:${owner}:${repo}:${prNumber}:${commentId}`);
    correlatedLogger.info({ pullRequestNumber: prNumber, repository: repoFullName, commentId }, 'Reprocessing edited comment');
    if (processCommentEventFn) await processCommentEventFn(payload, eventType, correlationId, config);
}

interface SlashCommandComment { id: number; created_at: string; updated_at: string; body: string; path?: string; line?: number | null; diff_hunk?: string; pull_request_review_id?: number }

interface SlashCommandHandlerOptions {
    parsedCommand: ReturnType<typeof parseSlashCommand> & object;
    comment: SlashCommandComment;
    commentAuthor: string;
    eventContext: CommentContext;
    payload: IssueCommentEvent | PullRequestReviewCommentEvent;
    config: CommentEventConfig;
    correlationId: string;
    correlatedLogger: ReturnType<typeof logger.withCorrelation>;
}

type ManualCommandFenceOptions = Pick<SlashCommandHandlerOptions, 'comment' | 'eventContext' | 'config' | 'correlatedLogger'> & {
    commandMeta: CommandMeta;
};

async function fenceManualCommand(opts: ManualCommandFenceOptions): Promise<ManualCommandTakeover | null> {
    const { commandMeta, comment, eventContext, config, correlatedLogger } = opts;
    if (commandMeta.mode !== 'fix' && commandMeta.mode !== 'review' && commandMeta.mode !== 'use') return null;

    const { owner, repo, prNumber } = eventContext;
    const commentRevisionIdentity = getCommentRevisionIdentity(comment, eventContext.eventType);
    const takeover = await loadUltrafixDeps().invalidateAutomaticWork(config.redisClient, {
        owner,
        repo,
        pr: prNumber,
        sourceCommentId: comment.id,
        sourceCommentRevision: commentRevisionIdentity,
    });
    correlatedLogger.info(
        { pullRequestNumber: prNumber, commentId: comment.id, command: commandMeta.mode, workEpoch: takeover.workEpoch },
        'Manual command invalidated deferred and queued Ultrafix actions',
    );
    return { ...takeover, commentRevisionIdentity };
}

async function handleSlashCommand(opts: SlashCommandHandlerOptions): Promise<void> {
    const { parsedCommand, comment, commentAuthor, eventContext, payload, config, correlationId, correlatedLogger } = opts;
    const { prNumber, owner, repo } = eventContext;
    const { redisClient } = config;
    const commandMeta = buildCommandMeta(parsedCommand);

    if ('warning' in commandMeta && commandMeta.warning) {
        correlatedLogger.warn({ pullRequestNumber: prNumber, commentId: comment.id, commentAuthor }, commandMeta.warning);
    }

    if (commandMeta.mode === 'ultrafix') {
        await handleUltrafixCommand({ commandMeta: commandMeta as UltrafixCommandMeta, comment, commentAuthor, eventContext, payload, config, correlationId, correlatedLogger });
        return;
    }

    if (commandMeta.mode === 'merge') {
        correlatedLogger.info({ pullRequestNumber: prNumber, commentId: comment.id, commentAuthor }, '/merge command detected, enqueuing merge job');
        try {
            await handleMergeCommand({ owner, repoName: repo, prNumber, redisClient, correlationId });
        } catch (mergeError) {
            correlatedLogger.error({ pullRequestNumber: prNumber, error: (mergeError as Error).message }, 'Failed to handle /merge command');
        }
        return;
    }

    if (commandMeta.mode === 'switch' || commandMeta.mode === 'use') {
        await handleModelSelectionCommand({ commandMeta, comment, commentAuthor, eventContext, payload, config, correlationId, correlatedLogger });
        return;
    }

    const manualTakeover = await fenceManualCommand({ commandMeta, comment, eventContext, config, correlatedLogger });
    const commentRevisionIdentity = manualTakeover?.commentRevisionIdentity
        ?? getCommentRevisionIdentity(comment, eventContext.eventType);

    correlatedLogger.info({ pullRequestNumber: prNumber, commentId: comment.id, commentAuthor, command: commandMeta.mode }, `/${commandMeta.mode} command detected, enqueuing job`);
    // Strip the slash command line from the comment body so the downstream job
    // only sees the user's instructions, not the control syntax (consistent with /switch).
    const strippedComment = { ...comment, body: commandMeta.instructions || '', revisionIdentity: commentRevisionIdentity };

    // Check for existing active/waiting jobs for this PR (batching/concurrency guard).
    // The Redis loop state may already be inactive while its BullMQ job is still
    // finishing, so the post-invalidation queue snapshot is also authoritative.
    const existingJobs = await getExistingPRCommentJobs(prNumber, owner, repo);
    const requiresIndependentTakeover = shouldEnqueueIndependentManualTakeover(existingJobs, manualTakeover);

    if (existingJobs.length > 0 && !requiresIndependentTakeover) {
        await storeCommentForBatch({ ...strippedComment, ...buildPendingCommandFields(commandMeta) }, commentAuthor, eventContext, { redisClient, PR_FOLLOWUP_TRIGGER_KEYWORDS: config.PR_FOLLOWUP_TRIGGER_KEYWORDS });
        correlatedLogger.info({ pullRequestNumber: prNumber, commentId: comment.id, command: commandMeta.mode }, `/${commandMeta.mode} command: existing job found for PR, stored comment for batch processing`);
        return;
    }

    if (existingJobs.length > 0 && requiresIndependentTakeover) {
        correlatedLogger.info(
            { pullRequestNumber: prNumber, commentId: comment.id, command: commandMeta.mode },
            'Manual Ultrafix takeover will run as an independent durable job',
        );
    }

    await enqueueNewCommentJob(strippedComment, commentAuthor, eventContext, { payload, redisClient, PR_FOLLOWUP_TRIGGER_KEYWORDS: config.PR_FOLLOWUP_TRIGGER_KEYWORDS, MODEL_LABEL_PATTERN: config.MODEL_LABEL_PATTERN, correlationId, commandMeta, commentRevisionIdentity });
}

type ModelSelectionCommandOptions = Omit<SlashCommandHandlerOptions, 'parsedCommand'> & { commandMeta: CommandMeta & { mode: 'switch' | 'use' } };

interface PRCommentJobSnapshot {
    active: Job<PRJobData>[];
    waiting: Job<PRJobData>[];
    delayed: Job<PRJobData>[];
}

interface CommandChronology {
    id: number;
    createdAt?: string;
    updatedAt?: string;
    revisionIdentity?: string;
    type?: UnprocessedComment['type'];
    ingestionOrder?: number;
}

function compareOptionalStrings(left: string | undefined, right: string | undefined): number {
    if (left === right) return 0;
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    return left.localeCompare(right);
}

function compareCommandTypes(left: CommandChronology['type'], right: CommandChronology['type']): number {
    if (left === right) return 0;
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    return left === 'issue' ? -1 : 1;
}

function compareCommandChronology(left: CommandChronology, right: CommandChronology, useCreatedAt: boolean): number {
    if (left.id === right.id && left.type === right.type) {
        const revisionOrder = compareOptionalStrings(left.updatedAt ?? left.createdAt, right.updatedAt ?? right.createdAt);
        if (revisionOrder !== 0) return revisionOrder;
        if (left.ingestionOrder !== right.ingestionOrder) return (left.ingestionOrder ?? -1) - (right.ingestionOrder ?? -1);
        return compareOptionalStrings(left.revisionIdentity, right.revisionIdentity);
    }

    if (useCreatedAt && left.createdAt !== undefined && right.createdAt !== undefined) {
        const createdAtOrder = left.createdAt.localeCompare(right.createdAt);
        if (createdAtOrder !== 0) return createdAtOrder;
        const typeOrder = compareCommandTypes(left.type, right.type);
        if (typeOrder !== 0) return typeOrder;
    }

    const idOrder = left.id - right.id;
    if (idOrder !== 0 || useCreatedAt) return idOrder;
    return compareCommandTypes(left.type, right.type);
}

function getJobCommandChronologies(job: Job<PRJobData>): CommandChronology[] {
    const data = job.data;
    if (!data.commandMode || data.commandMode === 'default') return [];
    if (data.commandCommentId === undefined) {
        return data.comments ?? (data.commentId === undefined ? [] : [{ id: data.commentId }]);
    }

    const candidates = (data.comments ?? []).map((comment, ingestionOrder) => ({
        ...comment,
        revisionIdentity: getUnprocessedCommentRevisionIdentity(comment),
        ingestionOrder,
    })).filter(comment => comment.id === data.commandCommentId
        && (data.commandCommentType === undefined || comment.type === data.commandCommentType));
    const ownerComment = candidates.find(comment => data.commandCommentRevisionIdentity !== undefined
        && comment.revisionIdentity === data.commandCommentRevisionIdentity)
        ?? candidates.find(comment => data.commandCommentUpdatedAt !== undefined
            && comment.updatedAt === data.commandCommentUpdatedAt)
        ?? candidates[0];
    return [{
        id: data.commandCommentId,
        createdAt: data.commandCommentCreatedAt ?? ownerComment?.createdAt,
        updatedAt: data.commandCommentUpdatedAt ?? ownerComment?.updatedAt,
        revisionIdentity: data.commandCommentRevisionIdentity ?? ownerComment?.revisionIdentity,
        type: data.commandCommentType ?? ownerComment?.type,
    }];
}

function latestPendingCommandChronologies(comments: UnprocessedComment[]): CommandChronology[] {
    const latestByComment = new Map<string, CommandChronology>();
    comments.forEach((comment, ingestionOrder) => {
        if ((!comment.commandMode || comment.commandMode === 'default') && comment.llmOverride === undefined) return;
        const chronology = {
            ...comment,
            revisionIdentity: getUnprocessedCommentRevisionIdentity(comment),
            ingestionOrder,
        };
        const key = `${comment.type}:${comment.id}`;
        const latest = latestByComment.get(key);
        if (!latest || compareCommandChronology(chronology, latest, true) > 0) latestByComment.set(key, chronology);
    });
    return [...latestByComment.values()];
}

async function findNewerQueuedCommand(
    incoming: CommandChronology,
    eventContext: CommentContext,
    snapshot: PRCommentJobSnapshot,
    redisClient: Redis,
): Promise<CommandChronology | undefined> {
    const pendingKey = getPendingPrCommentsKey(eventContext.owner, eventContext.repo, eventContext.prNumber);
    const pendingComments = (await redisClient.lrange(pendingKey, 0, -1)).map(raw => JSON.parse(raw) as UnprocessedComment);
    const existing = [
        ...snapshot.active,
        ...snapshot.waiting,
        ...snapshot.delayed,
    ].flatMap(getJobCommandChronologies).concat(latestPendingCommandChronologies(pendingComments));
    const orderedExisting = existing.map((record, ingestionOrder) => ({ ...record, ingestionOrder }));
    const useCreatedAt = [...orderedExisting, incoming].every(record => record.createdAt !== undefined);
    const latest = orderedExisting.reduce<CommandChronology | undefined>((current, record) =>
        !current || compareCommandChronology(record, current, useCreatedAt) > 0 ? record : current, undefined);
    return latest && compareCommandChronology(incoming, latest, useCreatedAt) < 0 ? latest : undefined;
}

function getModelCommandSequenceKey(eventContext: CommentContext): string {
    return `pr-model-command-sequence:${eventContext.owner}:${eventContext.repo}:${eventContext.prNumber}`;
}

function getModelCommandRevisionKey(eventContext: CommentContext): string {
    return `pr-model-command-revision:${eventContext.owner}:${eventContext.repo}:${eventContext.prNumber}`;
}

async function nextModelCommandIngestionOrder(redisClient: Redis, eventContext: CommentContext): Promise<number> {
    const sequenceKey = getModelCommandSequenceKey(eventContext);
    const ingestionOrder = await redisClient.incr(sequenceKey);
    await redisClient.expire(sequenceKey, 86400);
    return ingestionOrder;
}

async function claimLatestModelCommand(
    redisClient: Redis,
    eventContext: CommentContext,
    incoming: CommandChronology,
): Promise<boolean> {
    const markerKey = getModelCommandRevisionKey(eventContext);
    const rawMarker = await redisClient.get(markerKey);
    if (rawMarker) {
        const current = JSON.parse(rawMarker) as CommandChronology;
        const useCreatedAt = current.createdAt !== undefined && incoming.createdAt !== undefined;
        if (compareCommandChronology(incoming, current, useCreatedAt) < 0) return false;
    }
    await redisClient.set(markerKey, JSON.stringify(incoming), 'EX', 86400);
    return true;
}

async function resolveCompatibleModelSelection(
    selection: CanonicalModelSelection,
    modelLabelPattern: string,
): Promise<CanonicalModelSelection | null> {
    const modelLabelRegex = new RegExp(modelLabelPattern);
    const configuredCustomLabels = new Set((await getAllCustomLabels()).map(label => label.toLowerCase()));
    if (modelLabelRegex.test(selection.githubLabel) || configuredCustomLabels.has(selection.githubLabel.toLowerCase())) {
        return selection;
    }

    const { prefix, derived } = modelLabelPrefix(modelLabelPattern);
    const canonicalSuffix = selection.githubLabel.match(/^llm-(.+)$/i)?.[1];
    if (!derived || !canonicalSuffix) return null;

    const candidate = `${prefix}${canonicalSuffix}`;
    const match = candidate.match(modelLabelRegex);
    if (!match || match.length !== 2 || !match[1]) return null;
    const roundTrip = await resolveCanonicalModelSelection(match[1]);
    if (!roundTrip
        || roundTrip.agentAlias.toLowerCase() !== selection.agentAlias.toLowerCase()
        || roundTrip.model.toLowerCase() !== selection.model.toLowerCase()) return null;
    return { ...selection, githubLabel: candidate };
}

async function postModelSelectionAcknowledgement(
    opts: Pick<ModelSelectionCommandOptions, 'eventContext' | 'correlatedLogger'>,
    selection: CanonicalModelSelection,
    outcome: 'label-only' | 'queued' | 'pending',
): Promise<void> {
    const { owner, repo, prNumber } = opts.eventContext;
    const suffix = outcome === 'pending'
        ? ' The follow-up is saved for the active writer.'
        : outcome === 'queued'
            ? ' The follow-up has been queued.'
            : '';
    try {
        const octokit = await getAuthenticatedOctokit();
        await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
            owner,
            repo,
            issue_number: prNumber,
            body: `✅ Model switched to \`${selection.githubLabel}\` (\`${selection.agentAlias}:${selection.model}\`).${suffix}`,
        });
    } catch (error) {
        opts.correlatedLogger.warn({ pullRequestNumber: prNumber, error: (error as Error).message }, 'Model switch succeeded but acknowledgement could not be posted');
    }
}

async function transitionModelLabel(
    opts: ModelSelectionCommandOptions,
    prLabels: Label[],
    selection: CanonicalModelSelection,
    lease: LabelTransitionLease,
): Promise<{ success: boolean; updatedLabels: Label[] }> {
    const { eventContext: { owner, repo, prNumber }, config: { redisClient }, config, correlatedLogger } = opts;
    const modelLabelPattern = config.MODEL_LABEL_PATTERN || '^llm-(.+)$';
    const modelLabelRegex = new RegExp(modelLabelPattern);
    const configuredCustomLabels = new Set((await getAllCustomLabels()).map(label => label.toLowerCase()));
    const existingModelLabels = prLabels
        .filter(label => modelLabelRegex.test(label.name) || configuredCustomLabels.has(label.name.toLowerCase()))
        .map(label => label.name);
    const targetAlreadyPresent = existingModelLabels.some(label => label.toLowerCase() === selection.githubLabel.toLowerCase());
    const labelsToRemove = existingModelLabels.filter(label => label.toLowerCase() !== selection.githubLabel.toLowerCase());
    const labelsToAdd = targetAlreadyPresent ? [] : [selection.githubLabel];

    const octokit = await getAuthenticatedOctokit();
    const result = await safeUpdateLabels(
        { octokit, owner, repo, issueNumber: prNumber, logger: correlatedLogger },
        labelsToRemove,
        labelsToAdd,
        {
            targetLabel: selection.githubLabel,
            isManagedLabel: labelName =>
                modelLabelRegex.test(labelName)
                || configuredCustomLabels.has(labelName.toLowerCase()),
            maxAttempts: 3,
            redis: redisClient,
            lease,
        },
    );
    if (!result.success) {
        correlatedLogger.error({ pullRequestNumber: prNumber, targetLabel: selection.githubLabel, errors: result.errors }, 'Model label transition failed; follow-up will not be queued');
        return { success: false, updatedLabels: prLabels };
    }

    const verifiedLabelNames = result.finalLabels ?? [
        ...prLabels.filter(label => !labelsToRemove.includes(label.name)).map(label => label.name),
        ...(!targetAlreadyPresent ? [selection.githubLabel] : []),
    ];
    const updatedLabels = verifiedLabelNames.map(name => ({
        id: 0, name, node_id: '', url: '', color: '', default: false, description: null,
    } as Label));
    return { success: true, updatedLabels };
}

function isProviderLimitRetry(job: Job<PRJobData>): boolean {
    return job.data.isRetryFromRateLimit === true || String(job.id ?? '').endsWith('-ratelimit-retry');
}

async function restoreSupersededRetryComments(jobs: Job<PRJobData>[], eventContext: CommentContext, redisClient: Redis): Promise<void> {
    const comments = jobs.flatMap(job => job.data.comments ?? []);
    const pendingCommentsKey = getPendingPrCommentsKey(eventContext.owner, eventContext.repo, eventContext.prNumber);
    await restorePendingCommentsIdempotently(redisClient, pendingCommentsKey, comments);
}

async function supersedeProviderLimitRetries(snapshot: PRCommentJobSnapshot, eventContext: CommentContext, redisClient: Redis): Promise<number> {
    const retryJobs = [...snapshot.waiting, ...snapshot.delayed].filter(isProviderLimitRetry);
    if (retryJobs.length === 0) return 0;
    await restoreSupersededRetryComments(retryJobs, eventContext, redisClient);
    for (const job of retryJobs) await job.remove();
    return retryJobs.length;
}

async function handleModelSelectionCommand(opts: ModelSelectionCommandOptions): Promise<void> {
    const { commandMeta, comment, commentAuthor, eventContext, payload, config, correlationId, correlatedLogger } = opts;
    const { eventType, prNumber, owner, repo } = eventContext;
    const { redisClient } = config;
    const commandName = commandMeta.mode;

    if (commandMeta.models.length === 0) {
        correlatedLogger.warn({ pullRequestNumber: prNumber, commentId: comment.id, commentAuthor }, `/${commandName} command requires a model argument, ignoring`);
        return;
    }
    const ingestionOrder = await nextModelCommandIngestionOrder(redisClient, eventContext);

    const canonicalSelection = await resolveCanonicalModelSelection(commandMeta.models[0]);
    if (!canonicalSelection) {
        correlatedLogger.warn({ pullRequestNumber: prNumber, requestedModel: commandMeta.models[0] }, `/${commandName} command contains an unrecognized model or an unconfigured model, ignoring`);
        return;
    }
    const modelLabelPattern = config.MODEL_LABEL_PATTERN || '^llm-(.+)$';
    const selection = await resolveCompatibleModelSelection(canonicalSelection, modelLabelPattern);
    if (!selection) {
        correlatedLogger.error({ pullRequestNumber: prNumber, targetLabel: canonicalSelection.githubLabel, modelLabelPattern }, 'Configured model label pattern cannot represent the selected model unambiguously');
        return;
    }
    const selectedCommandMeta = { ...commandMeta, models: [selection.model] } as CommandMeta & { mode: 'switch' | 'use' };
    const commentRevisionIdentity = getCommentRevisionIdentity(comment, eventType);
    const commandChronology: CommandChronology = {
        id: comment.id,
        createdAt: comment.created_at,
        updatedAt: comment.updated_at,
        revisionIdentity: commentRevisionIdentity,
        type: eventType === 'pull_request_review_comment' ? 'review' : 'issue',
        ingestionOrder,
    };

    const chronologySnapshot = await getPRCommentJobSnapshot(prNumber, owner, repo);
    const newerCommand = await findNewerQueuedCommand(commandChronology, eventContext, chronologySnapshot, redisClient);
    if (newerCommand) {
        correlatedLogger.info({
            pullRequestNumber: prNumber,
            staleCommentId: comment.id,
            staleCommentUpdatedAt: comment.updated_at,
            newerCommentId: newerCommand.id,
            newerCommentUpdatedAt: newerCommand.updatedAt,
        }, `Ignoring stale /${commandName} delivery before model label transition`);
        return;
    }

    correlatedLogger.info({ pullRequestNumber: prNumber, commentId: comment.id, commentAuthor, selection }, `/${commandName} command detected, updating PR model label`);
    const prData = await getPRBranchAndLabels(eventType, payload, { owner, repo, prNumber });
    let acknowledgementOutcome: 'label-only' | 'queued' | 'pending' | undefined;
    try {
        await withLabelTransitionLease(redisClient, { owner, repo, pr: prNumber }, async lease => {
            if (!await claimLatestModelCommand(redisClient, eventContext, commandChronology)) {
                correlatedLogger.info({ pullRequestNumber: prNumber, staleCommentId: commandChronology.id }, 'Ignoring stale model command after acquiring the label transition lease');
                return;
            }

            const transition = await transitionModelLabel(opts, prData.prLabels, selection, lease);
            if (!transition.success) return;

            const shouldQueue = commandMeta.mode === 'use' || Boolean(commandMeta.instructions);
            if (!shouldQueue) {
                correlatedLogger.info({ pullRequestNumber: prNumber, selection }, '/switch command has no instructions, durable model switch complete');
                acknowledgementOutcome = 'label-only';
                return;
            }

            // /use is a manual takeover just like /fix and /review. Keep the
            // fence and every queue-or-pending handoff under the same PR lease
            // as the freshness claim and verified label convergence.
            await lease.assertOwned();
            const manualTakeover = await fenceManualCommand({ commandMeta, comment, eventContext, config, correlatedLogger });
            const strippedComment = { ...comment, body: commandMeta.instructions || '', revisionIdentity: commentRevisionIdentity };
            const snapshot = await getPRCommentJobSnapshot(prNumber, owner, repo);

            if (snapshot.active.length > 0) {
                await lease.assertOwned();
                await storeCommentForBatch({ ...strippedComment, ...buildPendingCommandFields(selectedCommandMeta, selection) }, commentAuthor, eventContext, { redisClient, PR_FOLLOWUP_TRIGGER_KEYWORDS: config.PR_FOLLOWUP_TRIGGER_KEYWORDS });
                if (commandMeta.mode !== 'use') {
                    correlatedLogger.info({ pullRequestNumber: prNumber, commentId: comment.id, selection }, `/${commandName} command: active writer found, stored selected follow-up for the next run`);
                    acknowledgementOutcome = 'pending';
                    return;
                }
                // The active worker may already have crossed its final pending-comment
                // check while BullMQ still reports it as active. Always enqueue a
                // deterministic pending-only successor after the write so one of the
                // two jobs is guaranteed to claim this revision.
                const updatedPRData = { branchName: prData.branchName, prLabels: transition.updatedLabels };
                await lease.assertOwned();
                await enqueueNewCommentJob(strippedComment, commentAuthor, eventContext, {
                    payload, redisClient, PR_FOLLOWUP_TRIGGER_KEYWORDS: config.PR_FOLLOWUP_TRIGGER_KEYWORDS,
                    MODEL_LABEL_PATTERN: config.MODEL_LABEL_PATTERN, correlationId,
                    commandMeta: selectedCommandMeta, prefetchedPRData: updatedPRData, modelSelection: selection,
                    commentRevisionIdentity, pendingOnly: true,
                });
                correlatedLogger.info({ pullRequestNumber: prNumber, commentId: comment.id, selection }, `/${commandName} command: active writer found, stored selected follow-up and queued its successor`);
                acknowledgementOutcome = 'queued';
                return;
            }

            const hasQueuedProviderRetries = [...snapshot.waiting, ...snapshot.delayed].some(isProviderLimitRetry);
            if (hasQueuedProviderRetries) {
                // Make the selected follow-up recoverable before removing its previous
                // owner. It is identity-deduplicated when the replacement claims it.
                await lease.assertOwned();
                await storeCommentForBatch(
                    { ...strippedComment, ...buildPendingCommandFields(selectedCommandMeta, selection) },
                    commentAuthor,
                    eventContext,
                    { redisClient, PR_FOLLOWUP_TRIGGER_KEYWORDS: config.PR_FOLLOWUP_TRIGGER_KEYWORDS },
                );
            }
            await lease.assertOwned();
            const supersededRetries = await supersedeProviderLimitRetries(snapshot, eventContext, redisClient);
            const remainingQueuedJobs = [...snapshot.waiting, ...snapshot.delayed].filter(job => !isProviderLimitRetry(job));
            const requiresIndependentTakeover = shouldEnqueueIndependentManualTakeover(remainingQueuedJobs, manualTakeover);
            if (remainingQueuedJobs.length > 0 && !requiresIndependentTakeover) {
                await lease.assertOwned();
                await storeCommentForBatch({ ...strippedComment, ...buildPendingCommandFields(selectedCommandMeta, selection) }, commentAuthor, eventContext, { redisClient, PR_FOLLOWUP_TRIGGER_KEYWORDS: config.PR_FOLLOWUP_TRIGGER_KEYWORDS });
                correlatedLogger.info({ pullRequestNumber: prNumber, commentId: comment.id, selection }, `/${commandName} command: queued writer found, stored selected follow-up for batching`);
                acknowledgementOutcome = 'pending';
                return;
            }
            if (remainingQueuedJobs.length > 0) {
                correlatedLogger.info({ pullRequestNumber: prNumber, commentId: comment.id, selection }, `/${commandName} command: fenced automatic work will be replaced by an independent durable job`);
            }

            const updatedPRData = { branchName: prData.branchName, prLabels: transition.updatedLabels };
            await lease.assertOwned();
            await enqueueNewCommentJob(strippedComment, commentAuthor, eventContext, {
                payload, redisClient, PR_FOLLOWUP_TRIGGER_KEYWORDS: config.PR_FOLLOWUP_TRIGGER_KEYWORDS,
                MODEL_LABEL_PATTERN: config.MODEL_LABEL_PATTERN, correlationId,
                commandMeta: selectedCommandMeta, prefetchedPRData: updatedPRData, modelSelection: selection,
                commentRevisionIdentity,
            });
            correlatedLogger.info({ pullRequestNumber: prNumber, supersededRetries, selection }, `/${commandName} follow-up queued with durable model selection`);
            acknowledgementOutcome = 'queued';
        });
    } catch (error) {
        if (!(error instanceof LabelTransitionLeaseError)) throw error;
        correlatedLogger.warn({ error: error.message, pullRequestNumber: prNumber }, 'Model command failed to hold its complete PR transition lease');
        return;
    }

    if (acknowledgementOutcome) await postModelSelectionAcknowledgement(opts, selection, acknowledgementOutcome);
}

type UltrafixCommandOptions = Omit<SlashCommandHandlerOptions, 'parsedCommand'> & { commandMeta: UltrafixCommandMeta };

async function handleUltrafixCommand(opts: UltrafixCommandOptions): Promise<void> {
    const { commandMeta, comment, commentAuthor, eventContext, payload, config, correlationId, correlatedLogger } = opts;
    const { prNumber, owner, repo } = eventContext;
    const { redisClient } = config;

    correlatedLogger.info({ pullRequestNumber: prNumber, commentId: comment.id, commentAuthor }, '/ultrafix command detected, initializing loop');

    // 1. Load configured defaults from settings, then override with command arguments
    const deps = loadUltrafixDeps();
    const [dbGoal, dbMaxCycles, dbPauseSeconds, dbReviewModel] = await Promise.all([
        deps.loadUltrafixRatingGoal(),
        deps.loadUltrafixMaxCycles(),
        deps.loadUltrafixPauseSeconds(),
        deps.loadPrReviewModel(),
    ]);

    // Command args override DB defaults; undefined means "not provided by user".
    const effectiveGoal = commandMeta.goal ?? dbGoal;
    const effectiveMaxCycles = commandMeta.maxCycles ?? dbMaxCycles;
    const effectivePauseSeconds = commandMeta.pauseSeconds ?? dbPauseSeconds;
    const effectiveReviewModel = commandMeta.reviewModel ?? dbReviewModel;

    // A fresh loop must not be reinterpreted as an ordinary follow-up by the
    // worker that owns older PR work. When work is already in flight, queue a
    // conservative review behind it instead of duplicating a possibly active fix.
    const commentRevisionIdentity = getCommentRevisionIdentity(comment, eventContext.eventType);
    const strippedComment = { ...comment, body: commandMeta.instructions || '', revisionIdentity: commentRevisionIdentity };
    const existingJob = await checkExistingJob(prNumber, owner, repo);

    const octokit = await getAuthenticatedOctokit();
    let hasPendingReview = false;
    if (!existingJob) {
        const prComments = await withRetry(
            () => octokit.paginate('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', { owner, repo, issue_number: prNumber, per_page: 100 }),
            { maxAttempts: 3, baseDelay: 2000, maxDelay: 10000, exponentialBase: 2 },
            `get_pr_comments_${owner}_${repo}_${prNumber}`
        ) as Array<{ id: number; body: string | null; user: { login: string; type?: string }; created_at: string }>;
        ({ hasPendingReview } = await deps.getPendingReviewState(
            prComments,
            { repoOwner: owner, repoName: repo, pullRequestNumber: prNumber, redisClient, correlatedLogger },
        ));
    }

    const identity = { owner, repo, pr: prNumber };
    let prData: PRBranchAndLabels | undefined;
    let workEpoch: number | undefined;
    let loopMeta: UltrafixCommandMeta = commandMeta;
    let initialAction: 'review' | 'fix' = 'review';
    let labelIntroduced = false;

    // The reserved epoch fences older queued, deferred, and in-flight automatic
    // continuations. State commit and rollback are both conditional on ownership.
    try {
        let olderPrWorkExists = false;
        await withUltrafixLabelTransition(redisClient, identity, async () => {
            // Read live label state while holding the same lease used by label
            // cleanup so rollback can distinguish an inherited circuit breaker
            // from one introduced by this startup.
            prData = await getLivePRBranchAndLabels({ owner, repo, prNumber });
            const labelWasPresent = prData.prLabels.some(label => label.name === 'ultrafix');
            // Snapshot live or deferred work before reservation invalidates it.
            const hadAutomaticWork = await deps.hasAutomaticWork(redisClient, owner, repo, prNumber);
            workEpoch = await deps.reserveAutomaticWork(redisClient, owner, repo, prNumber);
            loopMeta = { ...commandMeta, workEpoch };
            // Close the gap between the first queue snapshot and reservation. Work
            // that appeared in that interval must settle before this loop reviews it.
            olderPrWorkExists = Boolean(hadAutomaticWork || existingJob || await checkExistingJob(prNumber, owner, repo));
            const startWithPendingReview = !olderPrWorkExists && hasPendingReview;
            initialAction = startWithPendingReview ? 'fix' : 'review';

            // Publish the circuit breaker before the active state. Terminal label
            // removal uses this same transition lock, so no stale teardown can
            // open a label gap around a newer epoch.
            const labelResult = await safeUpdateLabels(
                { octokit, owner, repo, issueNumber: prNumber, logger: correlatedLogger },
                [],
                ['ultrafix'],
            );
            const labelAsserted = labelResult.added.includes('ultrafix');
            if (!labelAsserted) throw new Error('Failed to add the ultrafix circuit-breaker label');
            labelIntroduced = !labelWasPresent;

            await deps.startLoop(redisClient, {
                owner,
                repo,
                pr: prNumber,
                goal: effectiveGoal,
                maxCycles: effectiveMaxCycles,
                pauseSeconds: effectivePauseSeconds,
                reviewModel: effectiveReviewModel,
                workEpoch,
            }, startWithPendingReview);
        });

        correlatedLogger.info(
            { pullRequestNumber: prNumber, initialAction, olderPrWorkExists, workEpoch, effectiveGoal, effectiveMaxCycles, effectivePauseSeconds, effectiveReviewModel },
            `/ultrafix initialized, first action: ${initialAction}`,
        );

        // 7. Build a command meta for the first action (review or fix), carrying ultrafix metadata
        const firstActionMeta: CommandMeta = initialAction === 'review'
            ? { mode: 'review', models: effectiveReviewModel ? [effectiveReviewModel] : [], instructions: commandMeta.instructions }
            : { mode: 'fix', instructions: commandMeta.instructions };

        // 8. Enqueue the first step with ultrafix metadata
        await enqueueNewCommentJob(strippedComment, commentAuthor, eventContext, {
            payload,
            redisClient,
            PR_FOLLOWUP_TRIGGER_KEYWORDS: config.PR_FOLLOWUP_TRIGGER_KEYWORDS,
            MODEL_LABEL_PATTERN: config.MODEL_LABEL_PATTERN,
            correlationId,
            commandMeta: firstActionMeta,
            prefetchedPRData: prData,
            ultrafixMeta: loopMeta,
            commentRevisionIdentity,
        });
    } catch (error) {
        correlatedLogger.error({ pullRequestNumber: prNumber, error }, '/ultrafix startup failed before job enqueue, rolling back');
        try {
            let labelRemoved = false;
            const reservedWorkEpoch = workEpoch;
            if (reservedWorkEpoch !== undefined) {
                await withUltrafixLabelTransition(redisClient, identity, async () => {
                    const cleared = await deps.clearStateIfCurrent(
                        redisClient,
                        identity,
                        reservedWorkEpoch,
                    );
                    if (cleared && labelIntroduced) {
                        const labelResult = await safeUpdateLabels(
                            { octokit, owner, repo, issueNumber: prNumber, logger: correlatedLogger },
                            ['ultrafix'],
                            [],
                        );
                        labelRemoved = labelResult.removed.includes('ultrafix');
                    }
                });
            }
            const labelNote = labelRemoved
                ? 'The ultrafix label has been removed.'
                : 'No newer Ultrafix state or label was removed.';
            await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
                owner,
                repo,
                issue_number: prNumber,
                body: `❌ **Ultrafix loop failed to start.** ${labelNote} Please try again.\n\nIf the problem persists, check the system logs for details.`,
            });
        } catch (rollbackError) {
            correlatedLogger.error({ pullRequestNumber: prNumber, rollbackError }, '/ultrafix rollback also failed');
        }
        throw error;
    }

    // 9. Post the circuit-breaker comment. State and job are already committed,
    //    so treat a comment-post failure as non-fatal — the loop will proceed
    //    regardless and the user can still stop it by removing the label.
    try {
        await withRetry(
            () => octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
                owner,
                repo,
                issue_number: prNumber,
                body: `🔄 **Ultrafix loop started** (goal: ${effectiveGoal}/10, max cycles: ${effectiveMaxCycles})\n\nFirst action: \`/${initialAction}\`\n\n> 💡 **Tip:** Remove the \`ultrafix\` label from this PR to stop further ultrafix cycles.`,
            }),
            { maxAttempts: 3, baseDelay: 2000, maxDelay: 10000, exponentialBase: 2 },
            `post_ultrafix_comment_${owner}_${repo}_${prNumber}`
        );
    } catch (commentError) {
        correlatedLogger.warn({ pullRequestNumber: prNumber, error: commentError }, '/ultrafix started successfully but failed to post the confirmation comment');
    }
}

function commentSeatConsumed(commentAuthor: string, userType: string | null | undefined, configuredBotUsernames: Set<string>): boolean {
    return userType !== 'Bot' && !configuredBotUsernames.has(commentAuthor) && !/\[bot\]$/i.test(commentAuthor);
}

function acceptedCommentDisposition(commentId: number, seatConsumed: boolean): DeliveryDisposition {
    return {
        status: 'accepted',
        billing: { seatConsumed },
        evidence: { triggerCommentIds: [commentId] },
    };
}

export async function processCommentEvent(payload: IssueCommentEvent | PullRequestReviewCommentEvent, eventType: CommentEventType, correlationId: string, config: CommentEventConfig): Promise<DeliveryDisposition> {
    const { redisClient } = config;
    const correlatedLogger = logger.withCorrelation(correlationId);
    const owner = payload.repository.owner.login;
    const repo = payload.repository.name;
    const repoFullName = `${owner}/${repo}`;

    const eventDetails = getCommentEventDetails(payload, eventType, repoFullName, correlatedLogger);
    if (!eventDetails) return { status: 'ignored', reason: 'not_pull_request_comment' };

    const { prNumber, comment } = eventDetails;

    const commentAuthor = comment.user.login;
    const parsedCommand = parseSlashCommand(comment.body);
    const configuredBotUsernames = new Set(
        [getBotUsername(), process.env.GITHUB_BOT_USERNAME, 'propr-dev[bot]']
            .filter((value): value is string => typeof value === 'string' && value.length > 0)
    );
    const isSystemUltrafixComment = parsedCommand?.command === 'ultrafix'
        && (
            configuredBotUsernames.has(commentAuthor)
        );

    const filterResult = filterCommentByAuthor(commentAuthor, comment.user.type ?? null, correlationId);
    if (filterResult.shouldFilter && !isSystemUltrafixComment) return { status: 'ignored', reason: 'filtered_author' };

    // Check for ignore keywords
    const ignoreKeywords = await loadFollowupIgnoreKeywords();
    const ignoreResult = checkCommentIgnore(comment.body, ignoreKeywords, correlationId);
    if (ignoreResult.shouldIgnore) return { status: 'ignored', reason: 'ignore_keyword' };

    // Parse slash commands (/review, /fix, /merge, /switch, /use) before generic follow-up logic
    if (parsedCommand) {
        // Deduplicate redelivered webhooks and synthetic+webhook races. This must be
        // atomic: system-created commands can be processed locally before GitHub
        // delivers the real issue_comment.created webhook for the same comment.
        const slashCommentTrackingKey = `pr-comment-processed:${owner}:${repo}:${prNumber}:${comment.id}`;
        const claimed = await claimCommentForProcessing(redisClient, slashCommentTrackingKey);
        if (!claimed) {
            correlatedLogger.debug({ repository: repoFullName, pullRequestNumber: prNumber, commentId: comment.id }, 'Slash command comment already processed, skipping redelivery');
            return { status: 'ignored', reason: 'duplicate_delivery' };
        }
        try {
            await handleSlashCommand({ parsedCommand, comment, commentAuthor, eventContext: { eventType, prNumber, owner, repo }, payload, config, correlationId, correlatedLogger });
        } catch (error) {
            await redisClient.del(slashCommentTrackingKey);
            throw error;
        }
        return acceptedCommentDisposition(comment.id, commentSeatConsumed(commentAuthor, comment.user.type ?? null, configuredBotUsernames));
    }

    // Fetch PR labels early to check for processing label
    const { prLabels } = await getPRBranchAndLabels(eventType, payload, { owner, repo, prNumber });
    const hasProcessingLabel = await prHasProcessingLabel(prLabels);

    // Check trigger: PR must have a processing label OR comment must contain trigger keyword
    const triggerResult = checkCommentTrigger(comment.body, correlationId);
    if (!hasProcessingLabel && !triggerResult.isTriggered) {
        correlatedLogger.debug({ pullRequestNumber: prNumber, commentId: comment.id }, 'PR does not have processing label and comment does not contain trigger keyword, skipping');
        return { status: 'ignored', reason: 'no_comment_trigger' };
    }

    if (hasProcessingLabel) {
        correlatedLogger.debug({ pullRequestNumber: prNumber, commentId: comment.id, prLabels: prLabels.map(l => l.name) }, 'PR has processing label, processing comment');
    }

    const commentTrackingKey = `pr-comment-processed:${owner}:${repo}:${prNumber}:${comment.id}`;
    const alreadyQueued = await redisClient.get(commentTrackingKey);
    if (alreadyQueued) {
        correlatedLogger.debug({ repository: repoFullName, pullRequestNumber: prNumber, commentId: comment.id, commentAuthor }, 'PR comment already queued/processed, skipping');
        return { status: 'ignored', reason: 'duplicate_delivery' };
    }

    const existingJob = await checkExistingJob(prNumber, owner, repo);
    if (existingJob) {
        await storeCommentForBatch(comment, commentAuthor, { eventType, prNumber, owner, repo }, config as StoreCommentConfig);
        correlatedLogger.info({ pullRequestNumber: prNumber, repository: repoFullName, commentId: comment.id }, 'A job for this PR is already active or waiting, stored comment for batch processing');
        return acceptedCommentDisposition(comment.id, commentSeatConsumed(commentAuthor, comment.user.type ?? null, configuredBotUsernames));
    }

    await enqueueNewCommentJob(comment, commentAuthor, { eventType, prNumber, owner, repo }, { payload, redisClient, PR_FOLLOWUP_TRIGGER_KEYWORDS: config.PR_FOLLOWUP_TRIGGER_KEYWORDS, MODEL_LABEL_PATTERN: config.MODEL_LABEL_PATTERN, correlationId });
    return acceptedCommentDisposition(comment.id, commentSeatConsumed(commentAuthor, comment.user.type ?? null, configuredBotUsernames));
}

async function checkExistingJob(prNumber: number, owner: string, repo: string): Promise<boolean> {
    const existingJobs = await getExistingPRCommentJobs(prNumber, owner, repo);
    return existingJobs.length > 0;
}

async function getExistingPRCommentJobs(prNumber: number, owner: string, repo: string): Promise<Job<PRJobData>[]> {
    const snapshot = await getPRCommentJobSnapshot(prNumber, owner, repo);
    return [...snapshot.active, ...snapshot.waiting, ...snapshot.delayed];
}

async function getPRCommentJobSnapshot(prNumber: number, owner: string, repo: string): Promise<PRCommentJobSnapshot> {
    const queue = await getIssueQueue();
    const [activeJobs, waitingJobs, delayedJobs] = await Promise.all([
        queue.getActive(),
        queue.getWaiting(),
        queue.getDelayed(),
    ]);
    const belongsToPR = (job: Job<PRJobData>): boolean => job.name === 'processPullRequestComment'
        && job.data.pullRequestNumber === prNumber
        && job.data.repoOwner === owner
        && job.data.repoName === repo;
    return {
        active: (activeJobs as Job<PRJobData>[]).filter(belongsToPR),
        waiting: (waitingJobs as Job<PRJobData>[]).filter(belongsToPR),
        delayed: (delayedJobs as Job<PRJobData>[]).filter(belongsToPR),
    };
}

function shouldEnqueueIndependentManualTakeover(
    existingJobs: Job<PRJobData>[],
    manualTakeover: ManualCommandTakeover | null,
): boolean {
    if (manualTakeover === null) return false;
    const hasCurrentManualJob = existingJobs.some(job =>
        !job.data.ultrafixMeta
        && (job.data.commandMode === 'fix' || job.data.commandMode === 'review')
    );
    if (hasCurrentManualJob) return false;

    return manualTakeover.hadAutomaticWork || existingJobs.some(job =>
        job.data.ultrafixMeta != null
        && (job.data.ultrafixMeta.workEpoch ?? 0) < manualTakeover.workEpoch
    );
}

async function storeCommentForBatch(comment: BatchComment, commentAuthor: string, eventContext: CommentContext, config: StoreCommentConfig): Promise<void> {
    const { eventType, prNumber, owner, repo } = eventContext;
    const { redisClient, PR_FOLLOWUP_TRIGGER_KEYWORDS } = config;
    const pendingCommentsKey = getPendingPrCommentsKey(owner, repo, prNumber);
    const strippedCommentBody = PR_FOLLOWUP_TRIGGER_KEYWORDS.length > 0 ? stripKeywordsFromBody(comment.body, PR_FOLLOWUP_TRIGGER_KEYWORDS) : comment.body;
    const reviewComment = isReviewComment(comment, eventType);
    let pendingCommentBody = strippedCommentBody;

    if (reviewComment) {
        const codeContext = buildCodeContext(comment);
        if (codeContext.length > 0) pendingCommentBody = `${pendingCommentBody}\n\n--- Review Comment Context ---\n${codeContext.join('\n')}`;
    }

    const pendingComment: UnprocessedComment = {
        id: comment.id,
        createdAt: comment.created_at,
        updatedAt: comment.updated_at,
        revisionIdentity: comment.revisionIdentity ?? getUnprocessedCommentRevisionIdentity({
            updatedAt: comment.updated_at,
            body: comment.body,
            type: reviewComment ? 'review' : 'issue',
        }),
        body: pendingCommentBody,
        author: commentAuthor,
        type: reviewComment ? 'review' : 'issue',
        hasCodeContext: reviewComment && !!comment.diff_hunk,
        commandMeta: comment.commandMeta,
        commandMode: comment.commandMode,
        requestedModels: comment.requestedModels,
        commandInstructions: comment.commandInstructions,
        llmOverride: comment.llmOverride,
        agentAlias: comment.agentAlias,
        modelName: comment.modelName,
        modelLabel: comment.modelLabel,
        ultrafixMeta: comment.ultrafixMeta,
    };
    await redisClient.rpush(pendingCommentsKey, JSON.stringify(pendingComment));
    await redisClient.expire(pendingCommentsKey, 3600);
}

async function getPRBranchAndLabels(eventType: CommentEventType, payload: IssueCommentEvent | PullRequestReviewCommentEvent, repoContext: RepoContext): Promise<PRBranchAndLabels> {
    if (eventType === 'issue_comment') {
        return getLivePRBranchAndLabels(repoContext);
    }
    const prPayload = payload as PullRequestReviewCommentEvent;
    return { branchName: prPayload.pull_request.head.ref, prLabels: prPayload.pull_request.labels || [] };
}

async function getLivePRBranchAndLabels(repoContext: RepoContext): Promise<PRBranchAndLabels> {
    const { owner, repo, prNumber } = repoContext;
    const octokit = await getAuthenticatedOctokit();
    // Retry up to ~1 minute: 3s + 6s + 12s + 20s + 20s = 61s total
    const { data: pr } = await withRetry(
        () => octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', { owner, repo, pull_number: prNumber }),
        { maxAttempts: 6, baseDelay: 3000, maxDelay: 20000, exponentialBase: 2 },
        `get_pr_details_${owner}_${repo}_${prNumber}`
    );
    return { branchName: pr.head.ref, prLabels: pr.labels || [] };
}

function prepareComment(
    comment: { id: number; created_at: string; updated_at: string; body: string; path?: string; line?: number | null; diff_hunk?: string; pull_request_review_id?: number },
    commentAuthor: string,
    eventType: CommentEventType,
    options: { keywords: string[]; revisionIdentity?: string },
): { enhancedBody: string; unprocessedComment: UnprocessedComment; llmFromKeywords: string | null } {
    const { keywords, revisionIdentity } = options;
    const llmFromKeywords = keywords.length > 0 ? extractLlmFromKeywords(comment.body, keywords) : null;
    let enhancedBody = keywords.length > 0 ? stripKeywordsFromBody(comment.body, keywords) : comment.body;

    if (isReviewComment(comment, eventType)) {
        const codeContext = buildCodeContext(comment);
        if (codeContext.length > 0) enhancedBody = `${enhancedBody}\n\n--- Review Comment Context ---\n${codeContext.join('\n')}`;
    }

    const commentType = isReviewComment(comment, eventType) ? 'review' as const : 'issue' as const;
    const unprocessedComment: UnprocessedComment = {
        id: comment.id,
        createdAt: comment.created_at,
        updatedAt: comment.updated_at,
        revisionIdentity: revisionIdentity ?? getUnprocessedCommentRevisionIdentity({ updatedAt: comment.updated_at, body: comment.body, type: commentType }),
        body: enhancedBody,
        author: commentAuthor,
        type: commentType,
        hasCodeContext: commentType === 'review' && !!comment.diff_hunk,
    };
    return { enhancedBody, unprocessedComment, llmFromKeywords };
}

function resolveLlm(llmFromKeywords: string | null, prLabels: Label[], options: { modelLabelPattern: string; prNumber: number; correlatedLogger: ReturnType<typeof logger.withCorrelation>; commandMeta?: CommandMeta }): string | null {
    const { modelLabelPattern, prNumber, correlatedLogger, commandMeta } = options;
    let llm = llmFromKeywords;
    if (!llm && prLabels.length > 0) llm = extractLlmFromLabels(prLabels, modelLabelPattern, prNumber, correlatedLogger);

    if (commandMeta && (commandMeta.mode === 'switch' || commandMeta.mode === 'use') && commandMeta.models.length > 0) {
        const resolvedModel = resolveModelAlias(commandMeta.models[0]);
        correlatedLogger.info({ pullRequestNumber: prNumber, commandMode: commandMeta.mode, resolvedModel }, `Overriding LLM from /${commandMeta.mode} command`);
        llm = resolvedModel;
    }
    return llm;
}

/**
 * Build flattened job fields from structured CommandMeta for queue serialization.
 *
 * Note: downstream job processing (processPullRequestCommentJob) only branches
 * on 'review' and 'fix' modes. The 'switch' and 'use' modes intentionally fall
 * through to the default processing path — the model override is already resolved
 * via resolveLlm() before enqueuing, so no special downstream handling is needed.
 */
function buildCommandJobFields(commandMeta: CommandMeta): CommandJobFields {
    const commandMode = commandMeta.mode === 'review'
        || commandMeta.mode === 'fix'
        || commandMeta.mode === 'switch'
        || commandMeta.mode === 'use'
        || commandMeta.mode === 'ultrafix'
        ? commandMeta.mode
        : 'default';

    const requestedModels = commandMeta.mode === 'review'
        ? commandMeta.models
        : commandMeta.mode === 'use' && commandMeta.models.length > 0
            ? [resolveModelAlias(commandMeta.models[0])]
            : undefined;

    return {
        commandMeta,
        commandMode,
        requestedModels,
        commandInstructions: 'instructions' in commandMeta ? commandMeta.instructions : undefined,
    };
}

function buildPendingCommandFields(commandMeta: CommandMeta, modelSelection?: CanonicalModelSelection): Pick<UnprocessedComment, 'commandMeta' | 'commandMode' | 'requestedModels' | 'commandInstructions' | 'llmOverride' | 'agentAlias' | 'modelName' | 'modelLabel'> {
    return {
        ...buildCommandJobFields(commandMeta),
        llmOverride: (commandMeta.mode === 'switch' || commandMeta.mode === 'use') && commandMeta.models.length > 0
            ? resolveModelAlias(commandMeta.models[0])
            : undefined,
        agentAlias: modelSelection?.agentAlias,
        modelName: modelSelection?.model,
        modelLabel: modelSelection?.githubLabel,
    };
}

async function enqueueNewCommentJob(comment: { id: number; created_at: string; updated_at: string; body: string; path?: string; line?: number | null; diff_hunk?: string; pull_request_review_id?: number }, commentAuthor: string, eventContext: CommentContext, options: EnqueueCommentOptions): Promise<void> {
    const { eventType, prNumber, owner, repo } = eventContext;
    const { payload, redisClient, PR_FOLLOWUP_TRIGGER_KEYWORDS, correlationId, MODEL_LABEL_PATTERN = '^llm-(.+)$', commandMeta, prefetchedPRData, ultrafixMeta, commentRevisionIdentity, modelSelection, pendingOnly = false } = options;
    const correlatedLogger = logger.withCorrelation(correlationId);

    const { unprocessedComment, llmFromKeywords } = prepareComment(comment, commentAuthor, eventType, {
        keywords: PR_FOLLOWUP_TRIGGER_KEYWORDS,
        revisionIdentity: commentRevisionIdentity,
    });
    const { branchName, prLabels } = prefetchedPRData || await getPRBranchAndLabels(eventType, payload, { owner, repo, prNumber });
    const llm = modelSelection?.model ?? resolveLlm(llmFromKeywords, prLabels, { modelLabelPattern: MODEL_LABEL_PATTERN, prNumber, correlatedLogger, commandMeta });

    const jobData: CommentJobData = {
        pullRequestNumber: prNumber, comments: pendingOnly ? [] : [unprocessedComment], repoOwner: owner, repoName: repo, branchName, llm, correlationId: generateCorrelationId(),
        ...(modelSelection ? { agentAlias: modelSelection.agentAlias, modelName: modelSelection.model, modelLabel: modelSelection.githubLabel } : {}),
        ...(commandMeta ? {
            ...buildCommandJobFields(commandMeta),
            commandCommentId: comment.id,
            commandCommentCreatedAt: comment.created_at,
            commandCommentUpdatedAt: comment.updated_at,
            commandCommentRevisionIdentity: unprocessedComment.revisionIdentity,
            commandCommentType: unprocessedComment.type,
        } : {}),
        ...(ultrafixMeta ? { ultrafixMeta } : {}),
    };
    const deterministicCommand = commandMeta != null;
    const commentRevisionSlug = (commentRevisionIdentity ?? getCommentRevisionIdentity(comment, eventType)).replace(/[^a-zA-Z0-9_-]/g, '-');
    const jobId = deterministicCommand
        ? `pr-comments-batch-${owner}-${repo}-${prNumber}-${comment.id}-${commentRevisionSlug}`
        : `pr-comments-batch-${owner}-${repo}-${prNumber}-${Date.now()}`;
    const commentTrackingKey = `pr-comment-processed:${owner}:${repo}:${prNumber}:${comment.id}`;

    try {
        const queue = await getIssueQueue();
        await queue.add('processPullRequestComment', jobData, {
            jobId,
            delay: COMMENT_BATCH_DELAY_MS,
            attempts: 3,
            backoff: { type: 'exponential', delay: 10000 },  // 10s, 20s, 40s
        });
    } catch (error) {
        const err = error as Error;
        if (err.message?.includes('Job already exists')) correlatedLogger.warn({ pullRequestNumber: prNumber }, 'PR comment job ID already exists; surfacing enqueue failure');
        else handleError(error, `Failed to add PR comment to queue`, { correlationId });
        throw error;
    }

    try {
        await redisClient.setex(commentTrackingKey, 86400, Date.now().toString());
    } catch (error) {
        // The queue insertion above is the durable handoff. Do not report it as
        // failed (or skip takeover invalidation) merely because refreshing the
        // comment-tracking TTL failed afterward.
        handleError(error, 'PR comment job was queued but its tracking TTL could not be refreshed', { correlationId });
    }
    correlatedLogger.info({ jobId, pullRequestNumber: prNumber, commentId: comment.id, commentType: unprocessedComment.type, delayMs: COMMENT_BATCH_DELAY_MS }, `Successfully added PR comment job with ${COMMENT_BATCH_DELAY_MS}ms delay`);
}
