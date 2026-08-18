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
import { createHash } from 'node:crypto';
import { withUltrafixLabelTransition } from '../utils/ultrafixLabelTransition.js';
import type { IssueCommentEvent, PullRequestReviewCommentEvent, Label } from '@octokit/webhooks-types';
import { extractLlmFromKeywords, stripKeywordsFromBody, buildCodeContext, isReviewComment, extractLlmFromLabels, modelLabelPrefix } from './commentEventHelpers.js';
import { handleMergeCommand } from './mergeConflictDetector.js';
import { parseSlashCommand, buildCommandMeta } from './slashCommandParser.js';
import type { CommandMeta, UltrafixCommandMeta } from './slashCommandParser.js';
import { safeUpdateLabels } from '../utils/github/labelOperations.js';
import { resolveModelAlias, resolveReviewModels } from '../config/modelAliases.js';
import { MODEL_INFO_MAP } from '../config/modelDefinitions.js';
import { getBotUsername } from '../daemon/configLoader.js';
import { AgentRegistry } from '../agents/AgentRegistry.js';
import type { DeliveryDisposition } from '../intake/routingWebSocketProtocol.js';
import { buildAgentModelLlmLabel, buildDynamicLlmLabel, MAX_GITHUB_LABEL_LENGTH, shortHash } from '@propr/shared';

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
interface StoreCommentConfig { redisClient: Redis; PR_FOLLOWUP_TRIGGER_KEYWORDS: string[] }
interface EnqueueCommentOptions { payload: IssueCommentEvent | PullRequestReviewCommentEvent; redisClient: Redis; PR_FOLLOWUP_TRIGGER_KEYWORDS: string[]; MODEL_LABEL_PATTERN?: string; correlationId: string; commandMeta?: CommandMeta; prefetchedPRData?: PRBranchAndLabels; ultrafixMeta?: UltrafixCommandMeta; commentRevisionIdentity?: string }
interface RepoContext { owner: string; repo: string; prNumber: number }
interface PRBranchAndLabels { branchName: string; prLabels: Label[] }
type BatchComment = Pick<UnprocessedComment, 'id' | 'body' | 'commandMeta' | 'commandMode' | 'requestedModels' | 'commandInstructions' | 'llmOverride' | 'ultrafixMeta'> & { created_at: string; path?: string; line?: number | null; diff_hunk?: string; pull_request_review_id?: number };
type CommandJobFields = Pick<CommentJobData, 'commandMeta' | 'commandMode' | 'requestedModels' | 'commandInstructions'>;
type PRComment = { id: number; created_at: string; updated_at: string; body: string; user: { login: string; type?: string }; path?: string; line?: number | null; diff_hunk?: string; pull_request_review_id?: number };
type ManualCommandTakeover = { workEpoch: number; hadAutomaticWork: boolean; commentRevisionIdentity: string };

function getCommentRevisionIdentity(comment: Pick<PRComment, 'updated_at' | 'body'>, eventType: CommentEventType): string {
    const contentDigest = createHash('sha256').update(`${eventType}\0${comment.body}`).digest('hex').slice(0, 12);
    return `${comment.updated_at}:${contentDigest}`;
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
    if (commandMeta.mode !== 'fix' && commandMeta.mode !== 'review') return null;

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

    if (commandMeta.mode === 'switch') {
        await handleSwitchCommand({ commandMeta, comment, commentAuthor, eventContext, payload, config, correlationId, correlatedLogger });
        return;
    }

    if (commandMeta.mode === 'use') {
        await handleUseCommand({ commandMeta, comment, commentAuthor, eventContext, payload, config, correlationId, correlatedLogger });
        return;
    }

    const manualTakeover = await fenceManualCommand({ commandMeta, comment, eventContext, config, correlatedLogger });

    correlatedLogger.info({ pullRequestNumber: prNumber, commentId: comment.id, commentAuthor, command: commandMeta.mode }, `/${commandMeta.mode} command detected, enqueuing job`);
    // Strip the slash command line from the comment body so the downstream job
    // only sees the user's instructions, not the control syntax (consistent with /switch).
    const strippedComment = { ...comment, body: commandMeta.instructions || '' };

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

    await enqueueNewCommentJob(strippedComment, commentAuthor, eventContext, { payload, redisClient, PR_FOLLOWUP_TRIGGER_KEYWORDS: config.PR_FOLLOWUP_TRIGGER_KEYWORDS, MODEL_LABEL_PATTERN: config.MODEL_LABEL_PATTERN, correlationId, commandMeta, commentRevisionIdentity: manualTakeover?.commentRevisionIdentity });
}

type UseCommandOptions = Omit<SlashCommandHandlerOptions, 'parsedCommand'> & { commandMeta: CommandMeta & { mode: 'use' } };

function buildPrefixedDynamicModelLabel(prefix: string, agentAlias: string, modelId: string): string | null {
    const canonicalLabel = `${prefix}${agentAlias}~${modelId}`;
    if (canonicalLabel.length <= MAX_GITHUB_LABEL_LENGTH) return canonicalLabel;

    const hash = shortHash(modelId);
    const maxAliasLength = Math.max(1, MAX_GITHUB_LABEL_LENGTH - `${prefix}~-x-${hash}`.length);
    const sanitizedAlias = agentAlias
        .replace(/[^a-zA-Z0-9_.-]/g, '-')
        .slice(0, maxAliasLength)
        .replace(/[^a-zA-Z0-9]+$/, '');
    const labelAlias = sanitizedAlias || 'agent'.slice(0, maxAliasLength);
    const modelPrefixBudget = MAX_GITHUB_LABEL_LENGTH - `${prefix}${labelAlias}~-${hash}`.length;
    const fallbackPrefix = 'model'.slice(0, Math.max(1, modelPrefixBudget));
    const modelPrefix = modelId
        .replace(/[^a-zA-Z0-9_.-]/g, '-')
        .slice(0, Math.max(1, modelPrefixBudget))
        .replace(/[^a-zA-Z0-9]+$/, '');
    const hashedLabel = `${prefix}${labelAlias}~${modelPrefix || fallbackPrefix}-${hash}`;
    return hashedLabel.length <= MAX_GITHUB_LABEL_LENGTH ? hashedLabel : null;
}

function applyModelLabelPrefix(defaultLabel: string, prefix: string, agentAlias: string, modelId: string): string | null {
    if (!defaultLabel.startsWith('llm-')) {
        return defaultLabel.length <= MAX_GITHUB_LABEL_LENGTH ? defaultLabel : null;
    }

    const suffix = defaultLabel.slice('llm-'.length);
    if (suffix.includes('~')) {
        return buildPrefixedDynamicModelLabel(prefix, agentAlias, modelId);
    }

    const staticLabel = `${prefix}${suffix}`;
    return staticLabel.length <= MAX_GITHUB_LABEL_LENGTH
        ? staticLabel
        : buildPrefixedDynamicModelLabel(prefix, agentAlias, modelId);
}

async function resolveCanonicalModelLabel(
    target: string,
    modelLabelPattern: string,
    correlatedLogger: ReturnType<typeof logger.withCorrelation>,
    prNumber: number,
): Promise<string | null> {
    try {
        const modelLabelRegex = new RegExp(modelLabelPattern);
        const targetMatch = modelLabelRegex.exec(target);
        const routingTarget = targetMatch?.[1] || target;
        const [resolution] = await resolveReviewModels([routingTarget]);
        const registry = AgentRegistry.getInstance();
        const agent = registry.getAgentByAlias(resolution.agentAlias);
        if (!agent) {
            correlatedLogger.warn(
                { pullRequestNumber: prNumber, target },
                '/use target is unknown, disabled, or unsupported; model label was not changed',
            );
            return null;
        }

        const modelInfo = MODEL_INFO_MAP[resolution.model];
        const defaultLabel = modelInfo
            ? buildAgentModelLlmLabel(agent.config.type, agent.config.alias, modelInfo)
            : buildDynamicLlmLabel(agent.config.alias, resolution.model);
        const { prefix, derived } = modelLabelPrefix(modelLabelPattern);
        if (!derived) {
            correlatedLogger.warn(
                { pullRequestNumber: prNumber, modelLabelPattern },
                'Could not derive label prefix from MODEL_LABEL_PATTERN; /use cannot safely select a model label',
            );
            return null;
        }

        const canonicalLabel = applyModelLabelPrefix(defaultLabel, prefix, agent.config.alias, resolution.model);
        if (!canonicalLabel) {
            correlatedLogger.error(
                { pullRequestNumber: prNumber, modelLabelPattern },
                '/use could not build a canonical model label within GitHub\'s label length limit',
            );
            return null;
        }
        const canonicalMatch = modelLabelRegex.exec(canonicalLabel);
        const canonicalRoutingToken = canonicalMatch?.[1];
        if (!canonicalRoutingToken) {
            correlatedLogger.error(
                { pullRequestNumber: prNumber, canonicalLabel, modelLabelPattern },
                '/use resolved a canonical label that does not match MODEL_LABEL_PATTERN',
            );
            return null;
        }

        let routedResolution: Awaited<ReturnType<typeof resolveReviewModels>>[number];
        try {
            [routedResolution] = await resolveReviewModels([canonicalRoutingToken]);
        } catch (error) {
            correlatedLogger.error(
                { pullRequestNumber: prNumber, canonicalLabel, canonicalRoutingToken, error: (error as Error).message },
                '/use resolved a canonical label that cannot route back to the selected model',
            );
            return null;
        }
        if (routedResolution.agentAlias !== resolution.agentAlias || routedResolution.model !== resolution.model) {
            correlatedLogger.error(
                {
                    pullRequestNumber: prNumber,
                    canonicalLabel,
                    selectedAgentAlias: resolution.agentAlias,
                    selectedModel: resolution.model,
                    routedAgentAlias: routedResolution.agentAlias,
                    routedModel: routedResolution.model,
                },
                '/use resolved a canonical label that routes to a different model',
            );
            return null;
        }
        return canonicalLabel;
    } catch (error) {
        correlatedLogger.warn(
            { pullRequestNumber: prNumber, target, error: (error as Error).message },
            '/use target is unknown, disabled, or unsupported; model label was not changed',
        );
        return null;
    }
}

async function handleUseCommand(opts: UseCommandOptions): Promise<void> {
    const { commandMeta, comment, commentAuthor, eventContext, config, correlatedLogger } = opts;
    const { prNumber, owner, repo } = eventContext;

    if (commandMeta.models.length === 0) {
        correlatedLogger.warn({ pullRequestNumber: prNumber, commentId: comment.id, commentAuthor }, '/use command requires a model argument, ignoring');
        return;
    }

    const modelLabelPattern = config.MODEL_LABEL_PATTERN || '^llm-(.+)$';
    const canonicalLabel = await resolveCanonicalModelLabel(commandMeta.models[0], modelLabelPattern, correlatedLogger, prNumber);
    if (!canonicalLabel) return;

    const { prLabels } = await getLivePRBranchAndLabels({ owner, repo, prNumber });
    const canonicalLabelIdentity = canonicalLabel.toLowerCase();
    const existingModelLabels = prLabels.filter(label => label.name.startsWith('llm-')).map(label => label.name);
    const labelsToRemove = existingModelLabels.filter(label => label.toLowerCase() !== canonicalLabelIdentity);
    const targetPresent = prLabels.some(label => label.name.toLowerCase() === canonicalLabelIdentity);

    if (labelsToRemove.length === 0 && targetPresent) {
        correlatedLogger.debug({ pullRequestNumber: prNumber, modelLabel: canonicalLabel }, '/use model label is already active');
        return;
    }

    const labels = [
        ...prLabels
            .filter(label => !label.name.startsWith('llm-') && label.name.toLowerCase() !== canonicalLabelIdentity)
            .map(label => label.name),
        canonicalLabel,
    ];

    try {
        const octokit = await getAuthenticatedOctokit();
        await octokit.request('PUT /repos/{owner}/{repo}/issues/{issue_number}/labels', {
            owner,
            repo,
            issue_number: prNumber,
            labels,
        });
    } catch (error) {
        correlatedLogger.error(
            { pullRequestNumber: prNumber, modelLabel: canonicalLabel, error: (error as Error).message },
            '/use failed to update the PR model label',
        );
        return;
    }

    correlatedLogger.info(
        { pullRequestNumber: prNumber, modelLabel: canonicalLabel },
        '/use updated the PR model label',
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
    const strippedComment = { ...comment, body: commandMeta.instructions || '' };
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
    const queue = await getIssueQueue();
    const [activeJobs, waitingJobs, delayedJobs] = await Promise.all([
        queue.getActive(),
        queue.getWaiting(),
        queue.getDelayed(),
    ]);
    const existingJobs = [...activeJobs, ...waitingJobs, ...delayedJobs] as Job<PRJobData>[];
    return existingJobs.filter(job => job.name === 'processPullRequestComment' && job.data.pullRequestNumber === prNumber && job.data.repoOwner === owner && job.data.repoName === repo);
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

function prepareComment(comment: { id: number; created_at: string; body: string; path?: string; line?: number | null; diff_hunk?: string; pull_request_review_id?: number }, commentAuthor: string, eventType: CommentEventType, keywords: string[]): { enhancedBody: string; unprocessedComment: UnprocessedComment; llmFromKeywords: string | null } {
    const llmFromKeywords = keywords.length > 0 ? extractLlmFromKeywords(comment.body, keywords) : null;
    let enhancedBody = keywords.length > 0 ? stripKeywordsFromBody(comment.body, keywords) : comment.body;

    if (isReviewComment(comment, eventType)) {
        const codeContext = buildCodeContext(comment);
        if (codeContext.length > 0) enhancedBody = `${enhancedBody}\n\n--- Review Comment Context ---\n${codeContext.join('\n')}`;
    }

    const commentType = isReviewComment(comment, eventType) ? 'review' as const : 'issue' as const;
    const unprocessedComment: UnprocessedComment = { id: comment.id, createdAt: comment.created_at, body: enhancedBody, author: commentAuthor, type: commentType, hasCodeContext: commentType === 'review' && !!comment.diff_hunk };
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

async function enqueueNewCommentJob(comment: { id: number; created_at: string; updated_at: string; body: string; path?: string; line?: number | null; diff_hunk?: string; pull_request_review_id?: number }, commentAuthor: string, eventContext: CommentContext, options: EnqueueCommentOptions): Promise<void> {
    const { eventType, prNumber, owner, repo } = eventContext;
    const { payload, redisClient, PR_FOLLOWUP_TRIGGER_KEYWORDS, correlationId, MODEL_LABEL_PATTERN = '^llm-(.+)$', commandMeta, prefetchedPRData, ultrafixMeta, commentRevisionIdentity } = options;
    const correlatedLogger = logger.withCorrelation(correlationId);

    const { unprocessedComment, llmFromKeywords } = prepareComment(comment, commentAuthor, eventType, PR_FOLLOWUP_TRIGGER_KEYWORDS);
    const { branchName, prLabels } = prefetchedPRData || await getPRBranchAndLabels(eventType, payload, { owner, repo, prNumber });
    const llm = resolveLlm(llmFromKeywords, prLabels, { modelLabelPattern: MODEL_LABEL_PATTERN, prNumber, correlatedLogger, commandMeta });

    const jobData: CommentJobData = {
        pullRequestNumber: prNumber, comments: [unprocessedComment], repoOwner: owner, repoName: repo, branchName, llm, correlationId: generateCorrelationId(),
        ...(commandMeta ? {
            ...buildCommandJobFields(commandMeta),
            commandCommentId: comment.id,
            commandCommentCreatedAt: comment.created_at,
            commandCommentType: unprocessedComment.type,
        } : {}),
        ...(ultrafixMeta ? { ultrafixMeta } : {}),
    };
    const manualCommand = commandMeta?.mode === 'fix' || commandMeta?.mode === 'review';
    const commentRevisionSlug = (commentRevisionIdentity ?? getCommentRevisionIdentity(comment, eventType)).replace(/[^a-zA-Z0-9_-]/g, '-');
    const jobId = manualCommand
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
