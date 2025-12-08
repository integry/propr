import 'dotenv/config';
import { Redis } from 'ioredis';
import type { Logger } from 'pino';
import {
    getAuthenticatedOctokit,
    generateCorrelationId,
    withErrorHandling,
    handleError,
    withRetry,
    retryConfigs,
    shutdownQueue,
    getDefaultModel,
    db,
    isEnabled as isDbEnabled,
    initializeWebhookHandler,
    handleCommentDeleted,
    handleCommentEdited,
    processCommentEvent
} from '@gitfix/core';
import type { CommentPayload, CommentEventConfig, CommentEventType } from '@gitfix/core';
import { logger } from '@gitfix/core';
import { pollForPullRequestComments } from './polling/prCommentPolling.js';
import {
    loadAllConfigs,
    reloadConfigs,
    getRepos,
    getBotUsername,
    getUserWhitelist,
    getPrimaryProcessingLabels,
    loadSettingsFromConfig
} from './daemon/configLoader.js';
import { resetQueues, resetIssueLabels } from './daemon/queueReset.js';
import { processDetectedIssue, fetchIssuesForRepo } from './daemon/issueDetection.js';
import type { DetectedIssue } from './daemon/issueDetection.js';

process.on('uncaughtException', (error: Error) => {
    logger.fatal({ error: error.message, stack: error.stack }, 'Uncaught exception in daemon');
    process.exit(1);
});

process.on('unhandledRejection', (reason: unknown) => {
    logger.fatal({ reason }, 'Unhandled rejection in daemon');
    process.exit(1);
});

const redisClient = new Redis({
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
});

const POLLING_INTERVAL_MS = parseInt(process.env.POLLING_INTERVAL_MS || '60000', 10);
const MODEL_LABEL_PATTERN = process.env.MODEL_LABEL_PATTERN || '^llm-claude-(.+)$';
const DEFAULT_MODEL_NAME = process.env.DEFAULT_CLAUDE_MODEL || getDefaultModel();
const GITHUB_USER_BLACKLIST = (process.env.GITHUB_USER_BLACKLIST || '').split(',').filter(u => u);
const PR_FOLLOWUP_TRIGGER_KEYWORDS = (process.env.PR_FOLLOWUP_TRIGGER_KEYWORDS !== undefined ? process.env.PR_FOLLOWUP_TRIGGER_KEYWORDS : '').split(',').filter(k => k.trim()).map(k => k.trim());
const ENABLE_WEBHOOKS = process.env.ENABLE_GITHUB_WEBHOOKS === 'true';

function getCommentConfig(): CommentEventConfig {
    return {
        redisClient,
        PR_FOLLOWUP_TRIGGER_KEYWORDS,
        MODEL_LABEL_PATTERN,
        processCommentEvent: (payload: CommentPayload, eventType: CommentEventType, correlationId: string) =>
            processCommentEvent(payload, eventType, correlationId, getCommentConfig())
    };
}

async function pollForIssues(): Promise<DetectedIssue[]> {
    const correlationId = generateCorrelationId();
    const correlatedLogger: Logger = logger.withCorrelation(correlationId);

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
        return [];
    }

    const allDetectedIssues: DetectedIssue[] = [];
    const repos = getRepos();

    for (const repoFullName of repos) {
        correlatedLogger.debug({ repository: repoFullName }, 'Polling repository');

        try {
            const issues = await fetchIssuesForRepo(octokit, repoFullName, correlationId);

            if (issues.length > 0) {
                for (const issue of issues) {
                    await processDetectedIssue(issue, correlationId, redisClient);
                    allDetectedIssues.push(issue);
                }
            }

            await pollForPullRequestComments(octokit, repoFullName, correlationId, {
                redisClient,
                PR_FOLLOWUP_TRIGGER_KEYWORDS,
                MODEL_LABEL_PATTERN
            });

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

interface DaemonOptions {
    reset?: boolean;
}

async function startDaemon(options: DaemonOptions = {}): Promise<void> {
    await loadAllConfigs();

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
            const err = error as Error;
            logger.error({ error: err.message, stack: err.stack }, 'Database migration failed - daemon will continue but database persistence may not work');
        }
    }

    if (options.reset) {
        logger.info('Reset flag detected, clearing all queue data and issue labels...');

        try {
            await resetQueues();
            await resetIssueLabels();
            logger.info('Reset completed successfully');
        } catch (error) {
            const err = error as Error;
            logger.error({ error: err.message }, 'Reset failed');
            process.exit(1);
        }
    }

    const heartbeatRedis = new Redis({
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379', 10),
        retryStrategy: (times: number) => Math.min(times * 50, 2000)
    });

    const sendHeartbeat = async (): Promise<void> => {
        try {
            await heartbeatRedis.set('system:status:daemon', Date.now(), 'EX', 90);
            logger.debug('Daemon heartbeat sent');
        } catch (error) {
            const err = error as Error;
            logger.error({ error: err.message }, 'Failed to send daemon heartbeat');
        }
    };

    await sendHeartbeat();
    const heartbeatInterval = setInterval(sendHeartbeat, 30000);

    let intervalId: NodeJS.Timeout | null = null;

    const commentConfig = getCommentConfig();
    const primaryProcessingLabels = getPrimaryProcessingLabels();
    const GITHUB_BOT_USERNAME = getBotUsername();
    const GITHUB_USER_WHITELIST = getUserWhitelist();

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
            (issue: DetectedIssue, correlationId: string) => processDetectedIssue(issue, correlationId, redisClient),
            (payload: CommentPayload, eventType: CommentEventType, correlationId: string) => processCommentEvent(payload, eventType, correlationId, commentConfig),
            (payload: CommentPayload, eventType: CommentEventType, correlationId: string) => handleCommentDeleted(payload, eventType, correlationId, commentConfig),
            (payload: CommentPayload, eventType: CommentEventType, correlationId: string) => handleCommentEdited(payload, eventType, correlationId, commentConfig)
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

    const configReloadInterval = setInterval(reloadConfigs, 5 * 60 * 1000);

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

const processCommentEventWrapper = (payload: CommentPayload, eventType: CommentEventType, correlationId: string): Promise<void> =>
    processCommentEvent(payload, eventType, correlationId, getCommentConfig());
const handleCommentDeletedWrapper = (payload: CommentPayload, eventType: CommentEventType, correlationId: string): Promise<void> =>
    handleCommentDeleted(payload, eventType, correlationId, getCommentConfig());
const handleCommentEditedWrapper = (payload: CommentPayload, eventType: CommentEventType, correlationId: string): Promise<void> =>
    handleCommentEdited(payload, eventType, correlationId, getCommentConfig());

export {
    fetchIssuesForRepo,
    pollForIssues,
    startDaemon,
    resetQueues,
    resetIssueLabels,
    processDetectedIssue,
    loadSettingsFromConfig,
    processCommentEventWrapper as processCommentEvent,
    handleCommentDeletedWrapper as handleCommentDeleted,
    handleCommentEditedWrapper as handleCommentEdited
};

interface ParsedArgs {
    reset?: boolean;
}

function parseArgs(): ParsedArgs {
    const args = process.argv.slice(2);
    const options: ParsedArgs = {};

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
        const err = error as Error;
        logger.error({ error: err.message }, 'Daemon startup failed');
        process.exit(1);
    });
}
