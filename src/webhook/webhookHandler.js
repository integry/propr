import { getAuthenticatedOctokit } from '../auth/githubAuth.js';
import logger from '../utils/logger.js';
import { resolveModelAlias } from '../config/modelAliases.js';
import { filterCommentByAuthor } from '../utils/commentFilters.js';

let processDetectedIssue;
let processCommentEvent;
let redisClient;
let issueQueue;

export async function initializeWebhookHandler(issueProcessor, commentProcessor, redis, queue) {
    processDetectedIssue = issueProcessor;
    processCommentEvent = commentProcessor;
    redisClient = redis;
    issueQueue = queue;
    logger.info('Webhook handler initialized');
}

export async function processWebhookEvent(payload, eventType, correlationId) {
    const correlatedLogger = logger.withCorrelation(correlationId);
    
    if (!processDetectedIssue || !processCommentEvent) {
        correlatedLogger.error('Webhook handler not properly initialized');
        throw new Error('Webhook handler not initialized');
    }
    
    const MODEL_LABEL_PATTERN = process.env.MODEL_LABEL_PATTERN || '^llm-claude-(.+)$';
    const DEFAULT_MODEL_NAME = process.env.DEFAULT_CLAUDE_MODEL || 'claude-3-5-sonnet-20241022';

    switch (eventType) {
        case 'issues':
            if (payload.action === 'labeled') {
                const [owner, repo] = payload.repository.full_name.split('/');
                
                const issue = {
                    id: payload.issue.id,
                    number: payload.issue.number,
                    title: payload.issue.title,
                    url: payload.issue.html_url,
                    repoOwner: owner,
                    repoName: repo,
                    labels: payload.issue.labels.map(l => l.name),
                    targetModels: [],
                    createdAt: payload.issue.created_at,
                    updatedAt: payload.issue.updated_at
                };
                
                const identifiedModels = [];
                const modelLabelRegex = new RegExp(MODEL_LABEL_PATTERN);
                
                for (const label of payload.issue.labels) {
                    const match = label.name.match(modelLabelRegex);
                    if (match && match[1]) {
                        const resolvedModel = resolveModelAlias(match[1]);
                        identifiedModels.push(resolvedModel);
                    }
                }
                
                issue.targetModels = identifiedModels.length > 0 ? identifiedModels : [DEFAULT_MODEL_NAME];
                
                await processDetectedIssue(issue, correlationId);
            }
            break;
            
        case 'issue_comment':
            if (payload.action === 'created' && payload.issue.pull_request) {
                const commentAuthor = payload.comment.user.login;
                const userType = payload.comment.user.type;
                const filterResult = filterCommentByAuthor(commentAuthor, userType, correlationId);

                if (filterResult.shouldFilter) {
                    return; // Skip this comment
                }

                await processCommentEvent(payload, 'issue_comment', correlationId);
            } else if (payload.action === 'deleted' && payload.issue.pull_request) {
                await handleCommentDeleted(payload, 'issue_comment', correlationId);
            } else if (payload.action === 'edited' && payload.issue.pull_request) {
                const commentAuthor = payload.comment.user.login;
                const userType = payload.comment.user.type;
                const filterResult = filterCommentByAuthor(commentAuthor, userType, correlationId);

                if (filterResult.shouldFilter) {
                    return; // Skip this comment
                }

                await handleCommentEdited(payload, 'issue_comment', correlationId);
            }
            break;

        case 'pull_request_review_comment':
            if (payload.action === 'created') {
                const commentAuthor = payload.comment.user.login;
                const userType = payload.comment.user.type;
                const filterResult = filterCommentByAuthor(commentAuthor, userType, correlationId);

                if (filterResult.shouldFilter) {
                    return; // Skip this comment
                }

                await processCommentEvent(payload, 'pull_request_review_comment', correlationId);
            } else if (payload.action === 'deleted') {
                await handleCommentDeleted(payload, 'pull_request_review_comment', correlationId);
            } else if (payload.action === 'edited') {
                const commentAuthor = payload.comment.user.login;
                const userType = payload.comment.user.type;
                const filterResult = filterCommentByAuthor(commentAuthor, userType, correlationId);

                if (filterResult.shouldFilter) {
                    return; // Skip this comment
                }

                await handleCommentEdited(payload, 'pull_request_review_comment', correlationId);
            }
            break;
            
        default:
            correlatedLogger.debug({ event: eventType }, 'Ignoring webhook event');
    }
}

async function handleCommentDeleted(payload, eventType, correlationId) {
    const correlatedLogger = logger.withCorrelation(correlationId);
    
    if (!redisClient || !issueQueue) {
        correlatedLogger.error('Redis client or queue not initialized in webhook handler');
        return;
    }
    
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

async function handleCommentEdited(payload, eventType, correlationId) {
    const correlatedLogger = logger.withCorrelation(correlationId);
    
    if (!redisClient || !issueQueue) {
        correlatedLogger.error('Redis client or queue not initialized in webhook handler');
        return;
    }
    
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
