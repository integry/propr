import 'dotenv/config';
import { Job, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { GITHUB_ISSUE_QUEUE_NAME, createWorker } from '@propr/core';
import type { IssueJobData, CommentJobData, TaskImportJobData, SystemTaskJobData, MergeConflictJobData, JobResult } from '@propr/core';
import { logger } from '@propr/core';
import { generateCorrelationId } from '@propr/core';
import { db } from '@propr/core';
import { AgentRegistry, areAllChecksPassing, getCurrentPRHead } from '@propr/core';
import { loadAiPrimaryTag, loadSettings } from '@propr/core';
import { setCheckRunDeps } from './jobs/ultrafixLoopContinuation.js';
import { processGitHubIssueJob } from './jobs/processGitHubIssueJob.js';
import { processPullRequestCommentJob } from './jobs/processPullRequestCommentJob.js';
import { processTaskImportJob } from './jobs/processTaskImportJob.js';
import { processSystemTaskJob } from './jobs/processSystemTaskJob.js';
import { processMergeConflictJob } from './jobs/processMergeConflictJob.js';

process.on('uncaughtException', (error: Error) => {
    logger.fatal({ error: error.message, stack: error.stack }, 'Uncaught exception in worker');
    process.exit(1);
});

process.on('unhandledRejection', (reason: unknown) => {
    logger.fatal({ reason }, 'Unhandled rejection in worker');
    process.exit(1);
});

const AI_PROCESSING_TAG = process.env.AI_PROCESSING_TAG || 'AI-processing';
const AI_DONE_TAG = process.env.AI_DONE_TAG || 'AI-done';

// Redis channel for real-time config update notifications
const CONFIG_EVENT_CHANNEL = 'system:config:events';

async function getAiPrimaryTag(): Promise<string> {
    try {
        if (process.env.CONFIG_REPO) {
            return await loadAiPrimaryTag();
        }
    } catch (error) {
        const err = error as Error;
        logger.warn({ error: err.message }, 'Failed to load AI primary tag from config, using fallback');
    }
    return process.env.AI_PRIMARY_TAG || 'AI';
}

async function resetWorkerQueues(): Promise<void> {
    logger.info('Resetting worker queue data...');

    try {
        const redis = new Redis({
            host: process.env.REDIS_HOST || '127.0.0.1',
            port: parseInt(process.env.REDIS_PORT || '6379', 10),
            maxRetriesPerRequest: null,
            enableReadyCheck: false,
        });

        const queueName = GITHUB_ISSUE_QUEUE_NAME;
        const keys = await redis.keys(`bull:${queueName}:*`);

        if (keys.length > 0) {
            logger.info({
                queueName,
                keysCount: keys.length
            }, 'Found worker queue keys to delete');

            await redis.del(...keys);

            logger.info({
                queueName,
                deletedKeys: keys.length
            }, 'Successfully cleared all worker queue data');
        } else {
            logger.info({ queueName }, 'No worker queue data found to clear');
        }

        await redis.quit();

    } catch (error) {
        const err = error as Error;
        logger.error({ error: err.message }, 'Failed to reset worker queue data');
        throw error;
    }
}

interface WorkerOptions {
    reset?: boolean;
    help?: boolean;
}

function parseArguments(): WorkerOptions {
    const args = process.argv.slice(2);
    const options: WorkerOptions = {
        reset: false,
        help: false
    };

    for (const arg of args) {
        switch (arg) {
            case '--reset':
                options.reset = true;
                break;
            case '--help':
            case '-h':
                options.help = true;
                break;
            default:
                if (arg.startsWith('--')) {
                    logger.warn({ argument: arg }, 'Unknown command line argument');
                }
        }
    }

    return options;
}

function showHelp(): void {
    console.log(`
GitHub Issue Worker

Usage: node src/worker.js [options]

Options:
  --reset    Clear all queue data before starting worker
  --help     Show this help message

Examples:
  node src/worker.js                 # Start worker normally
  node src/worker.js --reset         # Reset queues and start worker
`);
}

async function startWorker(options: WorkerOptions = {}): Promise<Worker<IssueJobData | CommentJobData | TaskImportJobData | SystemTaskJobData | MergeConflictJobData, JobResult>> {
    const workerId = `worker:${generateCorrelationId()}`;
    let workerConcurrency = parseInt(process.env.WORKER_CONCURRENCY || '5', 10);
    let aiPrimaryTag = 'AI';

    // Run migrations first, before loading any configs from the database
    try {
        logger.info('Running database migrations...');
        await db.migrate.latest();
        logger.info('Database migrations completed successfully');
    } catch (error) {
        const err = error as Error;
        logger.error({
            error: err.message,
            stack: err.stack
        }, 'Database migration failed - worker will continue but database persistence may not work');
    }

    try {
        if (process.env.CONFIG_REPO) {
            const settings = await loadSettings();
            if (settings.worker_concurrency && typeof settings.worker_concurrency === 'number') {
                workerConcurrency = settings.worker_concurrency;
                logger.info({ concurrency: workerConcurrency }, 'Successfully loaded worker_concurrency from config repo');
            } else {
                logger.info({ concurrency: workerConcurrency }, 'Using worker_concurrency from environment variable');
            }
        }
    } catch (error) {
        const err = error as Error;
        logger.warn({ error: err.message }, 'Failed to load settings from config, using environment variable for worker_concurrency');
    }

    try {
        aiPrimaryTag = await getAiPrimaryTag();
    } catch (error) {
        const err = error as Error;
        logger.warn({ error: err.message }, 'Failed to load AI primary tag, using default');
    }

    logger.info({
        queue: GITHUB_ISSUE_QUEUE_NAME,
        processingTag: AI_PROCESSING_TAG,
        primaryTag: aiPrimaryTag,
        doneTag: AI_DONE_TAG,
        concurrency: workerConcurrency,
        resetPerformed: options.reset || false
    }, 'Starting GitHub Issue Worker...');

    const heartbeatRedis = new Redis({
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379', 10),
        retryStrategy: (times: number) => Math.min(times * 50, 2000)
    });

    const sendHeartbeat = async (): Promise<void> => {
        try {
            await heartbeatRedis.sadd('system:status:workers', workerId);
            await heartbeatRedis.expire('system:status:workers', 90);
            logger.debug('Worker heartbeat sent');
        } catch (error) {
            const err = error as Error;
            logger.error({ error: err.message }, 'Failed to send worker heartbeat');
        }
    };

    await sendHeartbeat();

    const heartbeatInterval = setInterval(sendHeartbeat, 30000);

    // Initialize the AgentRegistry which will ensure all configured agent Docker images exist
    logger.info('Initializing agent registry and ensuring Docker images...');
    try {
        const registry = AgentRegistry.getInstance();
        await registry.refresh();
        const agents = registry.getAllAgents();
        logger.info({
            agentCount: agents.length,
            agents: agents.map(a => ({ alias: a.config.alias, type: a.config.type, dockerImage: a.config.dockerImage }))
        }, 'Agent registry initialized successfully');
    } catch (error) {
        const err = error as Error;
        logger.error({ error: err.message }, 'Failed to initialize agent registry. Worker may not function properly.');
    }

    // Wire up check_run dependencies for ultrafix readiness gating
    setCheckRunDeps({
        areAllChecksPassing,
        getCurrentPRHead,
    });
    logger.info('Check run dependencies initialized for ultrafix');

    // --- Real-time Config Subscription Setup ---
    // Create a dedicated Redis client for subscription (subscriber clients cannot run other commands)
    const subscriberRedis = new Redis({
        host: process.env.REDIS_HOST || 'localhost',
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
                logger.info({ event }, 'Received config update event');

                // Handle agent config updates by refreshing the registry
                if (event.subtype === 'agents_update') {
                    logger.info('Refreshing AgentRegistry due to agents_update event...');
                    try {
                        const registry = AgentRegistry.getInstance();
                        await registry.refresh();
                        const agents = registry.getAllAgents();
                        logger.info({
                            agentCount: agents.length,
                            agents: agents.map(a => ({ alias: a.config.alias, type: a.config.type, enabled: a.config.enabled }))
                        }, 'AgentRegistry refreshed successfully');
                    } catch (agentError) {
                        const err = agentError as Error;
                        logger.error({ error: err.message }, 'Failed to refresh AgentRegistry');
                    }
                }
            } catch (parseError) {
                const err = parseError as Error;
                logger.error({ error: err.message, message }, 'Failed to parse config update event');
            }
        }
    });

    const worker = await createWorker(GITHUB_ISSUE_QUEUE_NAME, async (job: Job<IssueJobData | CommentJobData | TaskImportJobData | SystemTaskJobData | MergeConflictJobData>): Promise<JobResult> => {
        if (job.name === 'processGitHubIssue') {
            return processGitHubIssueJob(job as Job<IssueJobData>);
        } else if (job.name === 'processPullRequestComment') {
            return processPullRequestCommentJob(job as Job<CommentJobData>);
        } else if (job.name === 'processTaskImport') {
            return processTaskImportJob(job as Job<TaskImportJobData>);
        } else if (job.name === 'processSystemTask') {
            return processSystemTaskJob(job as Job<SystemTaskJobData>);
        } else if (job.name === 'processMergeConflict') {
            return processMergeConflictJob(job as Job<MergeConflictJobData>);
        } else {
            throw new Error(`Unknown job type: ${job.name}`);
        }
    }, { concurrency: workerConcurrency });

    process.on('SIGINT', async () => {
        logger.info('Worker received SIGINT, shutting down gracefully...');
        await heartbeatRedis.srem('system:status:workers', workerId);
        clearInterval(heartbeatInterval);
        await subscriberRedis.quit();
        await heartbeatRedis.quit();
        await worker.close();
        process.exit(0);
    });

    process.on('SIGTERM', async () => {
        logger.info('Worker received SIGTERM, shutting down gracefully...');
        await heartbeatRedis.srem('system:status:workers', workerId);
        clearInterval(heartbeatInterval);
        await subscriberRedis.quit();
        await heartbeatRedis.quit();
        await worker.close();
        process.exit(0);
    });

    return worker;
}

export { processGitHubIssueJob, processPullRequestCommentJob, processTaskImportJob, processSystemTaskJob, processMergeConflictJob, startWorker };

if (import.meta.url === `file://${process.argv[1]}`) {
    const options = parseArguments();

    if (options.help) {
        showHelp();
        process.exit(0);
    }

    async function main(): Promise<void> {
        try {
            if (options.reset) {
                logger.info('Reset flag detected, clearing worker queue data...');
                await resetWorkerQueues();
                logger.info('Worker reset completed successfully');
            }

            await startWorker(options);
        } catch (error) {
            const err = error as Error;
            logger.error({ error: err.message }, 'Failed to start worker');
            process.exit(1);
        }
    }

    main();
}
