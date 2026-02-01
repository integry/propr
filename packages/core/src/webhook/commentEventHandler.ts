import logger, { generateCorrelationId } from '../utils/logger.js';
import { handleError } from '../utils/errorHandler.js';
import { issueQueue, COMMENT_BATCH_DELAY_MS, type CommentJobData, type UnprocessedComment } from '../queue/taskQueue.js';
import { filterCommentByAuthor, checkCommentTrigger, checkCommentIgnore } from '../utils/commentFilters.js';
import { loadFollowupIgnoreKeywords } from '../config/configManager.js';
import { getAuthenticatedOctokit } from '../auth/githubAuth.js';
import { getPendingPrCommentsKey } from '../utils/constants.js';
import { withRetry } from '../utils/retryHandler.js';
import type { Job } from 'bullmq';
import type { Redis } from 'ioredis';
import type { IssueCommentEvent, PullRequestReviewCommentEvent, Label } from '@octokit/webhooks-types';
import { extractLlmFromKeywords, stripKeywordsFromBody, buildCodeContext, isReviewComment, extractLlmFromLabels } from './commentEventHelpers.js';

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
interface EnqueueCommentOptions { payload: IssueCommentEvent | PullRequestReviewCommentEvent; redisClient: Redis; PR_FOLLOWUP_TRIGGER_KEYWORDS: string[]; MODEL_LABEL_PATTERN?: string; correlationId: string }
interface RepoContext { owner: string; repo: string; prNumber: number }
interface PRBranchAndLabels { branchName: string; prLabels: Label[] }

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
    const activeJobs = await issueQueue.getActive();
    const waitingJobs = await issueQueue.getWaiting();
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
    const activeJobs = await issueQueue.getActive();
    const waitingJobs = await issueQueue.getWaiting();
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

    const triggerResult = checkCommentTrigger(comment.body, correlationId);
    if (!triggerResult.isTriggered) return;

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
    const activeJobs = await issueQueue.getActive();
    const waitingJobs = await issueQueue.getWaiting();
    const delayedJobs = await issueQueue.getDelayed();
    const existingJobs = [...activeJobs, ...waitingJobs, ...delayedJobs] as Job<PRJobData>[];
    return existingJobs.some(job => job.name === 'processPullRequestComment' && job.data.pullRequestNumber === prNumber && job.data.repoOwner === owner && job.data.repoName === repo);
}

async function storeCommentForBatch(comment: { id: number; body: string; path?: string; line?: number | null; diff_hunk?: string; pull_request_review_id?: number }, commentAuthor: string, eventContext: CommentContext, config: StoreCommentConfig): Promise<void> {
    const { eventType, prNumber, owner, repo } = eventContext;
    const { redisClient, PR_FOLLOWUP_TRIGGER_KEYWORDS } = config;
    const pendingCommentsKey = getPendingPrCommentsKey(owner, repo, prNumber);
    const strippedCommentBody = PR_FOLLOWUP_TRIGGER_KEYWORDS.length > 0 ? stripKeywordsFromBody(comment.body, PR_FOLLOWUP_TRIGGER_KEYWORDS) : comment.body;
    const pendingComment: UnprocessedComment = { id: comment.id, body: strippedCommentBody, author: commentAuthor, type: isReviewComment(comment, eventType) ? 'review' : 'issue', hasCodeContext: false };
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

async function enqueueNewCommentJob(comment: { id: number; body: string; path?: string; line?: number | null; diff_hunk?: string; pull_request_review_id?: number }, commentAuthor: string, eventContext: CommentContext, options: EnqueueCommentOptions): Promise<void> {
    const { eventType, prNumber, owner, repo } = eventContext;
    const { payload, redisClient, PR_FOLLOWUP_TRIGGER_KEYWORDS, correlationId, MODEL_LABEL_PATTERN = '^llm-(.+)$' } = options;
    const correlatedLogger = logger.withCorrelation(correlationId);

    let llm: string | null = PR_FOLLOWUP_TRIGGER_KEYWORDS.length > 0 ? extractLlmFromKeywords(comment.body, PR_FOLLOWUP_TRIGGER_KEYWORDS) : null;
    let enhancedCommentBody = PR_FOLLOWUP_TRIGGER_KEYWORDS.length > 0 ? stripKeywordsFromBody(comment.body, PR_FOLLOWUP_TRIGGER_KEYWORDS) : comment.body;

    if (isReviewComment(comment, eventType)) {
        const codeContext = buildCodeContext(comment);
        if (codeContext.length > 0) enhancedCommentBody = `${comment.body}\n\n--- Review Comment Context ---\n${codeContext.join('\n')}`;
    }

    const unprocessedComment: UnprocessedComment = { id: comment.id, body: enhancedCommentBody, author: commentAuthor, type: isReviewComment(comment, eventType) ? 'review' : 'issue', hasCodeContext: isReviewComment(comment, eventType) && !!comment.diff_hunk };
    const { branchName, prLabels } = await getPRBranchAndLabels(eventType, payload, { owner, repo, prNumber });
    if (!llm && prLabels.length > 0) llm = extractLlmFromLabels(prLabels, MODEL_LABEL_PATTERN, prNumber, correlatedLogger);

    const jobData: CommentJobData = { pullRequestNumber: prNumber, comments: [unprocessedComment], repoOwner: owner, repoName: repo, branchName, llm, correlationId: generateCorrelationId() };
    const timestamp = Date.now();
    const jobId = `pr-comments-batch-${owner}-${repo}-${prNumber}-${timestamp}`;
    const commentTrackingKey = `pr-comment-processed:${owner}:${repo}:${prNumber}:${comment.id}`;

    try {
        await issueQueue.add('processPullRequestComment', jobData, { jobId, delay: COMMENT_BATCH_DELAY_MS });
        await redisClient.setex(commentTrackingKey, 86400, Date.now().toString());
        correlatedLogger.info({ jobId, pullRequestNumber: prNumber, commentId: comment.id, commentType: unprocessedComment.type, delayMs: COMMENT_BATCH_DELAY_MS }, `Successfully added PR comment job with ${COMMENT_BATCH_DELAY_MS}ms delay`);
    } catch (error) {
        const err = error as Error;
        if (err.message?.includes('Job already exists')) correlatedLogger.debug({ pullRequestNumber: prNumber }, 'PR comment job already in queue, skipping');
        else handleError(error, `Failed to add PR comment to queue`, { correlationId });
    }
}
