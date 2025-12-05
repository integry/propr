import logger, { generateCorrelationId } from '../utils/logger.js';
import { handleError } from '../utils/errorHandler.js';
import { issueQueue, COMMENT_BATCH_DELAY_MS } from '../queue/taskQueue.js';
import { filterCommentByAuthor, checkCommentTrigger } from '../utils/commentFilters.js';
import { resolveModelAlias } from '../config/modelAliases.js';
import { getAuthenticatedOctokit } from '../auth/githubAuth.js';
import { getPendingPrCommentsKey } from '../utils/constants.js';

export async function handleCommentDeleted(payload, eventType, correlationId, config) {
    const { redisClient } = config;
    const correlatedLogger = logger.withCorrelation(correlationId);
    
    const owner = payload.repository.owner.login;
    const repo = payload.repository.name;
    const repoFullName = `${owner}/${repo}`;
    
    let prNumber, commentId;
    
    if (eventType === 'issue_comment') {
        if (!payload.issue.pull_request) {
            correlatedLogger.debug({ repository: repoFullName }, 'Issue comment is not on a PR, skipping');
            return;
        }
        prNumber = payload.issue.number;
        commentId = payload.comment.id;
    } else if (eventType === 'pull_request_review_comment') {
        prNumber = payload.pull_request.number;
        commentId = payload.comment.id;
    } else {
        correlatedLogger.warn({ eventType }, 'Unknown event type for comment deletion');
        return;
    }
    
    correlatedLogger.info({
        repository: repoFullName,
        pullRequestNumber: prNumber,
        commentId: commentId
    }, 'Comment deleted, aborting any active jobs for this PR');
    
    const activeJobs = await issueQueue.getActive();
    const waitingJobs = await issueQueue.getWaiting();
    const allJobs = [...activeJobs, ...waitingJobs];
    
    for (const job of allJobs) {
        if (job.name === 'processPullRequestComment' &&
            job.data.pullRequestNumber === prNumber &&
            job.data.repoOwner === owner &&
            job.data.repoName === repo) {
            
            const jobCommentIds = job.data.comments?.map(c => c.id) || [];
            if (jobCommentIds.includes(commentId)) {
                correlatedLogger.info({
                    jobId: job.id,
                    pullRequestNumber: prNumber,
                    repository: repoFullName
                }, 'Aborting job due to comment deletion');
                
                const taskId = job.id.startsWith('pr-comments-batch-') ? 
                    job.id.replace(/^pr-comments-batch-/, '').replace(/-\d+$/, '') : 
                    `${owner}-${repo}-${prNumber}`;
                
                const abortKey = `worker:abort:${taskId}`;
                await redisClient.set(abortKey, JSON.stringify({
                    timestamp: new Date().toISOString(),
                    reason: 'comment_deleted',
                    commentId: commentId
                }), { EX: 3600 });
                
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

export async function handleCommentEdited(payload, eventType, correlationId, config) {
    const { redisClient, processCommentEvent } = config;
    const correlatedLogger = logger.withCorrelation(correlationId);
    
    const owner = payload.repository.owner.login;
    const repo = payload.repository.name;
    const repoFullName = `${owner}/${repo}`;
    
    let prNumber, commentId;
    
    if (eventType === 'issue_comment') {
        if (!payload.issue.pull_request) {
            correlatedLogger.debug({ repository: repoFullName }, 'Issue comment is not on a PR, skipping');
            return;
        }
        prNumber = payload.issue.number;
        commentId = payload.comment.id;
    } else if (eventType === 'pull_request_review_comment') {
        prNumber = payload.pull_request.number;
        commentId = payload.comment.id;
    } else {
        correlatedLogger.warn({ eventType }, 'Unknown event type for comment edit');
        return;
    }
    
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
        if (job.name === 'processPullRequestComment' &&
            job.data.pullRequestNumber === prNumber &&
            job.data.repoOwner === owner &&
            job.data.repoName === repo) {
            
            const jobCommentIds = job.data.comments?.map(c => c.id) || [];
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
        
        const taskId = foundJob.id.startsWith('pr-comments-batch-') ? 
            foundJob.id.replace(/^pr-comments-batch-/, '').replace(/-\d+$/, '') : 
            `${owner}-${repo}-${prNumber}`;
        
        const abortKey = `worker:abort:${taskId}`;
        await redisClient.set(abortKey, JSON.stringify({
            timestamp: new Date().toISOString(),
            reason: 'comment_edited',
            commentId: commentId
        }), { EX: 3600 });
        
        await foundJob.remove();
    }
    
    const commentTrackingKey = `pr-comment-processed:${owner}:${repo}:${prNumber}:${commentId}`;
    await redisClient.del(commentTrackingKey);
    
    correlatedLogger.info({
        pullRequestNumber: prNumber,
        repository: repoFullName,
        commentId: commentId
    }, 'Reprocessing edited comment');
    
    await processCommentEvent(payload, eventType, correlationId);
}

export async function processCommentEvent(payload, eventType, correlationId, config) {
    const { redisClient } = config;
    
    const correlatedLogger = logger.withCorrelation(correlationId);
    
    const owner = payload.repository.owner.login;
    const repo = payload.repository.name;
    const repoFullName = `${owner}/${repo}`;
    
    let prNumber, comment;
    
    if (eventType === 'issue_comment') {
        if (!payload.issue.pull_request) {
            correlatedLogger.debug({ repository: repoFullName }, 'Issue comment is not on a PR, skipping');
            return;
        }
        prNumber = payload.issue.number;
        comment = payload.comment;
    } else if (eventType === 'pull_request_review_comment') {
        prNumber = payload.pull_request.number;
        comment = payload.comment;
    } else {
        correlatedLogger.warn({ eventType }, 'Unknown event type for comment processing');
        return;
    }
    
    const commentAuthor = comment.user.login;
    const filterResult = filterCommentByAuthor(commentAuthor, correlationId);
    if (filterResult.shouldFilter) return;

    const triggerResult = checkCommentTrigger(comment.body, correlationId);
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
    
    await enqueueNewCommentJob(comment, commentAuthor, { eventType, prNumber, owner, repo }, { payload, redisClient, PR_FOLLOWUP_TRIGGER_KEYWORDS: config.PR_FOLLOWUP_TRIGGER_KEYWORDS, MODEL_LABEL_PATTERN: config.MODEL_LABEL_PATTERN, correlationId });
}

async function checkExistingJob(prNumber, owner, repo) {
    const activeJobs = await issueQueue.getActive();
    const waitingJobs = await issueQueue.getWaiting();
    const delayedJobs = await issueQueue.getDelayed();
    const existingJobs = [...activeJobs, ...waitingJobs, ...delayedJobs];

    return existingJobs.some(job =>
        job.name === 'processPullRequestComment' &&
        job.data.pullRequestNumber === prNumber &&
        job.data.repoOwner === owner &&
        job.data.repoName === repo
    );
}

async function storeCommentForBatch(comment, commentAuthor, eventContext, config) {
    const { eventType, prNumber, owner, repo } = eventContext;
    const { redisClient, PR_FOLLOWUP_TRIGGER_KEYWORDS } = config;
    const pendingCommentsKey = getPendingPrCommentsKey(owner, repo, prNumber);

    let enhancedCommentBody = comment.body;
    if (PR_FOLLOWUP_TRIGGER_KEYWORDS.length > 0) {
        for (const keyword of PR_FOLLOWUP_TRIGGER_KEYWORDS) {
            const escapedKeyword = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            enhancedCommentBody = enhancedCommentBody.replace(new RegExp(`${escapedKeyword}(:\\w+)?`, 'g'), '');
        }
    }
    enhancedCommentBody = enhancedCommentBody.trim();

    const pendingComment = {
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

function extractLlmFromKeywords(commentBody, keywords) {
    for (const keyword of keywords) {
        const llmMatch = commentBody.match(new RegExp(`${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:([\\w.-]+)`));
        if (llmMatch) {
            const resolved = resolveModelAlias(llmMatch[1]);
            if (resolved) return resolved;
        }
    }
    return null;
}

function stripKeywordsFromBody(body, keywords) {
    let result = body;
    for (const keyword of keywords) {
        const escapedKeyword = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        result = result.replace(new RegExp(`${escapedKeyword}(:\\w+)?`, 'g'), '');
    }
    return result.trim();
}

function buildCodeContext(comment) {
    const codeContext = [];
    if (comment.path) codeContext.push(`File: ${comment.path}`);
    if (comment.line) codeContext.push(`Line: ${comment.line}`);
    if (comment.diff_hunk) {
        codeContext.push('Code context:', '```diff', comment.diff_hunk, '```');
    }
    return codeContext;
}

function isReviewComment(comment, eventType) {
    return comment.pull_request_review_id || eventType === 'pull_request_review_comment';
}

function extractLlmFromLabels(prLabels, modelLabelPattern, prNumber, correlatedLogger) {
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

async function getPRBranchAndLabels(eventType, payload, repoContext) {
    const { owner, repo, prNumber } = repoContext;
    if (eventType === 'issue_comment') {
        const octokit = await getAuthenticatedOctokit();
        const { data: pr } = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', { owner, repo, pull_number: prNumber });
        return { branchName: pr.head.ref, prLabels: pr.labels || [] };
    }
    return { branchName: payload.pull_request.head.ref, prLabels: payload.pull_request.labels || [] };
}

async function enqueueNewCommentJob(comment, commentAuthor, eventContext, options) {
    const { eventType, prNumber, owner, repo } = eventContext;
    const { payload, redisClient, PR_FOLLOWUP_TRIGGER_KEYWORDS, correlationId, MODEL_LABEL_PATTERN = DEFAULT_MODEL_LABEL_PATTERN } = options;
    const correlatedLogger = logger.withCorrelation(correlationId);
    
    let llm = PR_FOLLOWUP_TRIGGER_KEYWORDS.length > 0 ? extractLlmFromKeywords(comment.body, PR_FOLLOWUP_TRIGGER_KEYWORDS) : null;
    
    let enhancedCommentBody = PR_FOLLOWUP_TRIGGER_KEYWORDS.length > 0 ? stripKeywordsFromBody(comment.body, PR_FOLLOWUP_TRIGGER_KEYWORDS) : comment.body;
    
    if (isReviewComment(comment, eventType)) {
        const codeContext = buildCodeContext(comment);
        if (codeContext.length > 0) {
            enhancedCommentBody = `${comment.body}\n\n--- Review Comment Context ---\n${codeContext.join('\n')}`;
        }
    }
    
    const unprocessedComment = {
        id: comment.id, body: enhancedCommentBody, author: commentAuthor,
        type: isReviewComment(comment, eventType) ? 'review' : 'issue',
        hasCodeContext: isReviewComment(comment, eventType) && comment.diff_hunk ? true : false
    };
    
    const { branchName, prLabels } = await getPRBranchAndLabels(eventType, payload, { owner, repo, prNumber });

    if (!llm && prLabels.length > 0) {
        llm = extractLlmFromLabels(prLabels, MODEL_LABEL_PATTERN, prNumber, correlatedLogger);
    }

    const jobData = {
        pullRequestNumber: prNumber, comments: [unprocessedComment], repoOwner: owner, repoName: repo,
        branchName, llm, correlationId: generateCorrelationId(),
    };
    
    const timestamp = Date.now();
    const jobId = `pr-comments-batch-${owner}-${repo}-${prNumber}-${timestamp}`;
    const commentTrackingKey = `pr-comment-processed:${owner}:${repo}:${prNumber}:${comment.id}`;
    
    try {
        await issueQueue.add('processPullRequestComment', jobData, { jobId, delay: COMMENT_BATCH_DELAY_MS });
        await redisClient.setex(commentTrackingKey, 86400, Date.now().toString());
        correlatedLogger.info({ jobId, pullRequestNumber: prNumber, commentId: comment.id, commentType: unprocessedComment.type, delayMs: COMMENT_BATCH_DELAY_MS }, `Successfully added PR comment job with ${COMMENT_BATCH_DELAY_MS}ms delay`);
    } catch (error) {
        if (error.message?.includes('Job already exists')) {
            correlatedLogger.debug({ pullRequestNumber: prNumber }, 'PR comment job already in queue, skipping');
        } else {
            handleError(error, `Failed to add PR comment to queue`, { correlationId });
        }
    }
}
