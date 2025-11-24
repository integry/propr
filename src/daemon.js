import 'dotenv/config';
import { getAuthenticatedOctokit } from './auth/githubAuth.js';
import logger, { generateCorrelationId } from './utils/logger.js';
import { withErrorHandling, handleError } from './utils/errorHandler.js';
import { withRetry, retryConfigs } from './utils/retryHandler.js';
import { issueQueue, shutdownQueue, COMMENT_BATCH_DELAY_MS } from './queue/taskQueue.js';
import Redis from 'ioredis';
import { resolveModelAlias, getDefaultModel } from './config/modelAliases.js';
import { loadMonitoredRepos, ensureConfigRepoExists, loadSettings, loadAiPrimaryTag, loadPrimaryProcessingLabels } from './config/configRepoManager.js';
import { db, isEnabled as isDbEnabled } from './db/postgres.js';
import { initializeWebhookHandler } from './webhook/webhookHandler.js';
import { filterCommentByAuthor, checkCommentTrigger } from './utils/commentFilters.js';

// Create Redis client for activity logging
const redisClient = new Redis({
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
});

// Configuration from environment variables
const GITHUB_REPOS_TO_MONITOR = process.env.GITHUB_REPOS_TO_MONITOR;
const POLLING_INTERVAL_MS = parseInt(process.env.POLLING_INTERVAL_MS || '60000', 10);
let AI_PRIMARY_TAG = process.env.AI_PRIMARY_TAG || 'AI';
let primaryProcessingLabels = [];
const MODEL_LABEL_PATTERN = process.env.MODEL_LABEL_PATTERN || '^llm-claude-(.+)$';
const DEFAULT_MODEL_NAME = process.env.DEFAULT_CLAUDE_MODEL || getDefaultModel();

// New environment variables for PR comment monitoring
let GITHUB_BOT_USERNAME = process.env.GITHUB_BOT_USERNAME;
const GITHUB_USER_BLACKLIST = (process.env.GITHUB_USER_BLACKLIST || '').split(',').filter(u => u);
const PR_FOLLOWUP_TRIGGER_KEYWORDS = (process.env.PR_FOLLOWUP_TRIGGER_KEYWORDS !== undefined ? process.env.PR_FOLLOWUP_TRIGGER_KEYWORDS : '').split(',').filter(k => k.trim()).map(k => k.trim());

const ENABLE_WEBHOOKS = process.env.ENABLE_GITHUB_WEBHOOKS === 'true';

let monitoredRepos = [];
let GITHUB_USER_WHITELIST = (process.env.GITHUB_USER_WHITELIST || '').split(',').filter(u => u);

/**
 * Auto-detect the bot username by querying the GitHub API
 */
async function detectBotUsername() {
    if (GITHUB_BOT_USERNAME) {
        return GITHUB_BOT_USERNAME; // Already configured
    }

    try {
        const octokit = await getAuthenticatedOctokit();
        // GitHub Apps can't access GET /user, so we get the app info instead
        const { data: installation } = await octokit.request('GET /installation');
        // The bot username is the app slug with [bot] suffix
        GITHUB_BOT_USERNAME = `${installation.app_slug}[bot]`;
        logger.info({ botUsername: GITHUB_BOT_USERNAME }, 'Auto-detected bot username');
        return GITHUB_BOT_USERNAME;
    } catch (error) {
        logger.warn({ error: error.message }, 'Failed to auto-detect bot username, will use default');
        GITHUB_BOT_USERNAME = 'gitfixio[bot]';
        return GITHUB_BOT_USERNAME;
    }
}

async function loadReposFromConfig() {
    try {
        if (process.env.CONFIG_REPO) {
            monitoredRepos = await loadMonitoredRepos();
            logger.info({ repos: monitoredRepos }, 'Successfully loaded monitored repositories from config repo');
        } else {
            monitoredRepos = getReposFromEnv();
            logger.info({ repos: monitoredRepos }, 'Using repositories from environment variable');
        }
    } catch (error) {
        logger.error({ error: error.message }, 'Failed to load repositories from config, falling back to environment variable');
        monitoredRepos = getReposFromEnv();
    }
}

async function loadSettingsFromConfig() {
    try {
        if (process.env.CONFIG_REPO) {
            const settings = await loadSettings();
            
            if (settings.github_user_whitelist && Array.isArray(settings.github_user_whitelist)) {
                GITHUB_USER_WHITELIST = settings.github_user_whitelist;
                // Sync to process.env so commentFilters.js can access it
                process.env.GITHUB_USER_WHITELIST = settings.github_user_whitelist.join(',');
                logger.info({ whitelist: GITHUB_USER_WHITELIST }, 'Successfully loaded github_user_whitelist from config repo');
            } else if (process.env.GITHUB_USER_WHITELIST) {
                GITHUB_USER_WHITELIST = (process.env.GITHUB_USER_WHITELIST || '').split(',').filter(u => u);
                logger.info({ whitelist: GITHUB_USER_WHITELIST }, 'Using github_user_whitelist from environment variable');
            }
        }
    } catch (error) {
        logger.warn({ error: error.message }, 'Failed to load settings from config, using environment variable');
    }
}

async function loadAiPrimaryTagFromConfig() {
    try {
        if (process.env.CONFIG_REPO) {
            AI_PRIMARY_TAG = await loadAiPrimaryTag();
            logger.info({ ai_primary_tag: AI_PRIMARY_TAG }, 'Successfully loaded ai_primary_tag from config repo');
        } else if (process.env.AI_PRIMARY_TAG) {
            AI_PRIMARY_TAG = process.env.AI_PRIMARY_TAG;
            logger.info({ ai_primary_tag: AI_PRIMARY_TAG }, 'Using ai_primary_tag from environment variable');
        }
    } catch (error) {
        logger.warn({ error: error.message }, 'Failed to load ai_primary_tag from config, using default or environment variable');
        AI_PRIMARY_TAG = process.env.AI_PRIMARY_TAG || 'AI';
    }
}

async function loadPrimaryProcessingLabelsFromConfig() {
    try {
        if (process.env.CONFIG_REPO) {
            primaryProcessingLabels = await loadPrimaryProcessingLabels();
            logger.info({ primary_processing_labels: primaryProcessingLabels }, 'Successfully loaded primary_processing_labels from config repo');
        } else if (process.env.PRIMARY_PROCESSING_LABELS) {
            primaryProcessingLabels = process.env.PRIMARY_PROCESSING_LABELS.split(',').map(l => l.trim()).filter(l => l);
            logger.info({ primary_processing_labels: primaryProcessingLabels }, 'Using primary_processing_labels from environment variable');
        } else {
            primaryProcessingLabels = [AI_PRIMARY_TAG];
            logger.info({ primary_processing_labels: primaryProcessingLabels }, 'Using AI_PRIMARY_TAG as default primary processing label');
        }
    } catch (error) {
        logger.warn({ error: error.message }, 'Failed to load primary_processing_labels from config, using default');
        primaryProcessingLabels = [AI_PRIMARY_TAG || 'AI'];
    }
}

const getReposFromEnv = () => {
    if (!GITHUB_REPOS_TO_MONITOR) {
        return [];
    }
    return GITHUB_REPOS_TO_MONITOR.split(',').map(r => r.trim()).filter(r => r);
};

const getRepos = () => {
    return monitoredRepos;
};

/**
 * Processes a detected issue by checking labels, finding target models, and enqueueing jobs
 * @param {Object} issue - Issue object with properties: id, number, labels, repoOwner, repoName, etc.
 * @param {string} correlationId - Correlation ID for tracking
 */
async function processDetectedIssue(issue, correlationId) {
    const correlatedLogger = logger.withCorrelation(correlationId);
    const repoFullName = `${issue.repoOwner}/${issue.repoName}`;

    // Load primary processing labels if not already loaded (for webhook mode)
    if (primaryProcessingLabels.length === 0) {
        await loadPrimaryProcessingLabelsFromConfig();
    }

    const allExcludeLabels = [];
    for (const label of primaryProcessingLabels) {
        allExcludeLabels.push(`${label}-processing`);
        allExcludeLabels.push(`${label}-done`);
    }

    if (allExcludeLabels.some(excludeLabel => issue.labels.includes(excludeLabel))) {
        correlatedLogger.debug({
            issueNumber: issue.number,
            repository: repoFullName
        }, 'Issue has exclude labels, skipping');
        return;
    }

    const triggeringLabel = primaryProcessingLabels.find(pl => issue.labels.includes(pl));

    if (!triggeringLabel) {
        correlatedLogger.info({
            issueNumber: issue.number,
            repository: repoFullName,
            issueLabels: issue.labels,
            expectedLabels: primaryProcessingLabels
        }, 'Issue does not have any primary processing label, skipping');
        return;
    }

    correlatedLogger.info({
        issueId: issue.id,
        issueNumber: issue.number,
        issueTitle: issue.title,
        issueUrl: issue.url,
        repository: repoFullName,
        labels: issue.labels,
        triggeringLabel: triggeringLabel
    }, 'Detected eligible issue');

    // Check if a job for this issue already exists
    const activeJobs = await issueQueue.getActive();
    const waitingJobs = await issueQueue.getWaiting();
    const existingJobs = [...activeJobs, ...waitingJobs];

    const jobExists = existingJobs.some(job =>
        job.name === 'processGitHubIssue' &&
        job.data.number === issue.number &&
        job.data.repoOwner === issue.repoOwner &&
        job.data.repoName === issue.repoName &&
        !job.data.isChildJob // Only check parent jobs
    );

    if (jobExists) {
        correlatedLogger.debug({
            issueNumber: issue.number,
            repository: repoFullName
        }, 'A parent job for this issue is already active or waiting, skipping duplicate');
        return;
    }

    correlatedLogger.info({
        issueId: issue.id,
        issueNumber: issue.number,
        repository: repoFullName,
        triggeringLabel: triggeringLabel
    }, 'Enqueueing parent job for matrix dispatch');

    try {
        const timestamp = Date.now();
        const jobId = `issue-${issue.repoOwner}-${issue.repoName}-${issue.number}-${timestamp}`;
        const issueJob = {
            repoOwner: issue.repoOwner,
            repoName: issue.repoName,
            number: issue.number,
            triggeringLabel: triggeringLabel,
            correlationId: generateCorrelationId()
            // Note: No modelName or isChildJob - dispatcher will create child jobs
        };
            
        const addToQueueWithRetry = () => withRetry(
            () => issueQueue.add('processGitHubIssue', issueJob, {
                jobId,
                attempts: 3,
                backoff: {
                    type: 'exponential',
                    delay: 2000,
                },
            }),
            { ...retryConfigs.redis, correlationId },
            `add_issue_to_queue_${issue.number}`
        );

        await addToQueueWithRetry();

        try {
            const activity = {
                id: `activity-${timestamp}-${issue.id}`,
                type: 'issue_created',
                timestamp: new Date().toISOString(),
                repository: repoFullName,
                issueNumber: issue.number,
                description: `New issue #${issue.number} detected for matrix processing`,
                status: 'info'
            };
            await redisClient.lpush('system:activity:log', JSON.stringify(activity));
            await redisClient.ltrim('system:activity:log', 0, 999);
        } catch (activityError) {
            correlatedLogger.warn({ error: activityError.message }, 'Failed to log activity');
        }

        correlatedLogger.info({
            jobId,
            issueNumber: issue.number,
            repository: repoFullName,
            issueCorrelationId: issueJob.correlationId
        }, 'Successfully added parent job to processing queue');

    } catch (error) {
        handleError(error, `Failed to add issue ${issue.number} to queue`, {
            correlationId
        });
    }
}

/**
 * Fetches issues for a specific repository based on configured criteria
 * @param {import('@octokit/core').Octokit} octokit - Authenticated Octokit instance
 * @param {string} repoFullName - Repository in format "owner/repo"
 * @param {string} correlationId - Correlation ID for tracking
 * @returns {Promise<Array>} Array of filtered issues
 */
async function fetchIssuesForRepo(octokit, repoFullName, correlationId) {
    const correlatedLogger = logger.withCorrelation(correlationId);
    const [owner, repo] = repoFullName.split('/');
    
    if (!owner || !repo) {
        correlatedLogger.warn({ repo: repoFullName }, 'Invalid repository format. Skipping.');
        return [];
    }

    const allExcludeLabels = [];
    for (const label of primaryProcessingLabels) {
        allExcludeLabels.push(`${label}-processing`);
        allExcludeLabels.push(`${label}-done`);
    }

    // Use retry wrapper for GitHub API calls
    const fetchWithRetry = () => withRetry(
        async () => {
            const allIssues = [];
            
            for (const primaryLabel of primaryProcessingLabels) {
                const issues = await octokit.paginate('GET /repos/{owner}/{repo}/issues', {
                    owner,
                    repo,
                    state: 'open',
                    labels: primaryLabel,
                    per_page: 100,
                    sort: 'created',
                    direction: 'desc'
                });
                
                for (const issue of issues) {
                    if (!allIssues.find(i => i.id === issue.id)) {
                        allIssues.push(issue);
                    }
                }
            }
            
            const filteredIssues = allIssues.filter(issue => {
                if (issue.pull_request) {
                    return false;
                }

                const labelNames = issue.labels.map(label =>
                    typeof label === 'string' ? label : label.name
                );
                
                return !allExcludeLabels.some(excludeLabel => labelNames.includes(excludeLabel));
            });
            
            const pullRequestCount = allIssues.filter(issue => issue.pull_request).length;

            correlatedLogger.debug({
                repo: repoFullName,
                totalIssues: allIssues.length,
                pullRequests: pullRequestCount,
                filteredIssues: filteredIssues.length,
                excludedLabels: allExcludeLabels
            }, 'Filtered issues (excluding PRs and labels)');
            
            return { data: { items: filteredIssues } };
        },
        { ...retryConfigs.githubApi, correlationId },
        `fetch_issues_${repoFullName}`
    );

    try {
        const response = await fetchWithRetry();

        correlatedLogger.info({ 
            repo: repoFullName, 
            count: response.data.items.length 
        }, `Found ${response.data.items.length} matching issues.`);

        return response.data.items.map(issue => ({
            id: issue.id,
            number: issue.number,
            title: issue.title,
            url: issue.html_url,
            repoOwner: owner,
            repoName: repo,
            labels: issue.labels.map(l => l.name),
            createdAt: issue.created_at,
            updatedAt: issue.updated_at
        }));
    } catch (error) {
        handleError(error, `fetch_issues_${repoFullName}`, { correlationId });

        // Check for rate limit errors
        if (error.status === 403 && error.message && error.message.includes('rate limit')) {
            correlatedLogger.warn('GitHub API rate limit likely exceeded. Consider increasing polling interval.');
        }
        
        return [];
    }
}

/**
 * Handles comment deletion by aborting any active jobs
 * @param {Object} payload - Webhook payload from 'issue_comment' or 'pull_request_review_comment'
 * @param {string} eventType - Type of event: 'issue_comment' or 'pull_request_review_comment'
 * @param {string} correlationId - Correlation ID for tracking
 */
async function handleCommentDeleted(payload, eventType, correlationId) {
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

/**
 * Handles comment editing by restarting any active jobs
 * @param {Object} payload - Webhook payload from 'issue_comment' or 'pull_request_review_comment'
 * @param {string} eventType - Type of event: 'issue_comment' or 'pull_request_review_comment'
 * @param {string} correlationId - Correlation ID for tracking
 */
async function handleCommentEdited(payload, eventType, correlationId) {
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

/**
 * Processes a comment event by checking author, trigger keywords, and enqueueing a job
 * @param {Object} payload - Webhook payload from 'issue_comment' or 'pull_request_review_comment'
 * @param {string} eventType - Type of event: 'issue_comment' or 'pull_request_review_comment'
 * @param {string} correlationId - Correlation ID for tracking
 */
async function processCommentEvent(payload, eventType, correlationId) {
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

    // Use centralized comment filtering
    const filterResult = filterCommentByAuthor(commentAuthor, correlationId);
    if (filterResult.shouldFilter) {
        return;
    }

    // Check if comment triggers processing
    const triggerResult = checkCommentTrigger(comment.body, correlationId);
    if (!triggerResult.isTriggered) {
        return;
    }
    
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
    
    const activeJobs = await issueQueue.getActive();
    const waitingJobs = await issueQueue.getWaiting();
    const existingJobs = [...activeJobs, ...waitingJobs];
    
    const jobExists = existingJobs.some(job =>
        job.name === 'processPullRequestComment' &&
        job.data.pullRequestNumber === prNumber &&
        job.data.repoOwner === owner &&
        job.data.repoName === repo
    );
    
    if (jobExists) {
        correlatedLogger.info({
            pullRequestNumber: prNumber,
            repository: repoFullName
        }, 'A job for this PR is already active or waiting, skipping new job creation.');
        return;
    }
    
    let llm = null;
    if (PR_FOLLOWUP_TRIGGER_KEYWORDS.length > 0) {
        for (const keyword of PR_FOLLOWUP_TRIGGER_KEYWORDS) {
            const llmMatch = comment.body.match(new RegExp(`${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:([\\w.-]+)`));
            if (llmMatch) llm = resolveModelAlias(llmMatch[1]);
            if (llm) break;
        }
    }
    
    let enhancedCommentBody = comment.body;
    if (PR_FOLLOWUP_TRIGGER_KEYWORDS.length > 0) {
        for (const keyword of PR_FOLLOWUP_TRIGGER_KEYWORDS) {
            const escapedKeyword = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            enhancedCommentBody = enhancedCommentBody.replace(new RegExp(`${escapedKeyword}(:\\w+)?`, 'g'), '');
        }
    }
    enhancedCommentBody = enhancedCommentBody.trim();
    
    if (comment.pull_request_review_id || eventType === 'pull_request_review_comment') {
        const codeContext = [];
        if (comment.path) {
            codeContext.push(`File: ${comment.path}`);
        }
        if (comment.line) {
            codeContext.push(`Line: ${comment.line}`);
        }
        if (comment.diff_hunk) {
            codeContext.push('Code context:');
            codeContext.push('```diff');
            codeContext.push(comment.diff_hunk);
            codeContext.push('```');
        }
        
        if (codeContext.length > 0) {
            enhancedCommentBody = `${comment.body}\n\n--- Review Comment Context ---\n${codeContext.join('\n')}`;
        }
    }
    
    const unprocessedComment = {
        id: comment.id,
        body: enhancedCommentBody,
        author: commentAuthor,
        type: (comment.pull_request_review_id || eventType === 'pull_request_review_comment') ? 'review' : 'issue',
        hasCodeContext: (comment.pull_request_review_id || eventType === 'pull_request_review_comment') && comment.diff_hunk ? true : false
    };
    
    let branchName;
    let prLabels = [];
    if (eventType === 'issue_comment') {
        const octokit = await getAuthenticatedOctokit();
        const { data: pr } = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
            owner,
            repo,
            pull_number: prNumber
        });
        branchName = pr.head.ref;
        prLabels = pr.labels || [];
    } else {
        branchName = payload.pull_request.head.ref;
        prLabels = payload.pull_request.labels || [];
    }

    // Extract model from PR labels if not specified in comment body
    if (!llm && prLabels.length > 0) {
        const modelLabelRegex = new RegExp(MODEL_LABEL_PATTERN);
        for (const label of prLabels) {
            const labelName = typeof label === 'string' ? label : label.name;
            const match = labelName.match(modelLabelRegex);
            if (match) {
                llm = resolveModelAlias(match[1]);
                correlatedLogger.debug({
                    repository: repoFullName,
                    pullRequestNumber: prNumber,
                    label: labelName,
                    resolvedModel: llm
                }, 'Extracted model from PR label (webhook)');
                break;
            }
        }
    }

    const jobData = {
        pullRequestNumber: prNumber,
        comments: [unprocessedComment],
        repoOwner: owner,
        repoName: repo,
        branchName: branchName,
        llm: llm,
        correlationId: generateCorrelationId(),
    };
    
    const timestamp = Date.now();
    const jobId = `pr-comments-batch-${owner}-${repo}-${prNumber}-${timestamp}`;
    
    try {
        await issueQueue.add('processPullRequestComment', jobData, { 
            jobId,
            delay: COMMENT_BATCH_DELAY_MS
        });
        
        await redisClient.setex(commentTrackingKey, 86400, Date.now().toString());
        
        correlatedLogger.info({
            jobId,
            pullRequestNumber: prNumber,
            commentId: comment.id,
            commentType: unprocessedComment.type,
            delayMs: COMMENT_BATCH_DELAY_MS
        }, `Successfully added PR comment job to processing queue with ${COMMENT_BATCH_DELAY_MS}ms delay for batching`);
    } catch (error) {
        if (error.message?.includes('Job already exists')) {
            correlatedLogger.debug({
                pullRequestNumber: prNumber,
            }, 'PR comment job already in queue, skipping');
        } else {
            handleError(error, `Failed to add PR comment to queue`, { correlationId });
        }
    }
}

/**
 * Fetches and processes comments on open pull requests for a repository
 * @param {import('@octokit/core').Octokit} octokit - Authenticated Octokit instance
 * @param {string} repoFullName - Repository in format "owner/repo"
 * @param {string} correlationId - Correlation ID for tracking
 */
async function pollForPullRequestComments(octokit, repoFullName, correlationId) {
    const correlatedLogger = logger.withCorrelation(correlationId);
    const [owner, repo] = repoFullName.split('/');

    correlatedLogger.debug({
        repository: repoFullName
    }, 'Checking for PR comments in repository');

    try {
        // Fetch ALL open pull requests using pagination
        const prs = await octokit.paginate('GET /repos/{owner}/{repo}/pulls', {
            owner,
            repo,
            state: 'open',
            per_page: 100
        });

        correlatedLogger.debug({
            repository: repoFullName,
            openPRCount: prs.length
        }, `Found ${prs.length} open pull requests`);

        if (prs.length === 0) {
            correlatedLogger.debug({
                repository: repoFullName
            }, 'No open pull requests found, skipping PR comment check');
            return;
        }

        for (const pr of prs) {
            correlatedLogger.debug({
                repository: repoFullName,
                pullRequestNumber: pr.number,
                pullRequestTitle: pr.title
            }, 'Checking PR for comments');

            // Fetch all issue comments and PR review comments with pagination
            // Using Octokit's paginate method to get ALL comments, not just the first page
            const [issueComments, reviewComments] = await Promise.all([
                octokit.paginate('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', {
                    owner,
                    repo,
                    issue_number: pr.number,
                    per_page: 100
                }),
                octokit.paginate('GET /repos/{owner}/{repo}/pulls/{pull_number}/comments', {
                    owner,
                    repo,
                    pull_number: pr.number,
                    per_page: 100
                })
            ]);

            // Combine both types of comments
            // Note: issueComments and reviewComments are now arrays directly (not .data)
            const allComments = [
                ...issueComments,
                ...reviewComments
            ];

            // Check if any bot comments exist after this comment that indicate processing
            const botUsername = GITHUB_BOT_USERNAME || 'gitfixio[bot]';
            const commentsByTime = allComments.sort((a, b) => 
                new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
            );

            const triggerComments = commentsByTime.filter(c => {
                if (!c.body) return false;

                if (PR_FOLLOWUP_TRIGGER_KEYWORDS.length > 0) {
                    return PR_FOLLOWUP_TRIGGER_KEYWORDS.some(keyword => c.body.includes(keyword));
                }

                return true;
            });
            
            correlatedLogger.debug({
                repository: repoFullName,
                pullRequestNumber: pr.number,
                issueComments: issueComments.length,
                reviewComments: reviewComments.length,
                totalComments: allComments.length,
                triggerComments: triggerComments.length
            }, `Found ${allComments.length} comments (${issueComments.length} issue + ${reviewComments.length} review), ${triggerComments.length} potential trigger comments`);

            // Log comment details for debugging
            if (allComments.length > 0 && triggerComments.length === 0) {
                correlatedLogger.debug({
                    repository: repoFullName,
                    pullRequestNumber: pr.number,
                    commentBodies: commentsByTime.map(c => ({
                        id: c.id,
                        author: c.user.login,
                        type: c.pull_request_review_id ? 'review' : 'issue',
                        bodyPreview: c.body ? c.body.substring(0, 100) + (c.body.length > 100 ? '...' : '') : 'null'
                    }))
                }, 'Comment details (no trigger keywords found)');
            }

            // Collect all unprocessed trigger comments for batch processing
            const unprocessedComments = [];
            let selectedLlm = null;

            // Extract model from PR labels (llm-* labels like llm-claude-opus)
            if (pr.labels && Array.isArray(pr.labels)) {
                const modelLabelRegex = new RegExp(MODEL_LABEL_PATTERN);
                for (const label of pr.labels) {
                    const labelName = typeof label === 'string' ? label : label.name;
                    const match = labelName.match(modelLabelRegex);
                    if (match) {
                        selectedLlm = resolveModelAlias(match[1]);
                        correlatedLogger.debug({
                            repository: repoFullName,
                            pullRequestNumber: pr.number,
                            label: labelName,
                            resolvedModel: selectedLlm
                        }, 'Extracted model from PR label');
                        break;
                    }
                }
            }

            for (const comment of commentsByTime) {
                const commentAuthor = comment.user.login;
                // Use centralized comment filtering
                const filterResult = filterCommentByAuthor(commentAuthor, correlationId);
                if (filterResult.shouldFilter) {
                    continue;
                }

                // Check if comment triggers processing
                const triggerResult = checkCommentTrigger(comment.body, correlationId);
                if (!triggerResult.isTriggered) {
                    continue;
                }

                // Passed filters, process this comment
                {

                    // 4. Check if this comment has already been queued or processed
                    const commentTrackingKey = `pr-comment-processed:${owner}:${repo}:${pr.number}:${comment.id}`;
                    const alreadyQueued = await redisClient.get(commentTrackingKey);

                    if (alreadyQueued) {
                        correlatedLogger.debug({
                            repository: `${owner}/${repo}`,
                            pullRequestNumber: pr.number,
                            commentId: comment.id,
                            commentAuthor,
                            commentType: comment.pull_request_review_id ? 'review' : 'issue'
                        }, 'PR comment already queued/processed, skipping');
                        continue;
                    }

                    // Also check if bot has already responded to this comment
                    const commentIndex = commentsByTime.indexOf(comment);
                    const subsequentComments = commentsByTime.slice(commentIndex + 1);
                    const alreadyProcessed = subsequentComments.some(laterComment => {
                        const isBotComment = laterComment.user.login === botUsername;

                        if (!isBotComment) return false;

                        // Check if bot comment references this specific comment
                        // Look for comment ID with checkmark marker (e.g., "3324906845✓")
                        return laterComment.body.includes(`${String(comment.id)}✓`);
                    });

                    if (alreadyProcessed) {
                        correlatedLogger.debug({
                            repository: `${owner}/${repo}`,
                            pullRequestNumber: pr.number,
                            commentId: comment.id,
                            commentAuthor,
                            commentType: comment.pull_request_review_id ? 'review' : 'issue'
                        }, 'PR comment already processed by bot, skipping');
                        continue;
                    }

                    let llm = null;
                    if (PR_FOLLOWUP_TRIGGER_KEYWORDS.length > 0) {
                        for (const keyword of PR_FOLLOWUP_TRIGGER_KEYWORDS) {
                            const llmMatch = comment.body.match(new RegExp(`${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:([\\w.-]+)`));
                            if (llmMatch) llm = resolveModelAlias(llmMatch[1]);
                            if (llm) break;
                        }
                    }

                    // Comment body model overrides PR label model (more specific)
                    if (llm) {
                        selectedLlm = llm;
                    }

                    // For review comments, include the code context
                    // Strip the trigger keywords from the body before processing
                    let enhancedCommentBody = comment.body;
                    if (PR_FOLLOWUP_TRIGGER_KEYWORDS.length > 0) {
                        for (const keyword of PR_FOLLOWUP_TRIGGER_KEYWORDS) {
                            const escapedKeyword = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                            enhancedCommentBody = enhancedCommentBody.replace(new RegExp(`${escapedKeyword}(:\\w+)?`, 'g'), '');
                        }
                    }
                    enhancedCommentBody = enhancedCommentBody.trim();

                    if (comment.pull_request_review_id) {
                        // This is a PR review comment
                        const codeContext = [];
                        if (comment.path) {
                            codeContext.push(`File: ${comment.path}`);
                        }
                        if (comment.line) {
                            codeContext.push(`Line: ${comment.line}`);
                        }
                        if (comment.diff_hunk) {
                            codeContext.push('Code context:');
                            codeContext.push('```diff');
                            codeContext.push(comment.diff_hunk);
                            codeContext.push('```');
                        }
                        
                        if (codeContext.length > 0) {
                            enhancedCommentBody = `${comment.body}\n\n--- Review Comment Context ---\n${codeContext.join('\n')}`;
                        }
                    }

                    unprocessedComments.push({
                        id: comment.id,
                        body: enhancedCommentBody,
                        author: commentAuthor,
                        type: comment.pull_request_review_id ? 'review' : 'issue',
                        hasCodeContext: comment.pull_request_review_id && comment.diff_hunk ? true : false
                    });
                }
            }

            // If we have unprocessed comments, create a single batch job
            if (unprocessedComments.length > 0) {
                // Check if a job for this PR is already active or waiting
                const activeJobs = await issueQueue.getActive();
                const waitingJobs = await issueQueue.getWaiting();
                const existingJobs = [...activeJobs, ...waitingJobs];

                const jobExists = existingJobs.some(job =>
                    job.name === 'processPullRequestComment' &&
                    job.data.pullRequestNumber === pr.number &&
                    job.data.repoOwner === owner &&
                    job.data.repoName === repo
                );

                if (jobExists) {
                    correlatedLogger.info({
                        pullRequestNumber: pr.number,
                        repository: repoFullName
                    }, 'A job for this PR is already active or waiting, skipping new job creation.');
                    continue;
                }
                const jobData = {
                    pullRequestNumber: pr.number,
                    comments: unprocessedComments,  // Array of all comments to process
                    repoOwner: owner,
                    repoName: repo,
                    branchName: pr.head.ref,
                    llm: selectedLlm,
                    correlationId: generateCorrelationId(),
                };

                // Create a unique job ID based on PR and timestamp to allow reprocessing
                const timestamp = Date.now();
                const jobId = `pr-comments-batch-${owner}-${repo}-${pr.number}-${timestamp}`;

                try {
                    await issueQueue.add('processPullRequestComment', jobData, { 
                        jobId,
                        delay: COMMENT_BATCH_DELAY_MS
                    });

                    // Mark all comments as queued in Redis with 24 hour expiration
                    const pipeline = redisClient.pipeline();
                    for (const comment of unprocessedComments) {
                        const trackingKey = `pr-comment-processed:${owner}:${repo}:${pr.number}:${comment.id}`;
                        pipeline.setex(trackingKey, 86400, Date.now().toString()); // 24 hours
                    }
                    await pipeline.exec();

                    correlatedLogger.info({
                        jobId,
                        pullRequestNumber: pr.number,
                        commentsCount: unprocessedComments.length,
                        commentIds: unprocessedComments.map(c => c.id),
                        commentTypes: unprocessedComments.map(c => c.type),
                        delayMs: COMMENT_BATCH_DELAY_MS
                    }, `Successfully added batch PR comments job to processing queue (${unprocessedComments.length} comments) with ${COMMENT_BATCH_DELAY_MS}ms delay for batching`);
                } catch (error) {
                    if (error.message?.includes('Job already exists')) {
                        correlatedLogger.debug({
                            pullRequestNumber: pr.number,
                            commentsCount: unprocessedComments.length,
                        }, 'PR comments batch job already in queue, skipping');
                    } else {
                        handleError(error, `Failed to add PR comments batch to queue`, { correlationId });
                    }
                }
            }
        }
    } catch (error) {
        handleError(error, `Error polling PR comments for repository ${repoFullName}`, { correlationId });
    }
}

/**
 * Main polling function that checks all configured repositories for issues
 */
async function pollForIssues() {
    const correlationId = generateCorrelationId();
    const correlatedLogger = logger.withCorrelation(correlationId);
    
    correlatedLogger.info('Starting GitHub issue polling cycle...');
    
    let octokit;
    try {
        octokit = await withRetry(
            () => getAuthenticatedOctokit(),
            { ...retryConfigs.githubApi, correlationId },
            'get_authenticated_octokit'
        );
    } catch (authError) {
        handleError(authError, 'Failed to get authenticated Octokit instance', { correlationId });
        return;
    }

    const allDetectedIssues = [];
    const repos = getRepos();
    
    // Poll each configured repository
    for (const repoFullName of repos) {
        correlatedLogger.debug({ repository: repoFullName }, 'Polling repository');
        
        try {
            const issues = await fetchIssuesForRepo(octokit, repoFullName, correlationId);
            
            if (issues.length > 0) {
                for (const issue of issues) {
                    await processDetectedIssue(issue, correlationId);
                    allDetectedIssues.push(issue);
                }
            }
            
            // Poll for PR comments after processing issues
            await pollForPullRequestComments(octokit, repoFullName, correlationId);
            
        } catch (error) {
            handleError(error, `Error polling repository ${repoFullName}`, { correlationId });
        }
    }
    
    correlatedLogger.info({ 
        totalIssues: allDetectedIssues.length,
        repositories: repos.length 
    }, 'Polling cycle completed');
    
    return allDetectedIssues;
}

/**
 * Clears all queue data from Redis
 */
async function resetQueues() {
    logger.info('Resetting all queue data...');
    
    try {
        // Create Redis connection with same config as queue
        const redis = new Redis({
            host: process.env.REDIS_HOST || '127.0.0.1',
            port: parseInt(process.env.REDIS_PORT || '6379', 10),
            maxRetriesPerRequest: null,
            enableReadyCheck: false,
        });

        // Get all keys related to our queue
        const queueName = process.env.GITHUB_ISSUE_QUEUE_NAME || 'github-issue-processor';
        const keys = await redis.keys(`bull:${queueName}:*`);
        
        if (keys.length > 0) {
            logger.info({
                queueName,
                keysCount: keys.length
            }, 'Found queue keys to delete');
            
            // Delete all queue-related keys
            await redis.del(...keys);
            
            logger.info({
                queueName,
                deletedKeys: keys.length
            }, 'Successfully cleared all queue data');
        } else {
            logger.info({ queueName }, 'No queue data found to clear');
        }
        
        // Clean up Redis connection
        await redis.quit();
        
    } catch (error) {
        handleError(error, 'Failed to reset queues');
        throw error;
    }
}

/**
 * Removes processing tags from GitHub issues to allow reprocessing
 */
async function resetIssueLabels() {
    logger.info('Resetting issue labels...');
    
    const repos = getRepos();
    if (repos.length === 0) {
        logger.warn('No repositories configured for label reset');
        return;
    }

    try {
        const octokit = await getAuthenticatedOctokit();
        let totalReset = 0;

        for (const repoFullName of repos) {
            const [owner, repo] = repoFullName.split('/');
            if (!owner || !repo) continue;

            logger.info({ repository: repoFullName }, 'Checking for issues with processing labels...');

            try {
                for (const primaryLabel of primaryProcessingLabels) {
                    const processingLabel = `${primaryLabel}-processing`;
                    
                    const issues = await octokit.paginate('GET /repos/{owner}/{repo}/issues', {
                        owner,
                        repo,
                        state: 'open',
                        labels: processingLabel,
                        per_page: 100
                    });

                    for (const issue of issues) {
                        const currentLabels = issue.labels.map(label => label.name);
                        
                        if (currentLabels.includes(processingLabel)) {
                            logger.info({
                                repository: repoFullName,
                                issueNumber: issue.number,
                                labelToRemove: processingLabel
                            }, 'Removing processing label from issue (preserving done labels)');

                            await octokit.request('DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}', {
                                owner,
                                repo,
                                issue_number: issue.number,
                                name: processingLabel
                            });
                            totalReset++;
                        }
                    }
                }

                logger.info({
                    repository: repoFullName
                }, 'Processed repository for label reset');

            } catch (repoError) {
                logger.error({
                    repository: repoFullName,
                    error: repoError.message
                }, 'Failed to reset labels for repository');
            }
        }

        logger.info({
            totalIssuesReset: totalReset,
            repositoriesProcessed: repos.length
        }, 'Completed issue label reset');

    } catch (error) {
        handleError(error, 'Failed to reset issue labels');
        throw error;
    }
}


/**
 * Starts the daemon with configured polling interval
 */
async function startDaemon(options = {}) {
    await loadReposFromConfig();
    await loadSettingsFromConfig();
    await loadAiPrimaryTagFromConfig();
    await loadPrimaryProcessingLabelsFromConfig();
    await detectBotUsername();

    const repos = getRepos();
    
    // Validate required configuration
    if (repos.length === 0) {
        logger.error('No repositories configured. Set GITHUB_REPOS_TO_MONITOR or CONFIG_REPO. Exiting.');
        process.exit(1);
    }
    
    // Run database migrations if enabled
    if (isDbEnabled && db) {
        try {
            logger.info('Running database migrations...');
            await db.migrate.latest();
            logger.info('Database migrations completed successfully');
        } catch (error) {
            logger.error({
                error: error.message,
                stack: error.stack
            }, 'Database migration failed - daemon will continue but database persistence may not work');
        }
    }
    
    // Handle reset flag
    if (options.reset) {
        logger.info('Reset flag detected, clearing all queue data and issue labels...');
        
        try {
            await resetQueues();
            await resetIssueLabels();
            logger.info('Reset completed successfully');
        } catch (error) {
            logger.error({ error: error.message }, 'Reset failed');
            process.exit(1);
        }
    }
    
    // Initialize Redis connection for heartbeat
    const heartbeatRedis = new Redis({
        host: process.env.REDIS_HOST || 'localhost',
        port: process.env.REDIS_PORT || 6379,
        retryStrategy: times => Math.min(times * 50, 2000)
    });
    
    // Function to send heartbeat
    const sendHeartbeat = async () => {
        try {
            await heartbeatRedis.set('system:status:daemon', Date.now(), 'EX', 90);
            logger.debug('Daemon heartbeat sent');
        } catch (error) {
            logger.error({ error: error.message }, 'Failed to send daemon heartbeat');
        }
    };
    
    // Send initial heartbeat
    await sendHeartbeat();
    
    // Set up heartbeat interval (every 30 seconds)
    const heartbeatInterval = setInterval(sendHeartbeat, 30000);
    
    let intervalId = null;
    
    if (ENABLE_WEBHOOKS) {
        logger.info({
            repositories: repos,
            webhookEnabled: true,
            webhookSecretConfigured: !!process.env.GH_WEBHOOK_SECRET,
            primaryProcessingLabels: primaryProcessingLabels,
            modelLabelPattern: MODEL_LABEL_PATTERN,
            defaultModelName: DEFAULT_MODEL_NAME,
            botUsername: GITHUB_BOT_USERNAME || 'not configured',
            userWhitelist: GITHUB_USER_WHITELIST.length > 0 ? GITHUB_USER_WHITELIST : '',
            userBlacklist: GITHUB_USER_BLACKLIST.length > 0 ? GITHUB_USER_BLACKLIST : 'no users blocked',
            prFollowupTriggerKeywords: PR_FOLLOWUP_TRIGGER_KEYWORDS.length > 0 ? PR_FOLLOWUP_TRIGGER_KEYWORDS : 'any comment triggers',
            resetPerformed: !!options.reset
        }, 'GitHub Issue Detection Daemon starting in webhook mode...');
        
        if (!process.env.GH_WEBHOOK_SECRET) {
            logger.warn('GH_WEBHOOK_SECRET is not set! Webhook signature verification will be skipped.');
        }
        
        await initializeWebhookHandler(processDetectedIssue, processCommentEvent, handleCommentDeleted, handleCommentEdited);
        logger.info('Webhook handler initialized. Webhooks will be received by dashboard API service.');
    } else {
        logger.info({
            repositories: repos,
            pollingInterval: POLLING_INTERVAL_MS,
            primaryProcessingLabels: primaryProcessingLabels,
            modelLabelPattern: MODEL_LABEL_PATTERN,
            defaultModelName: DEFAULT_MODEL_NAME,
            botUsername: GITHUB_BOT_USERNAME || 'not configured',
            userWhitelist: GITHUB_USER_WHITELIST.length > 0 ? GITHUB_USER_WHITELIST : '',
            userBlacklist: GITHUB_USER_BLACKLIST.length > 0 ? GITHUB_USER_BLACKLIST : 'no users blocked',
            prFollowupTriggerKeywords: PR_FOLLOWUP_TRIGGER_KEYWORDS.length > 0 ? PR_FOLLOWUP_TRIGGER_KEYWORDS : 'any comment triggers',
            resetPerformed: !!options.reset
        }, 'GitHub Issue Detection Daemon starting in polling mode...');

        const safePoll = withErrorHandling(pollForIssues, 'daemon polling');
        safePoll();

        intervalId = setInterval(safePoll, POLLING_INTERVAL_MS);
    }

    // Set up config reloading (every 5 minutes)
    const configReloadInterval = setInterval(async () => {
        try {
            if (process.env.CONFIG_REPO) {
                await loadReposFromConfig();
                await loadSettingsFromConfig();
                await loadAiPrimaryTagFromConfig();
                await loadPrimaryProcessingLabelsFromConfig();
            }
        } catch (error) {
            logger.error({ error: error.message }, 'Failed to reload config');
        }
    }, 5 * 60 * 1000);

    // Handle graceful shutdown
    process.on('SIGINT', async () => {
        logger.info('Received SIGINT, shutting down gracefully...');
        if (intervalId) clearInterval(intervalId);
        clearInterval(configReloadInterval);
        clearInterval(heartbeatInterval);
        await heartbeatRedis.quit();
        await redisClient.quit();
        await shutdownQueue();
        process.exit(0);
    });

    process.on('SIGTERM', async () => {
        logger.info('Received SIGTERM, shutting down gracefully...');
        if (intervalId) clearInterval(intervalId);
        clearInterval(configReloadInterval);
        clearInterval(heartbeatInterval);
        await heartbeatRedis.quit();
        await redisClient.quit();
        await shutdownQueue();
        process.exit(0);
    });
}

// Export functions for testing
export {
    fetchIssuesForRepo,
    pollForIssues,
    pollForPullRequestComments,
    startDaemon,
    resetQueues,
    resetIssueLabels,
    processDetectedIssue,
    processCommentEvent,
    handleCommentDeleted,
    handleCommentEdited,
    loadSettingsFromConfig
};

/**
 * Parse command line arguments
 */
function parseArgs() {
    const args = process.argv.slice(2);
    const options = {};
    
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        
        if (arg === '--reset' || arg === '-r') {
            options.reset = true;
        } else if (arg === '--help' || arg === '-h') {
            console.log(`
GitHub Issue Detection Daemon

Usage: node src/daemon.js [options]

Options:
  --reset, -r    Clear all queue data and remove processing labels from issues
  --help, -h     Show this help message

Environment Variables:
  GITHUB_REPOS_TO_MONITOR    Comma-separated list of repositories to monitor
  POLLING_INTERVAL_MS        Polling interval in milliseconds (default: 60000)
  AI_PRIMARY_TAG             Primary tag to look for (default: AI)
  AI_EXCLUDE_TAGS_PROCESSING Processing tag to exclude (default: AI-processing)
  AI_DONE_TAG                Done tag to exclude (default: AI-done)
  MODEL_LABEL_PATTERN        Regex pattern for model labels (default: ^llm-claude-(.+)$)
  DEFAULT_CLAUDE_MODEL       Default model when no model labels found (default: claude-3-5-sonnet-20240620)
  GITHUB_BOT_USERNAME        Bot username to exclude from PR comment monitoring
  GITHUB_USER_WHITELIST      Comma-separated list of allowed users for PR comments
  GITHUB_USER_BLACKLIST      Comma-separated list of excluded users for PR comments
  PR_FOLLOWUP_TRIGGER_KEYWORDS  Comma-separated list of trigger keywords (default: !gitfix, empty = all comments)

Examples:
  node src/daemon.js                Start the daemon normally
  node src/daemon.js --reset        Reset all queues and issue labels, then start
  npm run daemon:dev -- --reset     Reset using npm script
            `);
            process.exit(0);
        } else {
            console.error(`Unknown argument: ${arg}`);
            console.error('Use --help for usage information');
            process.exit(1);
        }
    }
    
    return options;
}

// Start daemon if this is the main module
if (import.meta.url === `file://${process.argv[1]}`) {
    const options = parseArgs();
    startDaemon(options).catch(error => {
        logger.error({ error: error.message }, 'Daemon startup failed');
        process.exit(1);
    });
}