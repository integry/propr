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

export interface UltrafixDeps {
    loadUltrafixRatingGoal: () => Promise<number>;
    loadUltrafixMaxCycles: () => Promise<number>;
    loadUltrafixPauseSeconds: () => Promise<number>;
    loadPrReviewModel: () => Promise<string>;
    startLoop: (redis: Redis, options: { owner: string; repo: string; pr: number; goal?: number; maxCycles?: number; pauseSeconds?: number; reviewModel?: string }, hasPendingReviews: boolean) => Promise<{ state: unknown; initialAction: 'review' | 'fix' }>;
    clearState: (redis: Redis, owner: string, repo: string, pr: number) => Promise<void>;
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
interface EnqueueCommentOptions { payload: IssueCommentEvent | PullRequestReviewCommentEvent; redisClient: Redis; PR_FOLLOWUP_TRIGGER_KEYWORDS: string[]; MODEL_LABEL_PATTERN?: string; correlationId: string; commandMeta?: CommandMeta; prefetchedPRData?: PRBranchAndLabels; ultrafixMeta?: UltrafixCommandMeta }
interface RepoContext { owner: string; repo: string; prNumber: number }
interface PRBranchAndLabels { branchName: string; prLabels: Label[] }
type BatchComment = Pick<UnprocessedComment, 'id' | 'body' | 'commandMeta' | 'commandMode' | 'requestedModels' | 'commandInstructions' | 'llmOverride' | 'ultrafixMeta'> & { path?: string; line?: number | null; diff_hunk?: string; pull_request_review_id?: number };
type CommandJobFields = Pick<CommentJobData, 'commandMeta' | 'commandMode' | 'requestedModels' | 'commandInstructions'>;

async function prHasProcessingLabel(prLabels: Label[]): Promise<boolean> {
    const processingLabels = await loadPrimaryProcessingLabels();
    return prLabels.some(label => processingLabels.includes(label.name));
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
    const queue = await getIssueQueue();
    const activeJobs = await queue.getActive();
    const waitingJobs = await queue.getWaiting();
    const allJobs = [...activeJobs, ...waitingJobs] as Job<PRJobData>[];

    for (const job of allJobs) {
        if (job.name === 'processPullRequestComment' && job.data.pullRequestNumber === prNumber && job.data.repoOwner === owner && job.data.repoName === repo) {
            const jobCommentIds = job.data.comments?.map(c => c.id) || [];
            if (jobCommentIds.includes(commentId)) {
                correlatedLogger.info({ jobId: job.id, pullRequestNumber: prNumber, repository: repoFullName }, 'Aborting job due to comment deletion');
                const taskId = job.id?.startsWith('pr-comments-batch-') ? job.id.replace(/^pr-comments-batch-/, '').replace(/-\d+$/, '') : `${owner}-${repo}-${prNumber}`;
                await redisClient.set(`worker:abort:${taskId}`, JSON.stringify({ timestamp: new Date().toISOString(), reason: 'comment_deleted', commentId }), 'EX', 3600);
                await job.remove();
                correlatedLogger.info({ jobId: job.id, taskId }, 'Job aborted and removed from queue');
            }
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
    const queue = await getIssueQueue();
    const activeJobs = await queue.getActive();
    const waitingJobs = await queue.getWaiting();
    const allJobs = [...activeJobs, ...waitingJobs] as Job<PRJobData>[];

    let foundJob: Job<PRJobData> | null = null;
    for (const job of allJobs) {
        if (job.name === 'processPullRequestComment' && job.data.pullRequestNumber === prNumber && job.data.repoOwner === owner && job.data.repoName === repo) {
            const jobCommentIds = job.data.comments?.map(c => c.id) || [];
            if (jobCommentIds.includes(commentId)) { foundJob = job; break; }
        }
    }

    if (foundJob) {
        correlatedLogger.info({ jobId: foundJob.id, pullRequestNumber: prNumber, repository: repoFullName }, 'Aborting existing job due to comment edit');
        const taskId = foundJob.id?.startsWith('pr-comments-batch-') ? foundJob.id.replace(/^pr-comments-batch-/, '').replace(/-\d+$/, '') : `${owner}-${repo}-${prNumber}`;
        await redisClient.set(`worker:abort:${taskId}`, JSON.stringify({ timestamp: new Date().toISOString(), reason: 'comment_edited', commentId }), 'EX', 3600);
        await foundJob.remove();
    }

    await redisClient.del(`pr-comment-processed:${owner}:${repo}:${prNumber}:${commentId}`);
    correlatedLogger.info({ pullRequestNumber: prNumber, repository: repoFullName, commentId }, 'Reprocessing edited comment');
    if (processCommentEventFn) await processCommentEventFn(payload, eventType, correlationId, config);
}

interface SlashCommandComment { id: number; body: string; path?: string; line?: number | null; diff_hunk?: string; pull_request_review_id?: number }

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
        if (!MODEL_INFO_MAP[resolvedModel]) {
            correlatedLogger.warn({ pullRequestNumber: prNumber, invalidModels: [resolvedModel] }, '/use command contains unrecognized model(s), ignoring');
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
        await storeCommentForBatch({ ...strippedComment, ...buildPendingCommandFields(commandMeta) }, commentAuthor, eventContext, { redisClient, PR_FOLLOWUP_TRIGGER_KEYWORDS: config.PR_FOLLOWUP_TRIGGER_KEYWORDS });
        correlatedLogger.info({ pullRequestNumber: prNumber, commentId: comment.id, command: commandMeta.mode }, `/${commandMeta.mode} command: existing job found for PR, stored comment for batch processing`);
        return;
    }

    await enqueueNewCommentJob(strippedComment, commentAuthor, eventContext, { payload, redisClient, PR_FOLLOWUP_TRIGGER_KEYWORDS: config.PR_FOLLOWUP_TRIGGER_KEYWORDS, MODEL_LABEL_PATTERN: config.MODEL_LABEL_PATTERN, correlationId, commandMeta });
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
    const invalidModels = resolvedModels.filter(m => !MODEL_INFO_MAP[m]);
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
    const { eventType, prNumber, owner, repo } = eventContext;
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

    // 2. Check for existing active/waiting jobs (batching/concurrency guard) BEFORE
    //    posting comments or mutating labels to avoid duplicate side effects.
    const strippedComment = { ...comment, body: commandMeta.instructions || '' };
    const existingJob = await checkExistingJob(prNumber, owner, repo);
    if (existingJob) {
        // Store the original ultrafix meta so commandMode is 'ultrafix', not a provisional value.
        // The actual initial action (review vs fix) will be determined when the batch is processed.
        await storeCommentForBatch(
            { ...strippedComment, ...buildPendingCommandFields(commandMeta), ultrafixMeta: commandMeta },
            commentAuthor,
            eventContext,
            { redisClient, PR_FOLLOWUP_TRIGGER_KEYWORDS: config.PR_FOLLOWUP_TRIGGER_KEYWORDS },
        );
        correlatedLogger.info({ pullRequestNumber: prNumber, commentId: comment.id }, '/ultrafix command: existing job found for PR, stored comment for batch processing');
        return;
    }

    // 3. Query pending review state to decide initial action
    const octokit = await getAuthenticatedOctokit();
    const prComments = await withRetry(
        () => octokit.paginate('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', { owner, repo, issue_number: prNumber, per_page: 100 }),
        { maxAttempts: 3, baseDelay: 2000, maxDelay: 10000, exponentialBase: 2 },
        `get_pr_comments_${owner}_${repo}_${prNumber}`
    ) as Array<{ id: number; body: string | null; user: { login: string; type?: string }; created_at: string }>;

    const { hasPendingReview } = await deps.getPendingReviewState(
        prComments as Array<{ id: number; body: string | null; user: { login: string; type?: string }; created_at: string }>,
        { repoOwner: owner, repoName: repo, pullRequestNumber: prNumber, redisClient, correlatedLogger },
    );

    // 4. Add `ultrafix` label to the PR
    const prData = await getPRBranchAndLabels(eventType, payload, { owner, repo, prNumber });
    const hasUltrafixLabel = prData.prLabels.some(l => l.name === 'ultrafix');
    const labelWasAdded = !hasUltrafixLabel;
    if (labelWasAdded) {
        await safeUpdateLabels(
            { octokit, owner, repo, issueNumber: prNumber, logger: correlatedLogger },
            [],
            ['ultrafix'],
        );
    }

    // 5. Determine the initial action based on pending review state
    const initialAction: 'review' | 'fix' = hasPendingReview ? 'fix' : 'review';

    try {
        // 6. Post a circuit-breaker comment
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

        // 7. Persist ultrafix state in Redis after label + comment are committed
        await deps.startLoop(redisClient, {
            owner,
            repo,
            pr: prNumber,
            goal: effectiveGoal,
            maxCycles: effectiveMaxCycles,
            pauseSeconds: effectivePauseSeconds,
            reviewModel: effectiveReviewModel,
        }, hasPendingReview);

        correlatedLogger.info(
            { pullRequestNumber: prNumber, initialAction, effectiveGoal, effectiveMaxCycles, effectivePauseSeconds, effectiveReviewModel },
            `/ultrafix initialized, first action: ${initialAction}`,
        );

        // 9. Build a command meta for the first action (review or fix), carrying ultrafix metadata
        const firstActionMeta: CommandMeta = initialAction === 'review'
            ? { mode: 'review', models: effectiveReviewModel ? [effectiveReviewModel] : [], instructions: commandMeta.instructions }
            : { mode: 'fix', instructions: commandMeta.instructions };

        // 10. Enqueue the first step with ultrafix metadata
        await enqueueNewCommentJob(strippedComment, commentAuthor, eventContext, {
            payload,
            redisClient,
            PR_FOLLOWUP_TRIGGER_KEYWORDS: config.PR_FOLLOWUP_TRIGGER_KEYWORDS,
            MODEL_LABEL_PATTERN: config.MODEL_LABEL_PATTERN,
            correlationId,
            commandMeta: firstActionMeta,
            prefetchedPRData: prData,
            ultrafixMeta: commandMeta,
        });
    } catch (error) {
        // Rollback: remove the ultrafix label if we added it, clear loop state, and post a failure comment
        correlatedLogger.error({ pullRequestNumber: prNumber, error }, '/ultrafix startup failed after side effects, rolling back');
        try {
            // Clear any persisted ultrafix loop state to avoid orphaned records
            await deps.clearState(redisClient, owner, repo, prNumber);

            if (labelWasAdded) {
                await safeUpdateLabels(
                    { octokit, owner, repo, issueNumber: prNumber, logger: correlatedLogger },
                    ['ultrafix'],
                    [],
                );
            }
            await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
                owner,
                repo,
                issue_number: prNumber,
                body: `❌ **Ultrafix loop failed to start.** The ultrafix label has been removed. Please try again.\n\nIf the problem persists, check the system logs for details.`,
            });
        } catch (rollbackError) {
            correlatedLogger.error({ pullRequestNumber: prNumber, rollbackError }, '/ultrafix rollback also failed');
        }
        throw error;
    }
}

export async function processCommentEvent(payload: IssueCommentEvent | PullRequestReviewCommentEvent, eventType: CommentEventType, correlationId: string, config: CommentEventConfig): Promise<void> {
    const { redisClient } = config;
    const correlatedLogger = logger.withCorrelation(correlationId);
    const owner = payload.repository.owner.login;
    const repo = payload.repository.name;
    const repoFullName = `${owner}/${repo}`;

    let prNumber: number;
    let comment: { id: number; body: string; user: { login: string }; path?: string; line?: number | null; diff_hunk?: string; pull_request_review_id?: number };

    if (eventType === 'issue_comment') {
        const issuePayload = payload as IssueCommentEvent;
        if (!issuePayload.issue.pull_request) { correlatedLogger.debug({ repository: repoFullName }, 'Issue comment is not on a PR, skipping'); return; }
        prNumber = issuePayload.issue.number;
        comment = issuePayload.comment;
    } else if (eventType === 'pull_request_review_comment') {
        const prPayload = payload as PullRequestReviewCommentEvent;
        prNumber = prPayload.pull_request.number;
        comment = prPayload.comment;
    } else { correlatedLogger.warn({ eventType }, 'Unknown event type for comment processing'); return; }

    const commentAuthor = comment.user.login;
    const filterResult = filterCommentByAuthor(commentAuthor, correlationId);
    if (filterResult.shouldFilter) return;

    // Check for ignore keywords
    const ignoreKeywords = await loadFollowupIgnoreKeywords();
    const ignoreResult = checkCommentIgnore(comment.body, ignoreKeywords, correlationId);
    if (ignoreResult.shouldIgnore) return;

    // Parse slash commands (/review, /fix, /merge, /switch, /use) before generic follow-up logic
    const parsedCommand = parseSlashCommand(comment.body);
    if (parsedCommand) {
        // Deduplicate redelivered webhooks — same check used for normal follow-up comments
        const slashCommentTrackingKey = `pr-comment-processed:${owner}:${repo}:${prNumber}:${comment.id}`;
        const alreadyProcessed = await redisClient.get(slashCommentTrackingKey);
        if (alreadyProcessed) {
            correlatedLogger.debug({ repository: repoFullName, pullRequestNumber: prNumber, commentId: comment.id }, 'Slash command comment already processed, skipping redelivery');
            return;
        }
        await handleSlashCommand({ parsedCommand, comment, commentAuthor, eventContext: { eventType, prNumber, owner, repo }, payload, config, correlationId, correlatedLogger });
        // Mark as processed to prevent duplicate webhook delivery.
        // enqueueNewCommentJob also sets this key, but not all slash command paths enqueue
        // (e.g. /merge, /switch without instructions), so set it unconditionally here.
        await redisClient.setex(slashCommentTrackingKey, 86400, Date.now().toString());
        return;
    }

    // Fetch PR labels early to check for processing label
    const { prLabels } = await getPRBranchAndLabels(eventType, payload, { owner, repo, prNumber });
    const hasProcessingLabel = await prHasProcessingLabel(prLabels);

    // Check trigger: PR must have a processing label OR comment must contain trigger keyword
    const triggerResult = checkCommentTrigger(comment.body, correlationId);
    if (!hasProcessingLabel && !triggerResult.isTriggered) {
        correlatedLogger.debug({ pullRequestNumber: prNumber, commentId: comment.id }, 'PR does not have processing label and comment does not contain trigger keyword, skipping');
        return;
    }

    if (hasProcessingLabel) {
        correlatedLogger.debug({ pullRequestNumber: prNumber, commentId: comment.id, prLabels: prLabels.map(l => l.name) }, 'PR has processing label, processing comment');
    }

    const commentTrackingKey = `pr-comment-processed:${owner}:${repo}:${prNumber}:${comment.id}`;
    const alreadyQueued = await redisClient.get(commentTrackingKey);
    if (alreadyQueued) { correlatedLogger.debug({ repository: repoFullName, pullRequestNumber: prNumber, commentId: comment.id, commentAuthor }, 'PR comment already queued/processed, skipping'); return; }

    const existingJob = await checkExistingJob(prNumber, owner, repo);
    if (existingJob) {
        await storeCommentForBatch(comment, commentAuthor, { eventType, prNumber, owner, repo }, config as StoreCommentConfig);
        correlatedLogger.info({ pullRequestNumber: prNumber, repository: repoFullName, commentId: comment.id }, 'A job for this PR is already active or waiting, stored comment for batch processing');
        return;
    }

    await enqueueNewCommentJob(comment, commentAuthor, { eventType, prNumber, owner, repo }, { payload, redisClient, PR_FOLLOWUP_TRIGGER_KEYWORDS: config.PR_FOLLOWUP_TRIGGER_KEYWORDS, MODEL_LABEL_PATTERN: config.MODEL_LABEL_PATTERN, correlationId });
}

async function checkExistingJob(prNumber: number, owner: string, repo: string): Promise<boolean> {
    const queue = await getIssueQueue();
    const activeJobs = await queue.getActive();
    const waitingJobs = await queue.getWaiting();
    const delayedJobs = await queue.getDelayed();
    const existingJobs = [...activeJobs, ...waitingJobs, ...delayedJobs] as Job<PRJobData>[];
    return existingJobs.some(job => job.name === 'processPullRequestComment' && job.data.pullRequestNumber === prNumber && job.data.repoOwner === owner && job.data.repoName === repo);
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
    };
    await redisClient.rpush(pendingCommentsKey, JSON.stringify(pendingComment));
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

function prepareComment(comment: { id: number; body: string; path?: string; line?: number | null; diff_hunk?: string; pull_request_review_id?: number }, commentAuthor: string, eventType: CommentEventType, keywords: string[]): { enhancedBody: string; unprocessedComment: UnprocessedComment; llmFromKeywords: string | null } {
    const llmFromKeywords = keywords.length > 0 ? extractLlmFromKeywords(comment.body, keywords) : null;
    let enhancedBody = keywords.length > 0 ? stripKeywordsFromBody(comment.body, keywords) : comment.body;

    if (isReviewComment(comment, eventType)) {
        const codeContext = buildCodeContext(comment);
        if (codeContext.length > 0) enhancedBody = `${enhancedBody}\n\n--- Review Comment Context ---\n${codeContext.join('\n')}`;
    }

    const commentType = isReviewComment(comment, eventType) ? 'review' as const : 'issue' as const;
    const unprocessedComment: UnprocessedComment = { id: comment.id, body: enhancedBody, author: commentAuthor, type: commentType, hasCodeContext: commentType === 'review' && !!comment.diff_hunk };
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

    return {
        commandMeta,
        commandMode,
        requestedModels: commandMeta.mode === 'review' ? commandMeta.models : undefined,
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

async function enqueueNewCommentJob(comment: { id: number; body: string; path?: string; line?: number | null; diff_hunk?: string; pull_request_review_id?: number }, commentAuthor: string, eventContext: CommentContext, options: EnqueueCommentOptions): Promise<void> {
    const { eventType, prNumber, owner, repo } = eventContext;
    const { payload, redisClient, PR_FOLLOWUP_TRIGGER_KEYWORDS, correlationId, MODEL_LABEL_PATTERN = '^llm-(.+)$', commandMeta, prefetchedPRData, ultrafixMeta } = options;
    const correlatedLogger = logger.withCorrelation(correlationId);

    const { unprocessedComment, llmFromKeywords } = prepareComment(comment, commentAuthor, eventType, PR_FOLLOWUP_TRIGGER_KEYWORDS);
    const { branchName, prLabels } = prefetchedPRData || await getPRBranchAndLabels(eventType, payload, { owner, repo, prNumber });
    const llm = resolveLlm(llmFromKeywords, prLabels, { modelLabelPattern: MODEL_LABEL_PATTERN, prNumber, correlatedLogger, commandMeta });

    const jobData: CommentJobData = {
        pullRequestNumber: prNumber, comments: [unprocessedComment], repoOwner: owner, repoName: repo, branchName, llm, correlationId: generateCorrelationId(),
        ...(commandMeta ? buildCommandJobFields(commandMeta) : {}),
        ...(ultrafixMeta ? { ultrafixMeta } : {}),
    };
    const timestamp = Date.now();
    const jobId = `pr-comments-batch-${owner}-${repo}-${prNumber}-${timestamp}`;
    const commentTrackingKey = `pr-comment-processed:${owner}:${repo}:${prNumber}:${comment.id}`;

    try {
        const queue = await getIssueQueue();
        await queue.add('processPullRequestComment', jobData, {
            jobId,
            delay: COMMENT_BATCH_DELAY_MS,
            attempts: 3,
            backoff: { type: 'exponential', delay: 10000 },  // 10s, 20s, 40s
        });
        await redisClient.setex(commentTrackingKey, 86400, Date.now().toString());
        correlatedLogger.info({ jobId, pullRequestNumber: prNumber, commentId: comment.id, commentType: unprocessedComment.type, delayMs: COMMENT_BATCH_DELAY_MS }, `Successfully added PR comment job with ${COMMENT_BATCH_DELAY_MS}ms delay`);
    } catch (error) {
        const err = error as Error;
        if (err.message?.includes('Job already exists')) correlatedLogger.debug({ pullRequestNumber: prNumber }, 'PR comment job already in queue, skipping');
        else handleError(error, `Failed to add PR comment to queue`, { correlationId });
    }
}
