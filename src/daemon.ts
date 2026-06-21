import 'dotenv/config';
import { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { parseTruthyEnvValue, resolveGithubEventIntakeMode } from '@propr/shared';
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
    initializeWebhookHandler,
    RoutingWebSocketIntakeService,
    handleCommentDeleted,
    handleCommentEdited,
    processCommentEvent,
    setUltrafixDeps,
    setUltrafixCheckRunHook,
    areAllChecksPassing,
    getCurrentPRHead,
    getCheckRunsStatus,
    loadUltrafixRatingGoal,
    loadUltrafixMaxCycles,
    loadUltrafixPauseSeconds,
    loadPrReviewModel,
    AgentRegistry
} from '@propr/core';
import type { CommentPayload, CommentEventConfig, CommentEventType } from '@propr/core';
import { logger } from '@propr/core';
import { pollForPullRequestComments } from './polling/prCommentPolling.js';
import {
    loadAllConfigs,
    reloadConfigs,
    getRepos,
    getBotUsername,
    getUserWhitelist,
    getPrimaryProcessingLabels,
    loadSettingsFromConfig
} from '@propr/core';
import { resetQueues, resetIssueLabels } from './daemon/queueReset.js';
import { sweepDraftContext } from './daemon/draftContextSweep.js';
import { processDetectedIssue, fetchIssuesForRepo } from './daemon/issueDetection.js';
import type { DetectedIssue } from './daemon/issueDetection.js';
import { startLoop, clearState } from './jobs/ultrafixOrchestrationService.js';
import { getPendingReviewState } from './jobs/reviewCommentGatherer.js';
import { setCheckRunDeps, resumeDeferredContinuation } from './jobs/ultrafixLoopContinuation.js';
import { parseArgs } from './daemon/cliArgs.js';

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
const MODEL_LABEL_PATTERN = process.env.MODEL_LABEL_PATTERN || '^llm-(.+)$';
const DEFAULT_MODEL_NAME = process.env.DEFAULT_CLAUDE_MODEL || getDefaultModel();
const GITHUB_USER_BLACKLIST = (process.env.GITHUB_USER_BLACKLIST || '').split(',').filter(u => u);
const PR_FOLLOWUP_TRIGGER_KEYWORDS = (process.env.PR_FOLLOWUP_TRIGGER_KEYWORDS !== undefined ? process.env.PR_FOLLOWUP_TRIGGER_KEYWORDS : '').split(',').filter(k => k.trim()).map(k => k.trim());
// Resolve how GitHub events are delivered. The new default is `routing_websocket`,
// with explicit `polling` and `direct_webhook` opt-ins. The legacy boolean
// ENABLE_GITHUB_WEBHOOKS is deprecated and no longer selects the mode — the
// resolver surfaces a deprecation warning when it is still set (logged at startup).
const eventIntakeModeResult = resolveGithubEventIntakeMode({
    eventIntakeMode: process.env.GITHUB_EVENT_INTAKE_MODE,
    enableGithubWebhooks: process.env.ENABLE_GITHUB_WEBHOOKS,
});
const EVENT_INTAKE_MODE = eventIntakeModeResult.mode;
const ENABLE_PR_COMMENT_POLLING = process.env.ENABLE_PR_COMMENT_POLLING === undefined
    ? true
    : parseTruthyEnvValue(process.env.ENABLE_PR_COMMENT_POLLING);

// Redis channel for real-time config update notifications
const CONFIG_EVENT_CHANNEL = 'system:config:events';

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

            if (ENABLE_PR_COMMENT_POLLING) {
                await pollForPullRequestComments(octokit, repoFullName, correlationId, {
                    redisClient,
                    PR_FOLLOWUP_TRIGGER_KEYWORDS,
                    MODEL_LABEL_PATTERN
                });
            }

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

// Reclaim stale draft context (generated_context + cached file previews) past its TTL.
// The first run on startup also backfills any historically-accumulated context, then
// it runs on an interval. Returns the interval handle so the caller can clear it on shutdown.
async function scheduleDraftContextSweep(): Promise<NodeJS.Timeout> {
    const DRAFT_CONTEXT_SWEEP_INTERVAL_MS = parseInt(process.env.DRAFT_CONTEXT_SWEEP_INTERVAL_MS || `${60 * 60 * 1000}`, 10);
    await sweepDraftContext();
    return setInterval(() => { void sweepDraftContext(); }, DRAFT_CONTEXT_SWEEP_INTERVAL_MS);
}

async function startDaemon(options: DaemonOptions = {}): Promise<void> {
    // Run migrations first, before loading any configs from the database
    try {
        logger.info('Running database migrations...');
        await db.migrate.latest();
        logger.info('Database migrations completed successfully');
    } catch (error) {
        const err = error as Error;
        logger.error({ error: err.message, stack: err.stack }, 'Database migration failed - daemon will continue but database persistence may not work');
    }

    await loadAllConfigs();

    // Wire up ultrafix dependencies so packages/core can call into app-level services
    // without cross-package imports.
    setUltrafixDeps({
        loadUltrafixRatingGoal,
        loadUltrafixMaxCycles,
        loadUltrafixPauseSeconds,
        loadPrReviewModel,
        startLoop,
        clearState,
        getPendingReviewState,
    });

    // Wire up check_run dependencies for ultrafix readiness gating
    setCheckRunDeps({
        areAllChecksPassing,
        getCurrentPRHead,
        getCheckRunsStatus,
    });

    // Wire up check_run hook to resume deferred ultrafix continuations
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    setUltrafixCheckRunHook(async (owner: string, repo: string, prNumber: number, _headSha: string) => {
        const log = logger.withCorrelation(generateCorrelationId());
        await resumeDeferredContinuation({ owner, repo, pr: prNumber }, redisClient, log as unknown as Logger);
    });

    const repos = getRepos();

    if (repos.length === 0) {
        logger.error('No repositories configured. Set GITHUB_REPOS_TO_MONITOR or CONFIG_REPO. Exiting.');
        process.exit(1);
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

    const draftContextSweepInterval = await scheduleDraftContextSweep();

    let intervalId: NodeJS.Timeout | null = null;
    let routingService: RoutingWebSocketIntakeService | null = null;
    let routingStatusInterval: NodeJS.Timeout | null = null;

    const commentConfig = getCommentConfig();
    const primaryProcessingLabels = getPrimaryProcessingLabels();
    const GITHUB_BOT_USERNAME = getBotUsername();
    const GITHUB_USER_WHITELIST = getUserWhitelist();

    // Define safePoll function for polling mode (used for both regular polling and on-demand config updates)
    const safePoll = withErrorHandling(pollForIssues, 'daemon polling');

    // Surface resolver warnings on startup (e.g. a still-present, deprecated
    // ENABLE_GITHUB_WEBHOOKS that no longer affects mode selection).
    for (const warning of eventIntakeModeResult.warnings) {
        logger.warn({ eventIntakeMode: EVENT_INTAKE_MODE }, warning);
    }

    const baseStartupLog = {
        repositories: repos,
        primaryProcessingLabels: primaryProcessingLabels,
        modelLabelPattern: MODEL_LABEL_PATTERN,
        defaultModelName: DEFAULT_MODEL_NAME,
        botUsername: GITHUB_BOT_USERNAME || 'not configured',
        userWhitelist: GITHUB_USER_WHITELIST.length > 0 ? GITHUB_USER_WHITELIST : '',
        userBlacklist: GITHUB_USER_BLACKLIST.length > 0 ? GITHUB_USER_BLACKLIST : 'no users blocked',
        prFollowupTriggerKeywords: PR_FOLLOWUP_TRIGGER_KEYWORDS.length > 0 ? PR_FOLLOWUP_TRIGGER_KEYWORDS : 'any comment triggers',
        resetPerformed: !!options.reset
    };

    // Initialize the shared webhook handler — registers the processors that turn
    // GitHub events into ProPR work. Used by both routing_websocket (events arrive
    // over the routing relay) and direct_webhook (events arrive at the local
    // webhook endpoint); only the event source differs.
    const initSharedWebhookHandler = async (): Promise<void> => {
        await initializeWebhookHandler({
            issueProcessor: (issue: DetectedIssue, correlationId: string) => processDetectedIssue(issue, correlationId, redisClient),
            commentProcessor: (payload: CommentPayload, eventType: CommentEventType, correlationId: string) => processCommentEvent(payload, eventType, correlationId, commentConfig),
            commentDeletedHandler: (payload: CommentPayload, eventType: CommentEventType, correlationId: string) => handleCommentDeleted(payload, eventType, correlationId, commentConfig),
            commentEditedHandler: (payload: CommentPayload, eventType: CommentEventType, correlationId: string) => handleCommentEdited(payload, eventType, correlationId, commentConfig)
        });
    };

    switch (EVENT_INTAKE_MODE) {
        case 'polling': {
            logger.info({
                ...baseStartupLog,
                pollingInterval: POLLING_INTERVAL_MS,
            }, 'GitHub Issue Detection Daemon starting in polling mode...');

            safePoll();
            intervalId = setInterval(safePoll, POLLING_INTERVAL_MS);
            break;
        }

        case 'direct_webhook': {
            logger.info({
                ...baseStartupLog,
                webhookEnabled: true,
                webhookSecretConfigured: !!process.env.GH_WEBHOOK_SECRET,
            }, 'GitHub Issue Detection Daemon starting in direct webhook mode...');

            if (!process.env.GH_WEBHOOK_SECRET) {
                logger.warn('GH_WEBHOOK_SECRET is not set! Webhook signature verification will be skipped.');
            }

            await initSharedWebhookHandler();
            logger.info('Webhook handler initialized. Webhooks will be received by dashboard API service.');
            break;
        }

        case 'routing_websocket': {
            logger.info({
                ...baseStartupLog,
                routingUrl: process.env.PROPR_ROUTING_URL || 'not configured',
            }, 'GitHub Issue Detection Daemon starting in routing WebSocket mode...');

            // The routing relay forwards events into the same shared handler, so
            // initialize it before opening the connection to avoid dropping events.
            await initSharedWebhookHandler();
            logger.info('Webhook handler initialized. GitHub events will be received over the routing WebSocket.');

            routingService = new RoutingWebSocketIntakeService();
            await routingService.start();

            // Publish the routing connection's runtime state to Redis so the API
            // status route (a separate process) and `propr check` can report
            // connectivity, last delivery id, and last ACK for the default intake
            // path. The key carries a TTL so it disappears if the daemon dies.
            const publishRoutingStatus = async (): Promise<void> => {
                if (!routingService) return;
                try {
                    await heartbeatRedis.set(
                        'system:status:routing',
                        JSON.stringify(routingService.getStatus()),
                        'EX',
                        90,
                    );
                } catch (error) {
                    logger.error({ error: (error as Error).message }, 'Failed to publish routing status');
                }
            };
            await publishRoutingStatus();
            routingStatusInterval = setInterval(() => { void publishRoutingStatus(); }, 30000);
            break;
        }
    }

    const configReloadInterval = setInterval(reloadConfigs, 5 * 60 * 1000);

    // --- Real-time Config Subscription Setup ---
    // Create a dedicated Redis client for subscription (subscriber clients cannot run other commands)
    const subscriberRedis = new Redis({
        host: process.env.REDIS_HOST || '127.0.0.1',
        port: parseInt(process.env.REDIS_PORT || '6379', 10),
        retryStrategy: (times: number) => Math.min(times * 50, 2000)
    });

    // Subscribe to config update events
    subscriberRedis.subscribe(CONFIG_EVENT_CHANNEL, (err) => {
        if (err) {
            logger.error({ error: err.message }, 'Failed to subscribe to config events channel');
        } else {
            logger.info({ channel: CONFIG_EVENT_CHANNEL }, 'Subscribed to config update events');
        }
    });

    // Handle incoming config update messages
    subscriberRedis.on('message', async (channel, message) => {
        if (channel === CONFIG_EVENT_CHANNEL) {
            try {
                const event = JSON.parse(message);
                logger.info({ event }, 'Received config update event, reloading configs...');

                // 1. Reload base configs (repos, settings, tags, etc.)
                await reloadConfigs();

                // 2. Handle specific update types
                if (event.subtype === 'agents_update') {
                    logger.info('Refreshing AgentRegistry...');
                    try {
                        await AgentRegistry.getInstance().refresh();
                    } catch (agentError) {
                        const err = agentError as Error;
                        logger.error({ error: err.message }, 'Failed to refresh AgentRegistry');
                    }
                }

                // 3. If repos changed and we are in polling mode, trigger immediate poll
                // This ensures new repos are picked up right away
                if (event.subtype === 'repos_update' && EVENT_INTAKE_MODE === 'polling' && intervalId) {
                    logger.info('Repository configuration changed, triggering immediate poll...');

                    // Reset the interval to avoid double-polling immediately
                    clearInterval(intervalId);

                    // Run poll immediately, then restore the interval
                    safePoll().finally(() => {
                        intervalId = setInterval(safePoll, POLLING_INTERVAL_MS);
                    });
                }
            } catch (error) {
                const err = error as Error;
                logger.error({ error: err.message }, 'Error handling config update event');
            }
        }
    });

    const shutdown = async (signal: string): Promise<void> => {
        logger.info(`Received ${signal}, shutting down gracefully...`);
        if (intervalId) clearInterval(intervalId);
        clearInterval(configReloadInterval);
        clearInterval(heartbeatInterval);
        clearInterval(draftContextSweepInterval);
        if (routingStatusInterval) clearInterval(routingStatusInterval);
        if (routingService) {
            await routingService.stop();
            // Clear the published state promptly so status consumers see the
            // routing path is down instead of waiting for the TTL to lapse.
            try {
                await heartbeatRedis.del('system:status:routing');
            } catch (error) {
                logger.error({ error: (error as Error).message }, 'Failed to clear routing status on shutdown');
            }
        }
        await subscriberRedis.quit();
        await heartbeatRedis.quit();
        await redisClient.quit();
        await shutdownQueue();
        process.exit(0);
    };

    process.on('SIGINT', () => { void shutdown('SIGINT'); });
    process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
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

if (import.meta.url === `file://${process.argv[1]}`) {
    const options = parseArgs();
    startDaemon(options).catch(error => {
        const err = error as Error;
        logger.error({ error: err.message }, 'Daemon startup failed');
        process.exit(1);
    });
}
