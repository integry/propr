import 'dotenv/config';
import { Job, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { GITHUB_ISSUE_QUEUE_NAME, createWorker } from './queue/taskQueue.ts';
import type { IssueJobData, CommentJobData, TaskImportJobData, JobResult } from './queue/taskQueue.ts';
import logger, { generateCorrelationId } from './utils/logger.ts';
import { db, isEnabled as isDbEnabled } from './db/postgres.ts';
import { buildClaudeDockerImage } from './claude/claudeService.ts';
import { loadAiPrimaryTag, loadSettings } from './config/configRepoManager.ts';
import { processGitHubIssueJob } from './jobs/processGitHubIssueJob.ts';
import { processPullRequestCommentJob } from './jobs/processPullRequestCommentJob.ts';
import { processTaskImportJob } from './jobs/processTaskImportJob.ts';

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

async function startWorker(options: WorkerOptions = {}): Promise<Worker<IssueJobData | CommentJobData | TaskImportJobData, JobResult>> {
    const workerId = `worker:${generateCorrelationId()}`;
    let workerConcurrency = parseInt(process.env.WORKER_CONCURRENCY || '5', 10);
    let aiPrimaryTag = 'AI';

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

    if (isDbEnabled && db) {
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
    }

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

    logger.info('Checking Claude Code Docker image...');
    const imageReady = await buildClaudeDockerImage();

    if (!imageReady) {
        logger.error('Failed to build Claude Code Docker image. Worker may not function properly.');
    } else {
        logger.info('Claude Code Docker image is ready');
    }

    const worker = createWorker(GITHUB_ISSUE_QUEUE_NAME, async (job: Job<IssueJobData | CommentJobData | TaskImportJobData>): Promise<JobResult> => {
        if (job.name === 'processGitHubIssue') {
            return processGitHubIssueJob(job as Job<IssueJobData>);
        } else if (job.name === 'processPullRequestComment') {
            return processPullRequestCommentJob(job as Job<CommentJobData>);
        } else if (job.name === 'processTaskImport') {
            return processTaskImportJob(job as Job<TaskImportJobData>);
        } else {
            throw new Error(`Unknown job type: ${job.name}`);
        }
    }, { concurrency: workerConcurrency });

    process.on('SIGINT', async () => {
        logger.info('Worker received SIGINT, shutting down gracefully...');
        await heartbeatRedis.srem('system:status:workers', workerId);
        clearInterval(heartbeatInterval);
        await heartbeatRedis.quit();
        await worker.close();
        process.exit(0);
    });

    process.on('SIGTERM', async () => {
        logger.info('Worker received SIGTERM, shutting down gracefully...');
        await heartbeatRedis.srem('system:status:workers', workerId);
        clearInterval(heartbeatInterval);
        await heartbeatRedis.quit();
        await worker.close();
        process.exit(0);
    });

    return worker;
}

export { processGitHubIssueJob, processPullRequestCommentJob, processTaskImportJob, startWorker };

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
