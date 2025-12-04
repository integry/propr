import 'dotenv/config';
import { getAuthenticatedOctokit } from './auth/githubAuth.js';
import logger, { generateCorrelationId } from './utils/logger.js';
import { withErrorHandling, handleError } from './utils/errorHandler.js';
import { withRetry, retryConfigs } from './utils/retryHandler.js';
import { issueQueue, shutdownQueue } from './queue/taskQueue.js';
import Redis from 'ioredis';
import { getDefaultModel } from './config/modelAliases.js';
import { loadMonitoredRepos, loadSettings, loadAiPrimaryTag, loadPrimaryProcessingLabels } from './config/configRepoManager.js';
import { db, isEnabled as isDbEnabled } from './db/postgres.js';
import { initializeWebhookHandler } from './webhook/webhookHandler.js';
import { pollForPullRequestComments } from './polling/prCommentPolling.js';
import { handleCommentDeleted, handleCommentEdited, processCommentEvent } from './webhook/commentEventHandler.js';

const redisClient = new Redis({
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
});

const GITHUB_REPOS_TO_MONITOR = process.env.GITHUB_REPOS_TO_MONITOR;
const POLLING_INTERVAL_MS = parseInt(process.env.POLLING_INTERVAL_MS || '60000', 10);
let AI_PRIMARY_TAG = process.env.AI_PRIMARY_TAG || 'AI';
let primaryProcessingLabels = [];
const MODEL_LABEL_PATTERN = process.env.MODEL_LABEL_PATTERN || '^llm-claude-(.+)$';
const DEFAULT_MODEL_NAME = process.env.DEFAULT_CLAUDE_MODEL || getDefaultModel();

let GITHUB_BOT_USERNAME = process.env.GITHUB_BOT_USERNAME;
const GITHUB_USER_BLACKLIST = (process.env.GITHUB_USER_BLACKLIST || '').split(',').filter(u => u);
const PR_FOLLOWUP_TRIGGER_KEYWORDS = (process.env.PR_FOLLOWUP_TRIGGER_KEYWORDS !== undefined ? process.env.PR_FOLLOWUP_TRIGGER_KEYWORDS : '').split(',').filter(k => k.trim()).map(k => k.trim());

const ENABLE_WEBHOOKS = process.env.ENABLE_GITHUB_WEBHOOKS === 'true';

let monitoredRepos = [];
let GITHUB_USER_WHITELIST = (process.env.GITHUB_USER_WHITELIST || '').split(',').filter(u => u);

function getCommentConfig() {
    return {
        redisClient,
        GITHUB_BOT_USERNAME,
        PR_FOLLOWUP_TRIGGER_KEYWORDS,
        MODEL_LABEL_PATTERN,
        processCommentEvent: (payload, eventType, correlationId) => 
            processCommentEvent(payload, eventType, correlationId, getCommentConfig())
    };
}

async function detectBotUsername() {
    if (GITHUB_BOT_USERNAME) return GITHUB_BOT_USERNAME;

    try {
        const octokit = await getAuthenticatedOctokit();
        const { data: installation } = await octokit.request('GET /installation');
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
    if (!GITHUB_REPOS_TO_MONITOR) return [];
    return GITHUB_REPOS_TO_MONITOR.split(',').map(r => r.trim()).filter(r => r);
};

const getRepos = () => monitoredRepos;

async function processDetectedIssue(issue, correlationId) {
    const correlatedLogger = logger.withCorrelation(correlationId);
    const repoFullName = `${issue.repoOwner}/${issue.repoName}`;

    if (primaryProcessingLabels.length === 0) {
        await loadPrimaryProcessingLabelsFromConfig();
    }

    const allExcludeLabels = [];
    for (const label of primaryProcessingLabels) {
        allExcludeLabels.push(`${label}-processing`);
        allExcludeLabels.push(`${label}-done`);
    }

    if (allExcludeLabels.some(excludeLabel => issue.labels.includes(excludeLabel))) {
        correlatedLogger.debug({ issueNumber: issue.number, repository: repoFullName }, 'Issue has exclude labels, skipping');
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

    const activeJobs = await issueQueue.getActive();
    const waitingJobs = await issueQueue.getWaiting();
    const existingJobs = [...activeJobs, ...waitingJobs];

    const jobExists = existingJobs.some(job =>
        job.name === 'processGitHubIssue' &&
        job.data.number === issue.number &&
        job.data.repoOwner === issue.repoOwner &&
        job.data.repoName === issue.repoName &&
        !job.data.isChildJob
    );

    if (jobExists) {
        correlatedLogger.debug({ issueNumber: issue.number, repository: repoFullName }, 'A parent job for this issue is already active or waiting, skipping duplicate');
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
        };
            
        const addToQueueWithRetry = () => withRetry(
            () => issueQueue.add('processGitHubIssue', issueJob, {
                jobId,
                attempts: 3,
                backoff: { type: 'exponential', delay: 2000 },
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
        handleError(error, `Failed to add issue ${issue.number} to queue`, { correlationId });
    }
}

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
                if (issue.pull_request) return false;

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

        if (error.status === 403 && error.message && error.message.includes('rate limit')) {
            correlatedLogger.warn('GitHub API rate limit likely exceeded. Consider increasing polling interval.');
        }
        
        return [];
    }
}

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
            
            await pollForPullRequestComments(octokit, repoFullName, correlationId, getCommentConfig());
            
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

async function resetQueues() {
    logger.info('Resetting all queue data...');
    
    try {
        const redis = new Redis({
            host: process.env.REDIS_HOST || '127.0.0.1',
            port: parseInt(process.env.REDIS_PORT || '6379', 10),
            maxRetriesPerRequest: null,
            enableReadyCheck: false,
        });

        const queueName = process.env.GITHUB_ISSUE_QUEUE_NAME || 'github-issue-processor';
        const keys = await redis.keys(`bull:${queueName}:*`);
        
        if (keys.length > 0) {
            logger.info({ queueName, keysCount: keys.length }, 'Found queue keys to delete');
            await redis.del(...keys);
            logger.info({ queueName, deletedKeys: keys.length }, 'Successfully cleared all queue data');
        } else {
            logger.info({ queueName }, 'No queue data found to clear');
        }
        
        await redis.quit();
        
    } catch (error) {
        handleError(error, 'Failed to reset queues');
        throw error;
    }
}

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

                logger.info({ repository: repoFullName }, 'Processed repository for label reset');

            } catch (repoError) {
                logger.error({ repository: repoFullName, error: repoError.message }, 'Failed to reset labels for repository');
            }
        }

        logger.info({ totalIssuesReset: totalReset, repositoriesProcessed: repos.length }, 'Completed issue label reset');

    } catch (error) {
        handleError(error, 'Failed to reset issue labels');
        throw error;
    }
}

async function startDaemon(options = {}) {
    await loadReposFromConfig();
    await loadSettingsFromConfig();
    await loadAiPrimaryTagFromConfig();
    await loadPrimaryProcessingLabelsFromConfig();
    await detectBotUsername();

    const repos = getRepos();
    
    if (repos.length === 0) {
        logger.error('No repositories configured. Set GITHUB_REPOS_TO_MONITOR or CONFIG_REPO. Exiting.');
        process.exit(1);
    }
    
    if (isDbEnabled && db) {
        try {
            logger.info('Running database migrations...');
            await db.migrate.latest();
            logger.info('Database migrations completed successfully');
        } catch (error) {
            logger.error({ error: error.message, stack: error.stack }, 'Database migration failed - daemon will continue but database persistence may not work');
        }
    }
    
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
    
    const heartbeatRedis = new Redis({
        host: process.env.REDIS_HOST || 'localhost',
        port: process.env.REDIS_PORT || 6379,
        retryStrategy: times => Math.min(times * 50, 2000)
    });
    
    const sendHeartbeat = async () => {
        try {
            await heartbeatRedis.set('system:status:daemon', Date.now(), 'EX', 90);
            logger.debug('Daemon heartbeat sent');
        } catch (error) {
            logger.error({ error: error.message }, 'Failed to send daemon heartbeat');
        }
    };
    
    await sendHeartbeat();
    const heartbeatInterval = setInterval(sendHeartbeat, 30000);
    
    let intervalId = null;
    
    const commentConfig = getCommentConfig();
    
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
        
        await initializeWebhookHandler(
            processDetectedIssue, 
            (payload, eventType, correlationId) => processCommentEvent(payload, eventType, correlationId, commentConfig),
            (payload, eventType, correlationId) => handleCommentDeleted(payload, eventType, correlationId, commentConfig),
            (payload, eventType, correlationId) => handleCommentEdited(payload, eventType, correlationId, commentConfig)
        );
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

export {
    fetchIssuesForRepo,
    pollForIssues,
    startDaemon,
    resetQueues,
    resetIssueLabels,
    processDetectedIssue,
    loadSettingsFromConfig
};

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
  MODEL_LABEL_PATTERN        Regex pattern for model labels (default: ^llm-claude-(.+)$)
  DEFAULT_CLAUDE_MODEL       Default model when no model labels found
  GITHUB_BOT_USERNAME        Bot username to exclude from PR comment monitoring
  GITHUB_USER_WHITELIST      Comma-separated list of allowed users for PR comments
  GITHUB_USER_BLACKLIST      Comma-separated list of excluded users for PR comments
  PR_FOLLOWUP_TRIGGER_KEYWORDS  Comma-separated list of trigger keywords

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

if (import.meta.url === `file://${process.argv[1]}`) {
    const options = parseArgs();
    startDaemon(options).catch(error => {
        logger.error({ error: error.message }, 'Daemon startup failed');
        process.exit(1);
    });
}
