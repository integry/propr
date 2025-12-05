import logger, { generateCorrelationId } from '../utils/logger.js';
import type { Logger } from 'pino';
import { handleError } from '../utils/errorHandler.js';
import { issueQueue, COMMENT_BATCH_DELAY_MS, type CommentJobData } from '../queue/taskQueue.js';
import { filterCommentByAuthor, checkCommentTrigger } from '../utils/commentFilters.js';
import { resolveModelAlias } from '../config/modelAliases.js';
import { getAuthenticatedOctokit } from '../auth/githubAuth.js';
import { getPendingPrCommentsKey } from '../utils/constants.js';
import type {
    WebhookEvent,
    IssueCommentEvent,
    PullRequestReviewCommentEvent
} from '@octokit/webhooks-types';
import type { Redis } from 'ioredis';

type CommentEventType = 'issue_comment' | 'pull_request_review_comment';

interface EventConfig {
    redisClient: Redis;
    PR_FOLLOWUP_TRIGGER_KEYWORDS: string[];
    MODEL_LABEL_PATTERN?: string;
    processCommentEvent?: (payload: WebhookEvent, eventType: string, correlationId: string) => Promise<void>;
}

interface UnprocessedComment {
    id: number;
    body: string;
    author: string;
    type: 'review' | 'issue';
    hasCodeContext: boolean;
}

interface PRLabel {
    name: string;
}

function isIssueCommentEvent(payload: WebhookEvent, eventType: CommentEventType): payload is IssueCommentEvent {
    return eventType === 'issue_comment' && 'issue' in payload && 'comment' in payload;
}

function isPRReviewCommentEvent(payload: WebhookEvent, eventType: CommentEventType): payload is PullRequestReviewCommentEvent {
    return eventType === 'pull_request_review_comment' && 'pull_request' in payload && 'comment' in payload;
}

function extractPRNumber(payload: WebhookEvent, eventType: CommentEventType): number | null {
    if (isIssueCommentEvent(payload, eventType)) {
        if (!payload.issue.pull_request) return null;
        return payload.issue.number;
    }
    if (isPRReviewCommentEvent(payload, eventType)) {
        return payload.pull_request.number;
    }
    return null;
}

function extractComment(payload: WebhookEvent, eventType: CommentEventType): { id: number; body: string | null; user: { login: string }; pull_request_review_id?: number; path?: string; line?: number; diff_hunk?: string } | null {
    if (isIssueCommentEvent(payload, eventType) || isPRReviewCommentEvent(payload, eventType)) {
        return payload.comment as { id: number; body: string | null; user: { login: string }; pull_request_review_id?: number; path?: string; line?: number; diff_hunk?: string };
    }
    return null;
}

function extractRepoInfo(payload: WebhookEvent): { owner: string; repo: string; repoFullName: string } {
    const payloadWithRepo = payload as unknown as { repository: { owner: { login: string }; name: string } };
    const owner = payloadWithRepo.repository.owner.login;
    const repo = payloadWithRepo.repository.name;
    return { owner, repo, repoFullName: `${owner}/${repo}` };
}

export async function handleCommentDeleted(
    payload: WebhookEvent,
    eventType: CommentEventType,
    correlationId: string,
    config: EventConfig
): Promise<void> {
    const { redisClient } = config;
    const correlatedLogger = logger.withCorrelation(correlationId);
    const { owner, repo, repoFullName } = extractRepoInfo(payload);

    const prNumber = extractPRNumber(payload, eventType);
    if (prNumber === null) {
        correlatedLogger.debug({ repository: repoFullName }, 'Comment is not on a PR, skipping');
        return;
    }

    const comment = extractComment(payload, eventType);
    if (!comment) {
        correlatedLogger.warn({ eventType }, 'Could not extract comment from payload');
        return;
    }
    const commentId = comment.id;

    correlatedLogger.info({
        repository: repoFullName,
        pullRequestNumber: prNumber,
        commentId: commentId
    }, 'Comment deleted, aborting any active jobs for this PR');

    const activeJobs = await issueQueue.getActive();
    const waitingJobs = await issueQueue.getWaiting();
    const allJobs = [...activeJobs, ...waitingJobs];

    for (const job of allJobs) {
        const jobData = job.data as CommentJobData;
        if (job.name === 'processPullRequestComment' &&
            jobData.pullRequestNumber === prNumber &&
            jobData.repoOwner === owner &&
            jobData.repoName === repo) {

            const jobCommentIds = jobData.comments?.map(c => c.id) || [];
            if (jobCommentIds.includes(commentId)) {
                correlatedLogger.info({
                    jobId: job.id,
                    pullRequestNumber: prNumber,
                    repository: repoFullName
                }, 'Aborting job due to comment deletion');

                const taskId = job.id?.startsWith('pr-comments-batch-') ?
                    job.id.replace(/^pr-comments-batch-/, '').replace(/-\d+$/, '') :
                    `${owner}-${repo}-${prNumber}`;

                const abortKey = `worker:abort:${taskId}`;
                await redisClient.set(abortKey, JSON.stringify({
                    timestamp: new Date().toISOString(),
                    reason: 'comment_deleted',
                    commentId: commentId
                }), 'EX', 3600);

                await job.remove();

                correlatedLogger.info({
                    jobId: job.id,
                    taskId: taskId
                }, 'Job aborted and removed from queue');
            }
        }
    }

    const commentTrackingKey = `pr-comment-processed:${owner}:${repo}:${prNumber}:${commentId}`;
    await redisClient.del(commentTrackingKey);
}

export async function handleCommentEdited(
    payload: WebhookEvent,
    eventType: CommentEventType,
    correlationId: string,
    config: EventConfig
): Promise<void> {
    const { redisClient, processCommentEvent } = config;
    const correlatedLogger = logger.withCorrelation(correlationId);
    const { owner, repo, repoFullName } = extractRepoInfo(payload);

    const prNumber = extractPRNumber(payload, eventType);
    if (prNumber === null) {
        correlatedLogger.debug({ repository: repoFullName }, 'Comment is not on a PR, skipping');
        return;
    }

    const comment = extractComment(payload, eventType);
    if (!comment) {
        correlatedLogger.warn({ eventType }, 'Could not extract comment from payload');
        return;
    }
    const commentId = comment.id;

    correlatedLogger.info({
        repository: repoFullName,
        pullRequestNumber: prNumber,
        commentId: commentId
    }, 'Comment edited, restarting any active jobs for this PR');

    const activeJobs = await issueQueue.getActive();
    const waitingJobs = await issueQueue.getWaiting();
    const allJobs = [...activeJobs, ...waitingJobs];

    let foundJob = null;
    for (const job of allJobs) {
        const jobData = job.data as CommentJobData;
        if (job.name === 'processPullRequestComment' &&
            jobData.pullRequestNumber === prNumber &&
            jobData.repoOwner === owner &&
            jobData.repoName === repo) {

            const jobCommentIds = jobData.comments?.map(c => c.id) || [];
            if (jobCommentIds.includes(commentId)) {
                foundJob = job;
                break;
            }
        }
    }

    if (foundJob) {
        correlatedLogger.info({
            jobId: foundJob.id,
            pullRequestNumber: prNumber,
            repository: repoFullName
        }, 'Aborting existing job due to comment edit');

        const taskId = foundJob.id?.startsWith('pr-comments-batch-') ?
            foundJob.id.replace(/^pr-comments-batch-/, '').replace(/-\d+$/, '') :
            `${owner}-${repo}-${prNumber}`;

        const abortKey = `worker:abort:${taskId}`;
        await redisClient.set(abortKey, JSON.stringify({
            timestamp: new Date().toISOString(),
            reason: 'comment_edited',
            commentId: commentId
        }), 'EX', 3600);

        await foundJob.remove();
    }

    const commentTrackingKey = `pr-comment-processed:${owner}:${repo}:${prNumber}:${commentId}`;
    await redisClient.del(commentTrackingKey);

    correlatedLogger.info({
        pullRequestNumber: prNumber,
        repository: repoFullName,
        commentId: commentId
    }, 'Reprocessing edited comment');

    if (processCommentEvent) {
        await processCommentEvent(payload, eventType, correlationId);
    }
}

export async function processCommentEvent(
    payload: WebhookEvent,
    eventType: CommentEventType,
    correlationId: string,
    config: EventConfig
): Promise<void> {
    const { redisClient } = config;
    const correlatedLogger = logger.withCorrelation(correlationId);
    const { owner, repo, repoFullName } = extractRepoInfo(payload);

    const prNumber = extractPRNumber(payload, eventType);
    if (prNumber === null) {
        correlatedLogger.debug({ repository: repoFullName }, 'Comment is not on a PR, skipping');
        return;
    }

    const comment = extractComment(payload, eventType);
    if (!comment) {
        correlatedLogger.warn({ eventType }, 'Could not extract comment from payload');
        return;
    }

    const commentAuthor = comment.user.login;
    const filterResult = filterCommentByAuthor(commentAuthor, correlationId);
    if (filterResult.shouldFilter) return;

    const triggerResult = checkCommentTrigger(comment.body || '', correlationId);
    if (!triggerResult.isTriggered) return;

    const commentTrackingKey = `pr-comment-processed:${owner}:${repo}:${prNumber}:${comment.id}`;
    const alreadyQueued = await redisClient.get(commentTrackingKey);

    if (alreadyQueued) {
        correlatedLogger.debug({
            repository: repoFullName,
            pullRequestNumber: prNumber,
            commentId: comment.id,
            commentAuthor
        }, 'PR comment already queued/processed, skipping');
        return;
    }

    const existingJob = await checkExistingJob(prNumber, owner, repo);

    if (existingJob) {
        await storeCommentForBatch(comment, commentAuthor, { eventType, prNumber, owner, repo }, config);
        correlatedLogger.info({
            pullRequestNumber: prNumber,
            repository: repoFullName,
            commentId: comment.id
        }, 'A job for this PR is already active or waiting, stored comment for batch processing');
        return;
    }

    await enqueueNewCommentJob(comment, commentAuthor, { eventType, prNumber, owner, repo }, { payload, redisClient, PR_FOLLOWUP_TRIGGER_KEYWORDS: config.PR_FOLLOWUP_TRIGGER_KEYWORDS, correlationId, MODEL_LABEL_PATTERN: config.MODEL_LABEL_PATTERN });
}

async function checkExistingJob(prNumber: number, owner: string, repo: string): Promise<boolean> {
    const activeJobs = await issueQueue.getActive();
    const waitingJobs = await issueQueue.getWaiting();
    const delayedJobs = await issueQueue.getDelayed();
    const existingJobs = [...activeJobs, ...waitingJobs, ...delayedJobs];

    return existingJobs.some(job => {
        const jobData = job.data as CommentJobData;
        return job.name === 'processPullRequestComment' &&
            jobData.pullRequestNumber === prNumber &&
            jobData.repoOwner === owner &&
            jobData.repoName === repo;
    });
}

interface EventContext {
    eventType: CommentEventType;
    prNumber: number;
    owner: string;
    repo: string;
}

interface CommentData {
    id: number;
    body: string | null;
    user: { login: string };
    pull_request_review_id?: number;
    path?: string;
    line?: number;
    diff_hunk?: string;
}

async function storeCommentForBatch(comment: CommentData, commentAuthor: string, eventContext: EventContext, config: EventConfig): Promise<void> {
    const { eventType, prNumber, owner, repo } = eventContext;
    const { redisClient, PR_FOLLOWUP_TRIGGER_KEYWORDS } = config;
    const pendingCommentsKey = getPendingPrCommentsKey(owner, repo, prNumber);

    let enhancedCommentBody = comment.body || '';
    if (PR_FOLLOWUP_TRIGGER_KEYWORDS.length > 0) {
        for (const keyword of PR_FOLLOWUP_TRIGGER_KEYWORDS) {
            const escapedKeyword = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            enhancedCommentBody = enhancedCommentBody.replace(new RegExp(`${escapedKeyword}(:\\w+)?`, 'g'), '');
        }
    }
    enhancedCommentBody = enhancedCommentBody.trim();

    const pendingComment: UnprocessedComment = {
        id: comment.id,
        body: enhancedCommentBody,
        author: commentAuthor,
        type: (comment.pull_request_review_id || eventType === 'pull_request_review_comment') ? 'review' : 'issue',
        hasCodeContext: false
    };

    await redisClient.rpush(pendingCommentsKey, JSON.stringify(pendingComment));
    await redisClient.expire(pendingCommentsKey, 3600);
}

const DEFAULT_MODEL_LABEL_PATTERN = '^llm-claude-(.+)$';

function extractLlmFromKeywords(commentBody: string, keywords: string[]): string | null {
    for (const keyword of keywords) {
        const llmMatch = commentBody.match(new RegExp(`${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:([\\w.-]+)`));
        if (llmMatch) {
            const resolved = resolveModelAlias(llmMatch[1]);
            if (resolved) return resolved;
        }
    }
    return null;
}

function stripKeywordsFromBody(body: string, keywords: string[]): string {
    let result = body;
    for (const keyword of keywords) {
        const escapedKeyword = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        result = result.replace(new RegExp(`${escapedKeyword}(:\\w+)?`, 'g'), '');
    }
    return result.trim();
}

function buildCodeContext(comment: CommentData): string[] {
    const codeContext: string[] = [];
    if (comment.path) codeContext.push(`File: ${comment.path}`);
    if (comment.line) codeContext.push(`Line: ${comment.line}`);
    if (comment.diff_hunk) {
        codeContext.push('Code context:', '```diff', comment.diff_hunk, '```');
    }
    return codeContext;
}

function isReviewComment(comment: CommentData, eventType: CommentEventType): boolean {
    return !!comment.pull_request_review_id || eventType === 'pull_request_review_comment';
}

function extractLlmFromLabels(prLabels: PRLabel[], modelLabelPattern: string, prNumber: number, correlatedLogger: Logger): string | null {
    const modelLabelRegex = new RegExp(modelLabelPattern);
    for (const label of prLabels) {
        const labelName = typeof label === 'string' ? label : label.name;
        const match = labelName.match(modelLabelRegex);
        if (match) {
            const resolved = resolveModelAlias(match[1]);
            correlatedLogger.debug({ pullRequestNumber: prNumber, label: labelName, resolvedModel: resolved }, 'Extracted model from PR label (webhook)');
            return resolved;
        }
    }
    return null;
}

async function getPRBranchAndLabels(
    eventType: CommentEventType,
    payload: WebhookEvent,
    repoContext: { owner: string; repo: string; prNumber: number }
): Promise<{ branchName: string; prLabels: PRLabel[] }> {
    const { owner, repo, prNumber } = repoContext;
    if (eventType === 'issue_comment') {
        const octokit = await getAuthenticatedOctokit();
        const { data: pr } = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', { owner, repo, pull_number: prNumber }) as { data: { head: { ref: string }; labels: PRLabel[] } };
        return { branchName: pr.head.ref, prLabels: pr.labels || [] };
    }
    const reviewPayload = payload as PullRequestReviewCommentEvent;
    return { branchName: reviewPayload.pull_request.head.ref, prLabels: (reviewPayload.pull_request.labels || []) as PRLabel[] };
}

interface EnqueueOptions {
    payload: WebhookEvent;
    redisClient: Redis;
    PR_FOLLOWUP_TRIGGER_KEYWORDS: string[];
    correlationId: string;
    MODEL_LABEL_PATTERN?: string;
}

async function enqueueNewCommentJob(comment: CommentData, commentAuthor: string, eventContext: EventContext, options: EnqueueOptions): Promise<void> {
    const { eventType, prNumber, owner, repo } = eventContext;
    const { payload, redisClient, PR_FOLLOWUP_TRIGGER_KEYWORDS, correlationId, MODEL_LABEL_PATTERN = DEFAULT_MODEL_LABEL_PATTERN } = options;
    const correlatedLogger = logger.withCorrelation(correlationId);

    let llm = PR_FOLLOWUP_TRIGGER_KEYWORDS.length > 0 ? extractLlmFromKeywords(comment.body || '', PR_FOLLOWUP_TRIGGER_KEYWORDS) : null;

    let enhancedCommentBody = PR_FOLLOWUP_TRIGGER_KEYWORDS.length > 0 ? stripKeywordsFromBody(comment.body || '', PR_FOLLOWUP_TRIGGER_KEYWORDS) : (comment.body || '');

    if (isReviewComment(comment, eventType)) {
        const codeContext = buildCodeContext(comment);
        if (codeContext.length > 0) {
            enhancedCommentBody = `${comment.body}\n\n--- Review Comment Context ---\n${codeContext.join('\n')}`;
        }
    }

    const unprocessedComment: UnprocessedComment = {
        id: comment.id, body: enhancedCommentBody, author: commentAuthor,
        type: isReviewComment(comment, eventType) ? 'review' : 'issue',
        hasCodeContext: isReviewComment(comment, eventType) && !!comment.diff_hunk
    };

    const { branchName, prLabels } = await getPRBranchAndLabels(eventType, payload, { owner, repo, prNumber });

    if (!llm && prLabels.length > 0) {
        llm = extractLlmFromLabels(prLabels, MODEL_LABEL_PATTERN, prNumber, correlatedLogger);
    }

    const jobData: CommentJobData = {
        pullRequestNumber: prNumber, comments: [unprocessedComment], repoOwner: owner, repoName: repo,
        branchName, llm: llm || undefined, correlationId: generateCorrelationId(),
    };

    const timestamp = Date.now();
    const jobId = `pr-comments-batch-${owner}-${repo}-${prNumber}-${timestamp}`;
    const commentTrackingKey = `pr-comment-processed:${owner}:${repo}:${prNumber}:${comment.id}`;

    try {
        await issueQueue.add('processPullRequestComment', jobData, { jobId, delay: COMMENT_BATCH_DELAY_MS });
        await redisClient.setex(commentTrackingKey, 86400, Date.now().toString());
        correlatedLogger.info({ jobId, pullRequestNumber: prNumber, commentId: comment.id, commentType: unprocessedComment.type, delayMs: COMMENT_BATCH_DELAY_MS }, `Successfully added PR comment job with ${COMMENT_BATCH_DELAY_MS}ms delay`);
    } catch (error) {
        if ((error as Error).message?.includes('Job already exists')) {
            correlatedLogger.debug({ pullRequestNumber: prNumber }, 'PR comment job already in queue, skipping');
        } else {
            handleError(error as Error, `Failed to add PR comment to queue`, { correlationId });
        }
    }
}
