/* eslint-disable max-lines */
import logger, { generateCorrelationId } from '../utils/logger.js';
import { handleError } from '../utils/errorHandler.js';
import { getIssueQueue, COMMENT_BATCH_DELAY_MS, type CommentJobData, type UnprocessedComment } from '../queue/taskQueue.js';
import { filterCommentByAuthor, checkCommentTrigger, checkCommentIgnore } from '../utils/commentFilters.js';
import { loadFollowupIgnoreKeywords, loadPrimaryProcessingLabels } from '../config/configManager.js';
import { getAuthenticatedOctokit } from '../auth/githubAuth.js';
import { getPendingPrCommentsKey } from '../utils/constants.js';
import { withRetry } from '../utils/retryHandler.js';
import type { Job } from 'bullmq';
import type { Redis } from 'ioredis';
import type { IssueCommentEvent, PullRequestReviewCommentEvent, Label } from '@octokit/webhooks-types';
import { extractLlmFromKeywords, stripKeywordsFromBody, buildCodeContext, isReviewComment, extractLlmFromLabels, modelLabelPrefix } from './commentEventHelpers.js';
import { handleMergeCommand } from './mergeConflictDetector.js';
import { parseSlashCommand, buildCommandMeta } from './slashCommandParser.js';
import type { CommandMeta, UltrafixCommandMeta } from './slashCommandParser.js';
import { safeUpdateLabels } from '../utils/github/labelOperations.js';
import { resolveModelAlias } from '../config/modelAliases.js';
import { MODEL_INFO_MAP } from '../config/modelDefinitions.js';
import { getBotUsername } from '../daemon/configLoader.js';
import { AgentRegistry } from '../agents/AgentRegistry.js';
import type { DeliveryDisposition } from '../intake/routingWebSocketProtocol.js';
import { createHash } from 'node:crypto';

export interface UltrafixDeps {
    loadUltrafixRatingGoal: () => Promise<number>;
    loadUltrafixMaxCycles: () => Promise<number>;
    loadUltrafixPauseSeconds: () => Promise<number>;
    loadPrReviewModel: () => Promise<string>;
    beginManualTakeover: (redis: Redis, identity: { owner: string; repo: string; pr: number }, commandSequence: number) => Promise<boolean>;
    abortManualTakeover: (redis: Redis, identity: { owner: string; repo: string; pr: number }, commandSequence: number) => Promise<boolean>;
    completeManualTakeover: (redis: Redis, identity: { owner: string; repo: string; pr: number }, commandSequence: number) => Promise<number | null>;
    reserveFreshTransition: (redis: Redis, identity: { owner: string; repo: string; pr: number }, commandSequence: number) => Promise<{ generation: number; baseGeneration: number } | null>;
    commitFreshLoop: (redis: Redis, options: { owner: string; repo: string; pr: number; commandSequence: number; generation: number; baseGeneration: number; goal?: number; maxCycles?: number; pauseSeconds?: number; reviewModel?: string }, hasPendingReviews: boolean) => Promise<{ state: unknown; initialAction: 'review' | 'fix' } | null>;
    abortFreshTransition: (redis: Redis, identity: { owner: string; repo: string; pr: number }, commandSequence: number) => Promise<boolean>;
    withTransitionLease: <T>(redis: Redis, identity: { owner: string; repo: string; pr: number }, correlationId: string, operation: (assertOwned: () => Promise<void>) => Promise<T>) => Promise<T>;
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

async function isKnownOrConfiguredModel(model: string): Promise<boolean> {
    if (MODEL_INFO_MAP[model]) {
        return true;
    }

    try {
        const registry = AgentRegistry.getInstance();
        await registry.ensureInitialized();
        return registry.getAllAgents().some(agent =>
            agent.config.enabled && agent.config.supportedModels.some(
                supportedModel => supportedModel.toLowerCase() === model.toLowerCase()
            )
        );
    } catch {
        return false;
    }
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
interface StoreCommentConfig { redisClient: Redis; PR_FOLLOWUP_TRIGGER_KEYWORDS: string[]; takeoverStageKey?: string; takeoverSequence?: number }
interface EnqueueCommentOptions { payload: IssueCommentEvent | PullRequestReviewCommentEvent; redisClient: Redis; PR_FOLLOWUP_TRIGGER_KEYWORDS: string[]; MODEL_LABEL_PATTERN?: string; correlationId: string; commandMeta?: CommandMeta; prefetchedPRData?: PRBranchAndLabels; ultrafixMeta?: UltrafixCommandMeta; throwOnQueueFailure?: boolean; idempotentJobId?: string; delayMs?: number }
interface RepoContext { owner: string; repo: string; prNumber: number }
interface PRBranchAndLabels { branchName: string; prLabels: Label[] }
interface ManualTakeoverContext {
    deps: UltrafixDeps;
    takeoverStageKey: string;
    commandSequence: number;
    assertTransitionOwned: () => Promise<void>;
}
type BatchComment = Pick<UnprocessedComment, 'id' | 'body' | 'commandMeta' | 'commandMode' | 'requestedModels' | 'commandInstructions' | 'llmOverride' | 'ultrafixMeta' | 'commandSequence'> & { path?: string; line?: number | null; diff_hunk?: string; pull_request_review_id?: number };
type CommandJobFields = Pick<CommentJobData, 'commandMeta' | 'commandMode' | 'requestedModels' | 'commandInstructions'>;
type QueuedCommandMeta = Extract<CommandMeta, { mode: 'review' | 'fix' | 'use' }>;
type PRComment = { id: number; body: string; user: { login: string; type?: string }; updated_at?: string; path?: string; line?: number | null; diff_hunk?: string; pull_request_review_id?: number; commandSequence?: number };

const TAKEOVER_STAGE_TTL_SECONDS = 86400;
const FRESH_STARTUP_JOB_DELAY_MS = 30_000;
const ASSIGN_COMMAND_SEQUENCE_SCRIPT = `
local existing = redis.call('GET', KEYS[1])
if existing then
    return existing
end
local sequence = redis.call('INCR', KEYS[2])
redis.call('SET', KEYS[1], sequence, 'EX', ARGV[1])
return sequence
`;
const STORE_PENDING_TAKEOVER_SCRIPT = `
redis.call('RPUSH', KEYS[1], ARGV[1])
redis.call('EXPIRE', KEYS[1], ARGV[2])
redis.call('SET', KEYS[2], ARGV[4], 'EX', ARGV[3])
return 1
`;
const DELETE_TAKEOVER_STAGE_IF_SEQUENCE_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then
    return 0
end
redis.call('DEL', KEYS[1])
return 1
`;

async function claimCommentForProcessing(redisClient: Redis, key: string): Promise<boolean> {
    const result = await redisClient.set(key, Date.now().toString(), 'EX', 86400, 'NX');
    return result === 'OK';
}

async function deleteTakeoverStageIfSequence(
    redisClient: Redis,
    stageKey: string,
    commandSequence: number,
): Promise<boolean> {
    return Number(await redisClient.eval(
        DELETE_TAKEOVER_STAGE_IF_SEQUENCE_SCRIPT,
        1,
        stageKey,
        String(commandSequence),
    )) === 1;
}

async function getOrAssignCommandSequence(
    redisClient: Redis,
    identity: RepoContext & { eventType: CommentEventType; commentId: number; updatedAt?: string; body: string },
): Promise<number> {
    const identitySuffix = `${identity.owner}:${identity.repo}:${identity.prNumber}`;
    // GitHub keeps a comment ID stable across edits. Key the allocation by the
    // revision timestamp as well, so a genuine redelivery reuses its sequence
    // while an edited command receives a new position in the PR command order.
    const bodyRevision = createHash('sha256').update(identity.body).digest('hex').slice(0, 16);
    const revision = `${identity.updatedAt ?? 'original'}:${bodyRevision}`;
    const sequenceKey = `pr-command-order:${identitySuffix}:${identity.eventType}:${identity.commentId}:${revision}`;
    const counterKey = `pr-command-sequence:${identitySuffix}`;
    return Number(await redisClient.eval(
        ASSIGN_COMMAND_SEQUENCE_SCRIPT,
        2,
        sequenceKey,
        counterKey,
        String(TAKEOVER_STAGE_TTL_SECONDS),
    ));
}

interface CommentKeyIdentity {
    owner: string;
    repo: string;
    prNumber: number;
    eventType: CommentEventType;
    commentId: number;
}

function getCommentTrackingKey(identity: CommentKeyIdentity): string {
    const { owner, repo, prNumber, eventType, commentId } = identity;
    return `pr-comment-processed:${owner}:${repo}:${prNumber}:${eventType}:${commentId}`;
}

function getTakeoverStageKey(identity: CommentKeyIdentity): string {
    const { owner, repo, prNumber, eventType, commentId } = identity;
    return `pr-command-takeover:${owner}:${repo}:${prNumber}:${eventType}:${commentId}`;
}

function getManualTakeoverJobId(identity: CommentKeyIdentity, commandSequence: number): string {
    const { owner, repo, prNumber, eventType, commentId } = identity;
    return `pr-comments-command-${owner}-${repo}-${prNumber}-${eventType}-${commentId}-${commandSequence}`;
}

async function hasDurableManualTakeoverReplacement(
    redisClient: Redis,
    identity: CommentKeyIdentity,
    commandSequence: number,
): Promise<boolean> {
    if (await (await getIssueQueue()).getJob(getManualTakeoverJobId(identity, commandSequence))) return true;
    const pending = await redisClient.lrange(
        getPendingPrCommentsKey(identity.owner, identity.repo, identity.prNumber), 0, -1,
    );
    return pending.some(serialized => {
        try {
            const comment = JSON.parse(serialized) as { commandSequence?: number };
            return comment.commandSequence === commandSequence;
        } catch {
            return false;
        }
    });
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
            const taskId = job.id?.startsWith('pr-comments-batch-') ? job.id.replace(/^pr-comments-batch-/, '').replace(/-\d+$/, '') : `${owner}-${repo}-${prNumber}`;
            await redisClient.set(`worker:abort:${taskId}`, JSON.stringify({ timestamp: new Date().toISOString(), reason: 'comment_deleted', commentId }), 'EX', 3600);
            await job.remove();
            correlatedLogger.info({ jobId: job.id, taskId }, 'Job aborted and removed from queue');
        }
    }
    await redisClient.del(getCommentTrackingKey({ owner, repo, prNumber, eventType, commentId }));
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
        const taskId = foundJob.id?.startsWith('pr-comments-batch-') ? foundJob.id.replace(/^pr-comments-batch-/, '').replace(/-\d+$/, '') : `${owner}-${repo}-${prNumber}`;
        await redisClient.set(`worker:abort:${taskId}`, JSON.stringify({ timestamp: new Date().toISOString(), reason: 'comment_edited', commentId }), 'EX', 3600);
        await foundJob.remove();
    }

    await redisClient.del(getCommentTrackingKey({ owner, repo, prNumber, eventType, commentId }));
    correlatedLogger.info({ pullRequestNumber: prNumber, repository: repoFullName, commentId }, 'Reprocessing edited comment');
    if (processCommentEventFn) await processCommentEventFn(payload, eventType, correlationId, config);
}

interface SlashCommandComment { id: number; body: string; updated_at?: string; path?: string; line?: number | null; diff_hunk?: string; pull_request_review_id?: number; commandSequence?: number }

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

    if (commandMeta.mode === 'switch') {
        await handleSwitchCommand({ commandMeta, comment, commentAuthor, eventContext, payload, config, correlationId, correlatedLogger });
        return;
    }

    if (commandMeta.mode === 'use' && commandMeta.models.length === 0) {
        correlatedLogger.warn({ pullRequestNumber: prNumber, commentId: comment.id, commentAuthor }, '/use command requires a model argument, ignoring');
        return;
    }

    if (commandMeta.mode === 'use' && commandMeta.models.length > 0) {
        const resolvedModel = resolveModelAlias(commandMeta.models[0]);
        if (!await isKnownOrConfiguredModel(resolvedModel)) {
            correlatedLogger.warn({ pullRequestNumber: prNumber, invalidModels: [resolvedModel] }, '/use command contains unrecognized model(s), ignoring');
            return;
        }
    }

    await handleQueuedSlashCommand(opts, commandMeta);
}

async function handleQueuedSlashCommand(
    opts: SlashCommandHandlerOptions,
    commandMeta: QueuedCommandMeta,
): Promise<void> {
    const { comment, eventContext, config, correlationId, correlatedLogger } = opts;
    const { prNumber, owner, repo, eventType } = eventContext;
    const { redisClient } = config;
    const takeoverDeps = (commandMeta.mode === 'fix' || commandMeta.mode === 'review')
        ? _ultrafixDeps
        : null;
    const takeoverStageKey = takeoverDeps
        ? getTakeoverStageKey({ owner, repo, prNumber, eventType, commentId: comment.id })
        : undefined;
    const stagedSequence = takeoverStageKey
        ? await redisClient.get(takeoverStageKey)
        : null;
    const takeoverIdentity = { owner, repo, prNumber, eventType, commentId: comment.id };
    const commandSequence = comment.commandSequence ?? 0;
    if (takeoverDeps && takeoverStageKey && stagedSequence) {
        const stagedCommandSequence = Number(stagedSequence);
        if (stagedCommandSequence > commandSequence) {
            correlatedLogger.info(
                { pullRequestNumber: prNumber, commentId: comment.id, commandSequence, stagedCommandSequence },
                'Ignored command revision superseded by a newer staged takeover',
            );
            return;
        }
        const durable = await hasDurableManualTakeoverReplacement(
            redisClient, takeoverIdentity, stagedCommandSequence,
        );
        if (durable) {
            await cancelDeferredUltrafixTransition(takeoverDeps, {
                redisClient, owner, repo, prNumber, correlationId, correlatedLogger,
                takeoverStageKey, commandSequence: stagedCommandSequence,
            });
            correlatedLogger.info(
                { pullRequestNumber: prNumber, commentId: comment.id, stagedCommandSequence },
                'Resumed cancellation for an already scheduled manual takeover',
            );
            if (stagedCommandSequence === commandSequence) return;
        }
    }
    if (!takeoverDeps || !takeoverStageKey) {
        await scheduleQueuedSlashCommand(opts, commandMeta);
        return;
    }

    await takeoverDeps.withTransitionLease(
        redisClient,
        { owner, repo, pr: prNumber },
        correlationId,
        async assertTransitionOwned => {
            await assertTransitionOwned();
            if (!await takeoverDeps.beginManualTakeover(
                redisClient, { owner, repo, pr: prNumber }, commandSequence,
            )) {
                correlatedLogger.info(
                    { pullRequestNumber: prNumber, commentId: comment.id, commandSequence },
                    'Ignored stale manual takeover command',
                );
                return;
            }
            // Persist the recovery marker before scheduling. A daemon sweep can
            // now finish the generation takeover after a process exit by
            // verifying the deterministic queue job or pending batch entry.
            await redisClient.set(
                takeoverStageKey,
                String(commandSequence),
                'EX',
                TAKEOVER_STAGE_TTL_SECONDS,
            );
            await scheduleQueuedSlashCommand(opts, commandMeta, {
                deps: takeoverDeps,
                takeoverStageKey,
                commandSequence,
                assertTransitionOwned,
            });
        },
    );
}

async function scheduleQueuedSlashCommand(
    opts: SlashCommandHandlerOptions,
    commandMeta: QueuedCommandMeta,
    takeover?: ManualTakeoverContext,
): Promise<void> {
    const { comment, commentAuthor, eventContext, payload, config, correlationId, correlatedLogger } = opts;
    const { prNumber, owner, repo } = eventContext;
    const { redisClient } = config;
    const deterministicJobId = takeover
        ? getManualTakeoverJobId(
            { owner, repo, prNumber, eventType: eventContext.eventType, commentId: comment.id },
            takeover.commandSequence,
        )
        : undefined;
    let replacementScheduled = false;
    try {
        if (takeover && deterministicJobId) {
            const existingReplacement = await (await getIssueQueue()).getJob(deterministicJobId);
            if (existingReplacement) {
                await redisClient.set(
                    takeover.takeoverStageKey,
                    String(takeover.commandSequence),
                    'EX',
                    TAKEOVER_STAGE_TTL_SECONDS,
                );
                replacementScheduled = true;
                await finalizeManualUltrafixTakeover(takeover, {
                    redisClient, owner, repo, prNumber, correlatedLogger,
                });
                correlatedLogger.info(
                    { pullRequestNumber: prNumber, commentId: comment.id },
                    'Recovered an already queued manual takeover',
                );
                return;
            }
        }
        correlatedLogger.info({ pullRequestNumber: prNumber, commentId: comment.id, commentAuthor, command: commandMeta.mode }, `/${commandMeta.mode} command detected, enqueuing job`);
        // Strip the slash command line from the comment body so the downstream job
        // only sees the user's instructions, not the control syntax (consistent with /switch).
        const strippedComment = { ...comment, body: commandMeta.instructions || '' };

        // Check for existing active/waiting jobs for this PR (batching/concurrency guard)
        const existingJob = await checkExistingJob(prNumber, owner, repo);
        if (existingJob) {
            await storeCommentForBatch(
                { ...strippedComment, ...buildPendingCommandFields(commandMeta) },
                commentAuthor,
                eventContext,
                {
                    redisClient,
                    PR_FOLLOWUP_TRIGGER_KEYWORDS: config.PR_FOLLOWUP_TRIGGER_KEYWORDS,
                    takeoverStageKey: takeover?.takeoverStageKey,
                    takeoverSequence: takeover?.commandSequence,
                },
            );
            replacementScheduled = true;
            if (takeover) {
                await finalizeManualUltrafixTakeover(takeover, {
                    redisClient, owner, repo, prNumber, correlatedLogger,
                });
            }
            correlatedLogger.info({ pullRequestNumber: prNumber, commentId: comment.id, command: commandMeta.mode }, `/${commandMeta.mode} command: existing job found for PR, stored comment for batch processing`);
            return;
        }

        await enqueueNewCommentJob(strippedComment, commentAuthor, eventContext, {
            payload,
            redisClient,
            PR_FOLLOWUP_TRIGGER_KEYWORDS: config.PR_FOLLOWUP_TRIGGER_KEYWORDS,
            MODEL_LABEL_PATTERN: config.MODEL_LABEL_PATTERN,
            correlationId,
            commandMeta,
            throwOnQueueFailure: !!takeover,
            idempotentJobId: deterministicJobId,
        });
        replacementScheduled = true;
        if (takeover) {
            await finalizeManualUltrafixTakeover(takeover, {
                redisClient, owner, repo, prNumber, correlatedLogger,
            });
        }
    } catch (error) {
        if (takeover) {
            await abortUnscheduledManualTakeover(takeover, {
                redisClient, owner, repo, prNumber, correlatedLogger,
                eventType: eventContext.eventType,
                commentId: comment.id,
                replacementScheduled,
            });
        }
        throw error;
    }
}

async function abortUnscheduledManualTakeover(
    takeover: ManualTakeoverContext,
    options: {
        redisClient: Redis; owner: string; repo: string; prNumber: number;
        correlatedLogger: ReturnType<typeof logger.withCorrelation>;
        eventType: CommentEventType;
        commentId: number;
        replacementScheduled: boolean;
    },
): Promise<void> {
    const {
        redisClient, owner, repo, prNumber, correlatedLogger,
        replacementScheduled,
    } = options;
    if (replacementScheduled) return;
    try {
        const durable = await hasDurableManualTakeoverReplacement(
            redisClient,
            {
                owner,
                repo,
                prNumber,
                eventType: options.eventType,
                commentId: options.commentId,
            },
            takeover.commandSequence,
        );
        if (durable) return;
    } catch (stageError) {
        correlatedLogger.warn({ stageError, prNumber }, 'Could not verify manual takeover stage; preserving fence');
        return;
    }
    await takeover.assertTransitionOwned();
    await deleteTakeoverStageIfSequence(
        redisClient, takeover.takeoverStageKey, takeover.commandSequence,
    );
    await takeover.deps.abortManualTakeover(
        redisClient, { owner, repo, pr: prNumber }, takeover.commandSequence,
    );
}

async function finalizeManualUltrafixTakeover(
    takeover: ManualTakeoverContext,
    options: {
        redisClient: Redis; owner: string; repo: string; prNumber: number;
        correlatedLogger: ReturnType<typeof logger.withCorrelation>;
    },
): Promise<void> {
    const { redisClient, owner, repo, prNumber, correlatedLogger } = options;
    await takeover.assertTransitionOwned();
    const generation = await takeover.deps.completeManualTakeover(
        redisClient, { owner, repo, pr: prNumber }, takeover.commandSequence,
    );
    await deleteTakeoverStageIfSequence(
        redisClient, takeover.takeoverStageKey, takeover.commandSequence,
    );
    logManualTakeoverResult(generation, takeover.commandSequence, prNumber, correlatedLogger);
}

async function cancelDeferredUltrafixTransition(
    deps: UltrafixDeps,
    options: {
        redisClient: Redis;
        owner: string;
        repo: string;
        prNumber: number;
        correlationId: string;
        correlatedLogger: ReturnType<typeof logger.withCorrelation>;
        takeoverStageKey?: string;
        commandSequence: number;
    },
): Promise<void> {
    const { redisClient, owner, repo, prNumber, correlationId, correlatedLogger, commandSequence } = options;
    const generation = await deps.withTransitionLease(
        redisClient,
        { owner, repo, pr: prNumber },
        correlationId,
        async assertOwned => {
            await assertOwned();
            const completedGeneration = await deps.completeManualTakeover(
                redisClient, { owner, repo, pr: prNumber }, commandSequence,
            );
            if (options.takeoverStageKey) {
                await deleteTakeoverStageIfSequence(
                    redisClient, options.takeoverStageKey, commandSequence,
                );
            }
            return completedGeneration;
        },
    );
    logManualTakeoverResult(generation, commandSequence, prNumber, correlatedLogger);
}

function logManualTakeoverResult(
    generation: number | null,
    commandSequence: number,
    prNumber: number,
    correlatedLogger: ReturnType<typeof logger.withCorrelation>,
): void {
    if (generation === null) {
        correlatedLogger.info(
            { pullRequestNumber: prNumber, commandSequence },
            'Manual takeover was superseded by a newer action',
        );
        return;
    }
    correlatedLogger.info(
        { pullRequestNumber: prNumber },
        'Durably scheduled manual command and cancelled any deferred ultrafix transition',
    );
}

type SwitchCommandOptions = Omit<SlashCommandHandlerOptions, 'parsedCommand'> & { commandMeta: CommandMeta & { mode: 'switch' } };

async function handleSwitchCommand(opts: SwitchCommandOptions): Promise<void> {
    const { commandMeta, comment, commentAuthor, eventContext, payload, config, correlationId, correlatedLogger } = opts;
    const { eventType, prNumber, owner, repo } = eventContext;
    const { redisClient } = config;

    if (commandMeta.models.length === 0) {
        correlatedLogger.warn({ pullRequestNumber: prNumber, commentId: comment.id, commentAuthor }, '/switch command requires a model argument, ignoring');
        return;
    }

    const resolvedModels = commandMeta.models.map(m => resolveModelAlias(m));
    const invalidModels: string[] = [];
    for (const model of resolvedModels) {
        if (!await isKnownOrConfiguredModel(model)) {
            invalidModels.push(model);
        }
    }
    if (invalidModels.length > 0) {
        correlatedLogger.warn({ pullRequestNumber: prNumber, invalidModels }, '/switch command contains unrecognized model(s), ignoring');
        return;
    }

    correlatedLogger.info({ pullRequestNumber: prNumber, commentId: comment.id, commentAuthor, models: commandMeta.models }, '/switch command detected, updating PR labels');
    const prData = await getPRBranchAndLabels(eventType, payload, { owner, repo, prNumber });
    const { prLabels } = prData;
    const modelLabelPattern = config.MODEL_LABEL_PATTERN || '^llm-(.+)$';
    const modelLabelRegex = new RegExp(modelLabelPattern);

    const existingLlmLabels = prLabels.filter(l => modelLabelRegex.test(l.name)).map(l => l.name);
    const { prefix, derived } = modelLabelPrefix(modelLabelPattern);
    if (!derived) {
        correlatedLogger.warn({ pullRequestNumber: prNumber, modelLabelPattern }, 'Could not derive label prefix from MODEL_LABEL_PATTERN, falling back to default "llm-". Labels may be mismatched.');
    }
    const newLabels = resolvedModels.map(m => `${prefix}${m}`);

    // Validate that newly constructed labels match the configured regex.
    // If they don't, a future /switch would fail to detect them as existing
    // model labels, causing duplicates instead of replacements.
    const mismatchedLabels = newLabels.filter(l => !modelLabelRegex.test(l));
    if (mismatchedLabels.length > 0) {
        correlatedLogger.error({ pullRequestNumber: prNumber, mismatchedLabels, modelLabelPattern, derivedPrefix: prefix }, '/switch: derived label prefix produces labels that do not match MODEL_LABEL_PATTERN — aborting to prevent label duplication');
        return;
    }

    const octokit = await getAuthenticatedOctokit();
    await safeUpdateLabels(
        { octokit, owner, repo, issueNumber: prNumber, logger: correlatedLogger },
        existingLlmLabels,
        newLabels
    );

    if (!commandMeta.instructions) {
        correlatedLogger.info({ pullRequestNumber: prNumber }, '/switch command has no instructions, label update complete');
        return;
    }

    correlatedLogger.info({ pullRequestNumber: prNumber }, '/switch command has instructions, enqueuing follow-up job');
    // Strip the /switch command line from the comment body so the downstream job
    // only sees the user's instructions, not the control syntax.
    const strippedComment = { ...comment, body: commandMeta.instructions };

    // Check for existing active/waiting jobs for this PR (batching/concurrency guard)
    const existingSwitchJob = await checkExistingJob(prNumber, owner, repo);
    if (existingSwitchJob) {
        await storeCommentForBatch({ ...strippedComment, ...buildPendingCommandFields(commandMeta) }, commentAuthor, eventContext, { redisClient, PR_FOLLOWUP_TRIGGER_KEYWORDS: config.PR_FOLLOWUP_TRIGGER_KEYWORDS });
        correlatedLogger.info({ pullRequestNumber: prNumber, commentId: comment.id }, '/switch command: existing job found for PR, stored follow-up instructions for batch processing');
        return;
    }

    // Re-use already-fetched PR data to avoid a redundant GitHub API call.
    // The labels have been updated above, so reflect the new labels in the prefetched data.
    const updatedPRData = { branchName: prData.branchName, prLabels: [...prLabels.filter(l => !existingLlmLabels.includes(l.name)), ...newLabels.map(n => ({ id: 0, name: n, node_id: '', url: '', color: '', default: false, description: null }))] as Label[] };
    await enqueueNewCommentJob(strippedComment, commentAuthor, eventContext, { payload, redisClient, PR_FOLLOWUP_TRIGGER_KEYWORDS: config.PR_FOLLOWUP_TRIGGER_KEYWORDS, MODEL_LABEL_PATTERN: config.MODEL_LABEL_PATTERN, correlationId, commandMeta, prefetchedPRData: updatedPRData });
}

type UltrafixCommandOptions = Omit<SlashCommandHandlerOptions, 'parsedCommand'> & { commandMeta: UltrafixCommandMeta };
type FreshUltrafixReservation = { generation: number; baseGeneration: number };
type AuthenticatedOctokit = Awaited<ReturnType<typeof getAuthenticatedOctokit>>;

interface FreshUltrafixStartup {
    octokit: AuthenticatedOctokit;
    initialAction: 'review' | 'fix';
    effectiveGoal: number;
    effectiveMaxCycles: number;
    effectivePauseSeconds: number;
    effectiveReviewModel: string;
}

async function handleUltrafixCommand(opts: UltrafixCommandOptions): Promise<void> {
    const { config, correlationId, eventContext } = opts;
    const deps = loadUltrafixDeps();
    await deps.withTransitionLease(
        config.redisClient,
        { owner: eventContext.owner, repo: eventContext.repo, pr: eventContext.prNumber },
        correlationId,
        assertOwned => handleUltrafixCommandWithLease(opts, deps, assertOwned),
    );
}

async function handleUltrafixCommandWithLease(
    opts: UltrafixCommandOptions,
    deps: UltrafixDeps,
    assertTransitionOwned: () => Promise<void>,
): Promise<void> {
    const { comment, commentAuthor, eventContext, config, correlatedLogger } = opts;
    const { prNumber, owner, repo } = eventContext;
    const { redisClient } = config;

    correlatedLogger.info({ pullRequestNumber: prNumber, commentId: comment.id, commentAuthor }, '/ultrafix command detected, initializing loop');

    // 1. Load configured defaults from settings, then override with command arguments
    await assertTransitionOwned();
    const commandSequence = comment.commandSequence ?? 0;
    const reservation = await deps.reserveFreshTransition(
        redisClient, { owner, repo, pr: prNumber }, commandSequence,
    );
    if (reservation === null) {
        correlatedLogger.info(
            { pullRequestNumber: prNumber, commentId: comment.id, commandSequence },
            'Ignored stale /ultrafix command superseded by a newer action',
        );
        return;
    }
    const startup = await initializeReservedUltrafixLoop(opts, deps, assertTransitionOwned, reservation);
    const { octokit, initialAction, effectiveGoal, effectiveMaxCycles, effectivePauseSeconds, effectiveReviewModel } = startup;
    correlatedLogger.info(
        { pullRequestNumber: prNumber, initialAction, effectiveGoal, effectiveMaxCycles, effectivePauseSeconds, effectiveReviewModel },
        `/ultrafix initialized, first action: ${initialAction}`,
    );

    // 9. Post the circuit-breaker comment. State and job are already committed,
    //    so treat a comment-post failure as non-fatal — the loop will proceed
    //    regardless and the user can still stop it by removing the label.
    try {
        await assertTransitionOwned();
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

async function initializeReservedUltrafixLoop(
    opts: UltrafixCommandOptions,
    deps: UltrafixDeps,
    assertTransitionOwned: () => Promise<void>,
    reservation: FreshUltrafixReservation,
): Promise<FreshUltrafixStartup> {
    const { commandMeta, comment, commentAuthor, eventContext, payload, config, correlationId, correlatedLogger } = opts;
    const { eventType, prNumber, owner, repo } = eventContext;
    const { redisClient } = config;
    const commandSequence = comment.commandSequence ?? 0;
    const { generation, baseGeneration } = reservation;
    let octokit: AuthenticatedOctokit | null = null;
    let labelWasAdded = false;

    try {
        const [dbGoal, dbMaxCycles, dbPauseSeconds, dbReviewModel] = await Promise.all([
            deps.loadUltrafixRatingGoal(),
            deps.loadUltrafixMaxCycles(),
            deps.loadUltrafixPauseSeconds(),
            deps.loadPrReviewModel(),
        ]);
        const effectiveGoal = commandMeta.goal ?? dbGoal;
        const effectiveMaxCycles = commandMeta.maxCycles ?? dbMaxCycles;
        const effectivePauseSeconds = commandMeta.pauseSeconds ?? dbPauseSeconds;
        const effectiveReviewModel = commandMeta.reviewModel ?? dbReviewModel;
        const strippedComment = { ...comment, body: commandMeta.instructions || '' };

        octokit = await getAuthenticatedOctokit();
        const prComments = await withRetry(
            () => octokit!.paginate('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', { owner, repo, issue_number: prNumber, per_page: 100 }),
            { maxAttempts: 3, baseDelay: 2000, maxDelay: 10000, exponentialBase: 2 },
            `get_pr_comments_${owner}_${repo}_${prNumber}`
        ) as Array<{ id: number; body: string | null; user: { login: string; type?: string }; created_at: string }>;
        const { hasPendingReview } = await deps.getPendingReviewState(
            prComments,
            { repoOwner: owner, repoName: repo, pullRequestNumber: prNumber, redisClient, correlatedLogger },
        );
        const prData = await getPRBranchAndLabels(eventType, payload, { owner, repo, prNumber });
        labelWasAdded = !prData.prLabels.some(l => l.name === 'ultrafix');
        if (labelWasAdded) {
            await assertTransitionOwned();
            await safeUpdateLabels(
                { octokit, owner, repo, issueNumber: prNumber, logger: correlatedLogger }, [], ['ultrafix'],
            );
        }

        const initialAction: 'review' | 'fix' = hasPendingReview ? 'fix' : 'review';
        const firstActionMeta: CommandMeta = initialAction === 'review'
            ? { mode: 'review', models: effectiveReviewModel ? [effectiveReviewModel] : [], instructions: commandMeta.instructions }
            : { mode: 'fix', instructions: commandMeta.instructions };
        const loopMeta: UltrafixCommandMeta = { ...commandMeta, generation };
        const startupJobId = `pr-comments-ultrafix-${owner}-${repo}-${prNumber}-${eventType}-${comment.id}-${generation}`;
        await assertTransitionOwned();
        await ensureFreshUltrafixStartupJob(startupJobId, async () => {
            await enqueueNewCommentJob(strippedComment, commentAuthor, eventContext, {
                payload,
                redisClient,
                PR_FOLLOWUP_TRIGGER_KEYWORDS: config.PR_FOLLOWUP_TRIGGER_KEYWORDS,
                MODEL_LABEL_PATTERN: config.MODEL_LABEL_PATTERN,
                correlationId,
                commandMeta: firstActionMeta,
                prefetchedPRData: prData,
                ultrafixMeta: loopMeta,
                throwOnQueueFailure: true,
                idempotentJobId: startupJobId,
                delayMs: FRESH_STARTUP_JOB_DELAY_MS,
            });
        });
        await assertTransitionOwned();
        const committed = await deps.commitFreshLoop(redisClient, {
            owner,
            repo,
            pr: prNumber,
            commandSequence,
            generation,
            baseGeneration,
            goal: effectiveGoal,
            maxCycles: effectiveMaxCycles,
            pauseSeconds: effectivePauseSeconds,
            reviewModel: effectiveReviewModel,
        }, hasPendingReview);
        if (!committed) throw new Error('Ultrafix startup reservation was superseded');
        await promoteFreshUltrafixStartupJob(startupJobId, correlatedLogger);
        return { octokit, initialAction, effectiveGoal, effectiveMaxCycles, effectivePauseSeconds, effectiveReviewModel };
    } catch (error) {
        correlatedLogger.error({ pullRequestNumber: prNumber, error }, '/ultrafix startup failed before publication, rolling back reservation');
        await rollbackFreshUltrafixStartup({
            opts,
            deps,
            assertTransitionOwned,
            commandSequence,
            labelWasAdded,
            startupOctokit: octokit,
        });
        throw error;
    }
}

interface FreshUltrafixRollbackOptions {
    opts: UltrafixCommandOptions;
    deps: UltrafixDeps;
    assertTransitionOwned: () => Promise<void>;
    commandSequence: number;
    labelWasAdded: boolean;
    startupOctokit: AuthenticatedOctokit | null;
}

async function rollbackFreshUltrafixStartup(options: FreshUltrafixRollbackOptions): Promise<void> {
    const { opts, deps, assertTransitionOwned, commandSequence, labelWasAdded, startupOctokit } = options;
    const { eventContext: { prNumber, owner, repo }, config: { redisClient }, correlatedLogger } = opts;
    try {
        const rollbackOwned = await deps.abortFreshTransition(
            redisClient, { owner, repo, pr: prNumber }, commandSequence,
        );
        const octokit = startupOctokit ?? await getAuthenticatedOctokit();
        if (labelWasAdded && rollbackOwned) {
            await assertTransitionOwned();
            await safeUpdateLabels(
                { octokit, owner, repo, issueNumber: prNumber, logger: correlatedLogger }, ['ultrafix'], [],
            );
        }
        const labelNote = labelWasAdded && rollbackOwned
            ? 'The ultrafix label has been removed.'
            : 'The ultrafix label was left in place because a newer command may own it — remove it manually if you do not want further ultrafix cycles.';
        await assertTransitionOwned();
        await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
            owner,
            repo,
            issue_number: prNumber,
            body: `❌ **Ultrafix loop failed to start.** ${labelNote} Please try again.\n\nIf the problem persists, check the system logs for details.`,
        });
    } catch (rollbackError) {
        correlatedLogger.error({ pullRequestNumber: prNumber, rollbackError }, '/ultrafix rollback also failed');
    }
}

async function ensureFreshUltrafixStartupJob(
    jobId: string,
    enqueue: () => Promise<void>,
): Promise<void> {
    const queue = await getIssueQueue();
    const existingJob = await queue.getJob(jobId);
    if (existingJob) {
        const state = await existingJob.getState();
        if (state === 'waiting' || state === 'delayed' || state === 'waiting-children') return;
        if (state === 'active') throw new Error('Reserved Ultrafix startup job is still active');
        await existingJob.remove();
    }
    try {
        await enqueue();
    } catch (error) {
        if (await queue.getJob(jobId)) return;
        throw error;
    }
}

async function promoteFreshUltrafixStartupJob(
    jobId: string,
    correlatedLogger: ReturnType<typeof logger.withCorrelation>,
): Promise<void> {
    try {
        const job = await (await getIssueQueue()).getJob(jobId);
        if (job && await job.getState() === 'delayed') await job.promote();
    } catch (error) {
        correlatedLogger.warn({ jobId, error }, 'Ultrafix startup committed but its delayed job could not be promoted');
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
        const slashCommentTrackingKey = getCommentTrackingKey({
            owner, repo, prNumber, eventType, commentId: comment.id,
        });
        const claimed = await claimCommentForProcessing(redisClient, slashCommentTrackingKey);
        if (!claimed) {
            correlatedLogger.debug({ repository: repoFullName, pullRequestNumber: prNumber, commentId: comment.id }, 'Slash command comment already processed, skipping redelivery');
            return { status: 'ignored', reason: 'duplicate_delivery' };
        }
        try {
            comment.commandSequence = await getOrAssignCommandSequence(redisClient, {
                owner, repo, prNumber, eventType, commentId: comment.id,
                updatedAt: comment.updated_at,
                body: comment.body,
            });
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

    const commentTrackingKey = getCommentTrackingKey({
        owner, repo, prNumber, eventType, commentId: comment.id,
    });
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
    const queue = await getIssueQueue();
    const [activeJobs, waitingJobs, delayedJobs] = await Promise.all([
        queue.getActive(),
        queue.getWaiting(),
        queue.getDelayed(),
    ]);
    const existingJobs = [...activeJobs, ...waitingJobs, ...delayedJobs] as Job<PRJobData>[];
    return existingJobs.filter(job => job.name === 'processPullRequestComment' && job.data.pullRequestNumber === prNumber && job.data.repoOwner === owner && job.data.repoName === repo);
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
        body: pendingCommentBody,
        author: commentAuthor,
        type: reviewComment ? 'review' : 'issue',
        hasCodeContext: reviewComment && !!comment.diff_hunk,
        commandMeta: comment.commandMeta,
        commandMode: comment.commandMode,
        requestedModels: comment.requestedModels,
        commandInstructions: comment.commandInstructions,
        llmOverride: comment.llmOverride,
        ultrafixMeta: comment.ultrafixMeta,
        commandSequence: comment.commandSequence,
    };
    const serializedComment = JSON.stringify(pendingComment);
    if (config.takeoverStageKey) {
        const stored = await redisClient.eval(
            STORE_PENDING_TAKEOVER_SCRIPT,
            2,
            pendingCommentsKey,
            config.takeoverStageKey,
            serializedComment,
            '3600',
            String(TAKEOVER_STAGE_TTL_SECONDS),
            String(config.takeoverSequence ?? 0),
        );
        if (Number(stored) !== 1) throw new Error('Failed to durably stage manual takeover');
        return;
    }
    await redisClient.rpush(pendingCommentsKey, serializedComment);
    await redisClient.expire(pendingCommentsKey, 3600);
}

async function getPRBranchAndLabels(eventType: CommentEventType, payload: IssueCommentEvent | PullRequestReviewCommentEvent, repoContext: RepoContext): Promise<PRBranchAndLabels> {
    const { owner, repo, prNumber } = repoContext;
    if (eventType === 'issue_comment') {
        const octokit = await getAuthenticatedOctokit();
        // Retry up to ~1 minute: 3s + 6s + 12s + 20s + 20s = 61s total
        const { data: pr } = await withRetry(
            () => octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', { owner, repo, pull_number: prNumber }),
            { maxAttempts: 6, baseDelay: 3000, maxDelay: 20000, exponentialBase: 2 },
            `get_pr_details_${owner}_${repo}_${prNumber}`
        );
        return { branchName: pr.head.ref, prLabels: pr.labels || [] };
    }
    const prPayload = payload as PullRequestReviewCommentEvent;
    return { branchName: prPayload.pull_request.head.ref, prLabels: prPayload.pull_request.labels || [] };
}

function prepareComment(comment: { id: number; body: string; path?: string; line?: number | null; diff_hunk?: string; pull_request_review_id?: number; commandSequence?: number }, commentAuthor: string, eventType: CommentEventType, keywords: string[]): { enhancedBody: string; unprocessedComment: UnprocessedComment; llmFromKeywords: string | null } {
    const llmFromKeywords = keywords.length > 0 ? extractLlmFromKeywords(comment.body, keywords) : null;
    let enhancedBody = keywords.length > 0 ? stripKeywordsFromBody(comment.body, keywords) : comment.body;

    if (isReviewComment(comment, eventType)) {
        const codeContext = buildCodeContext(comment);
        if (codeContext.length > 0) enhancedBody = `${enhancedBody}\n\n--- Review Comment Context ---\n${codeContext.join('\n')}`;
    }

    const commentType = isReviewComment(comment, eventType) ? 'review' as const : 'issue' as const;
    const unprocessedComment: UnprocessedComment = { id: comment.id, body: enhancedBody, author: commentAuthor, type: commentType, hasCodeContext: commentType === 'review' && !!comment.diff_hunk, commandSequence: comment.commandSequence };
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

function buildPendingCommandFields(commandMeta: CommandMeta): Pick<UnprocessedComment, 'commandMeta' | 'commandMode' | 'requestedModels' | 'commandInstructions' | 'llmOverride'> {
    return {
        ...buildCommandJobFields(commandMeta),
        llmOverride: (commandMeta.mode === 'switch' || commandMeta.mode === 'use') && commandMeta.models.length > 0
            ? resolveModelAlias(commandMeta.models[0])
            : undefined,
    };
}

async function enqueueNewCommentJob(comment: { id: number; body: string; path?: string; line?: number | null; diff_hunk?: string; pull_request_review_id?: number; commandSequence?: number }, commentAuthor: string, eventContext: CommentContext, options: EnqueueCommentOptions): Promise<void> {
    const { eventType, prNumber, owner, repo } = eventContext;
    const { payload, redisClient, PR_FOLLOWUP_TRIGGER_KEYWORDS, correlationId, MODEL_LABEL_PATTERN = '^llm-(.+)$', commandMeta, prefetchedPRData, ultrafixMeta } = options;
    const correlatedLogger = logger.withCorrelation(correlationId);

    const { unprocessedComment, llmFromKeywords } = prepareComment(comment, commentAuthor, eventType, PR_FOLLOWUP_TRIGGER_KEYWORDS);
    const { branchName, prLabels } = prefetchedPRData || await getPRBranchAndLabels(eventType, payload, { owner, repo, prNumber });
    const llm = resolveLlm(llmFromKeywords, prLabels, { modelLabelPattern: MODEL_LABEL_PATTERN, prNumber, correlatedLogger, commandMeta });

    const jobData: CommentJobData = {
        pullRequestNumber: prNumber, comments: [unprocessedComment], repoOwner: owner, repoName: repo, branchName, llm, correlationId: generateCorrelationId(),
        ...(commandMeta ? { ...buildCommandJobFields(commandMeta), commandCommentId: comment.id, commandSequence: comment.commandSequence } : {}),
        ...(ultrafixMeta ? { ultrafixMeta } : {}),
    };
    const timestamp = Date.now();
    const jobId = options.idempotentJobId
        ?? `pr-comments-batch-${owner}-${repo}-${prNumber}-${timestamp}`;
    const commentTrackingKey = getCommentTrackingKey({
        owner, repo, prNumber, eventType, commentId: comment.id,
    });
    let jobQueued = false;

    try {
        const queue = await getIssueQueue();
        await queue.add('processPullRequestComment', jobData, {
            jobId,
            delay: options.delayMs ?? COMMENT_BATCH_DELAY_MS,
            attempts: 3,
            backoff: { type: 'exponential', delay: 10000 },  // 10s, 20s, 40s
        });
        jobQueued = true;
        await redisClient.setex(commentTrackingKey, 86400, Date.now().toString());
        const delayMs = options.delayMs ?? COMMENT_BATCH_DELAY_MS;
        correlatedLogger.info({ jobId, pullRequestNumber: prNumber, commentId: comment.id, commentType: unprocessedComment.type, delayMs }, `Successfully added PR comment job with ${delayMs}ms delay`);
    } catch (error) {
        const err = error as Error;
        if (err.message?.includes('Job already exists')) {
            correlatedLogger.debug({ pullRequestNumber: prNumber }, 'PR comment job already in queue, skipping');
            if (options.idempotentJobId) jobQueued = true;
        }
        else handleError(error, `Failed to add PR comment to queue`, { correlationId });
        if (options.throwOnQueueFailure && !jobQueued) throw error;
    }
}
