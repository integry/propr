// Task queue module for processing GitHub issues and PR comments
import { Queue, Worker, Job, QueueOptions, WorkerOptions } from 'bullmq';
import { Redis, RedisOptions } from 'ioredis';
import logger from '../utils/logger.js';
import 'dotenv/config';

// Re-export types for backward compatibility
export type {
    IssueJobData,
    CommentJobData,
    UnprocessedComment,
    TaskImportJobData,
    AnalysisJobData,
    SystemTaskJobData,
    IndexingJobData,
    MergeConflictJobData,
    JobData,
    ClaudeOutputResult,
    ClaudeResult,
    JobResult,
    AiMetrics,
    WorkerCreateOptions,
    ActivityLog,
    MetricsUpdateOptions,
    ProcessorFunction,
} from './taskQueue.types.js';

import type {
    IssueJobData,
    CommentJobData,
    AnalysisJobData,
    IndexingJobData,
    JobData,
    JobResult,
    WorkerCreateOptions,
    ActivityLog,
    ProcessorFunction,
} from './taskQueue.types.js';

import {
    getRepoFullName,
    updateCompletedMetrics,
    updateFailedMetrics,
    logActivity,
} from './taskQueue.metrics.js';

const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379', 10);

const connectionOptions: RedisOptions = {
    host: REDIS_HOST,
    port: REDIS_PORT,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: true,
};

// Lazy-initialized Redis connection and queues
let redisConnection: Redis | null = null;
let _issueQueue: Queue<IssueJobData | CommentJobData> | null = null;
let _analysisQueue: Queue<AnalysisJobData> | null = null;
let _indexingQueue: Queue<IndexingJobData> | null = null;
let isInitialized = false;

export const GITHUB_ISSUE_QUEUE_NAME = process.env.GITHUB_ISSUE_QUEUE_NAME || 'github-issue-processor';
export const COMMENT_BATCH_DELAY_MS = parseInt(process.env.COMMENT_BATCH_DELAY_MS || '3000', 10);
export const ANALYSIS_QUEUE_NAME = process.env.ANALYSIS_QUEUE_NAME || 'analysis-processor';
export const INDEXING_QUEUE_NAME = process.env.INDEXING_QUEUE_NAME || 'indexing-processor';

/**
 * Initialize Redis connection and queues lazily.
 * This prevents module-level connections that cause test hangs.
 */
async function ensureInitialized(): Promise<void> {
    if (isInitialized) return;

    redisConnection = new Redis(connectionOptions);

    redisConnection.on('connect', () => {
        logger.info('Successfully connected to Redis for BullMQ.');
    });

    redisConnection.on('error', (err: Error) => {
        logger.error({ err }, 'Redis connection error for BullMQ.');
    });

    await redisConnection.connect();

    const issueQueueOptions: QueueOptions = {
        connection: redisConnection,
        defaultJobOptions: {
            attempts: 3,
            backoff: {
                type: 'exponential',
                delay: 2000,
            },
            removeOnComplete: {
                age: 24 * 3600,
                count: 1000,
            },
            removeOnFail: {
                age: 7 * 24 * 3600,
            },
        },
    };

    _issueQueue = new Queue<IssueJobData | CommentJobData>(GITHUB_ISSUE_QUEUE_NAME, issueQueueOptions);
    _issueQueue.on('error', (err: Error) => {
        logger.error({ queue: GITHUB_ISSUE_QUEUE_NAME, err }, 'Queue error');
    });

    const analysisQueueOptions: QueueOptions = {
        connection: redisConnection,
        defaultJobOptions: {
            attempts: 2,
            backoff: {
                type: 'exponential',
                delay: 60000,
            },
            removeOnComplete: {
                age: 24 * 3600,
                count: 1000,
            },
            removeOnFail: true,
        },
    };

    _analysisQueue = new Queue<AnalysisJobData>(ANALYSIS_QUEUE_NAME, analysisQueueOptions);
    _analysisQueue.on('error', (err: Error) => {
        logger.error({ queue: ANALYSIS_QUEUE_NAME, err }, 'Analysis Queue error');
    });

    const indexingQueueOptions: QueueOptions = {
        connection: redisConnection,
        defaultJobOptions: {
            attempts: 3,
            backoff: {
                type: 'exponential',
                delay: 30000,
            },
            removeOnComplete: {
                age: 7 * 24 * 3600, // Keep for 7 days
                count: 500,
            },
            removeOnFail: {
                age: 14 * 24 * 3600, // Keep failed for 14 days for debugging
            },
        },
    };

    _indexingQueue = new Queue<IndexingJobData>(INDEXING_QUEUE_NAME, indexingQueueOptions);
    _indexingQueue.on('error', (err: Error) => {
        logger.error({ queue: INDEXING_QUEUE_NAME, err }, 'Indexing Queue error');
    });

    isInitialized = true;
    logger.debug('Task queues initialized lazily');
}

/**
 * Get the issue queue, initializing if needed.
 */
export async function getIssueQueue(): Promise<Queue<IssueJobData | CommentJobData>> {
    await ensureInitialized();
    return _issueQueue!;
}

/**
 * Get the analysis queue, initializing if needed.
 */
export async function getAnalysisQueue(): Promise<Queue<AnalysisJobData>> {
    await ensureInitialized();
    return _analysisQueue!;
}

/**
 * Get the indexing queue, initializing if needed.
 */
export async function getIndexingQueue(): Promise<Queue<IndexingJobData>> {
    await ensureInitialized();
    return _indexingQueue!;
}

// Legacy synchronous exports for backward compatibility
// These will throw if accessed before initialization
// Use getIssueQueue(), getAnalysisQueue(), getIndexingQueue() for safe access
export const issueQueue = new Proxy({} as Queue<IssueJobData | CommentJobData>, {
    get(_target, prop) {
        if (!_issueQueue) {
            throw new Error('issueQueue accessed before initialization. Use getIssueQueue() instead or call ensureInitialized() first.');
        }
        return (_issueQueue as unknown as Record<string | symbol, unknown>)[prop];
    }
});

export const analysisQueue = new Proxy({} as Queue<AnalysisJobData>, {
    get(_target, prop) {
        if (!_analysisQueue) {
            throw new Error('analysisQueue accessed before initialization. Use getAnalysisQueue() instead or call ensureInitialized() first.');
        }
        return (_analysisQueue as unknown as Record<string | symbol, unknown>)[prop];
    }
});

export const indexingQueue = new Proxy({} as Queue<IndexingJobData>, {
    get(_target, prop) {
        if (!_indexingQueue) {
            throw new Error('indexingQueue accessed before initialization. Use getIndexingQueue() instead or call ensureInitialized() first.');
        }
        return (_indexingQueue as unknown as Record<string | symbol, unknown>)[prop];
    }
});

/**
 * Create a Redis connection for metrics (separate from queue connection).
 */
function createMetricsRedis(): Redis {
    return new Redis({
        host: REDIS_HOST,
        port: REDIS_PORT,
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
    });
}

/**
 * Create a worker for processing jobs. Initializes Redis connection if needed.
 */
export async function createWorker<T extends JobData = JobData, R extends JobResult = JobResult>(
    queueName: string,
    processorFunction: ProcessorFunction<T, R>,
    options: WorkerCreateOptions = {}
): Promise<Worker<T, R>> {
    await ensureInitialized();

    const concurrency = options.concurrency || parseInt(process.env.WORKER_CONCURRENCY || '5', 10);

    const workerOptions: WorkerOptions = {
        connection: redisConnection!,
        concurrency: concurrency,
        autorun: true,
    };

    const worker = new Worker<T, R>(queueName, processorFunction, workerOptions);

    worker.on('completed', async (job: Job<T>, result: R) => {
        const duration = Date.now() - job.timestamp;
        logger.info({ jobId: job.id, jobName: job.name, result, duration }, 'Job completed successfully');
        try {
            const metricsRedis = createMetricsRedis();
            const repoFullName = getRepoFullName(job as unknown as Job<JobData>);
            await updateCompletedMetrics(metricsRedis, job as unknown as Job<JobData>, result as unknown as JobResult, { duration, repoFullName });
            const issueData = job.data as unknown as IssueJobData;
            const activity: ActivityLog = {
                id: `activity-${Date.now()}-${job.id}`,
                type: job.name === 'processGitHubIssue' ? 'issue_processed' : 'pr_processed',
                timestamp: new Date().toISOString(),
                repository: repoFullName,
                issueNumber: issueData?.issueNumber,
                description: `Successfully processed ${job.name === 'processGitHubIssue' ? 'issue' : 'PR'} #${issueData?.issueNumber || 'unknown'}`,
                status: 'success'
            };
            await logActivity(metricsRedis, activity);
            await metricsRedis.quit();
        } catch (error) {
            logger.error({ error: (error as Error).message }, 'Failed to update metrics');
        }
    });

    worker.on('failed', async (job: Job<T> | undefined, err: Error) => {
        const jobData = job?.data as unknown as IssueJobData | undefined;
        logger.error({
            jobId: job?.id,
            jobName: job?.name,
            data: job?.data,
            errMessage: err.message,
            stack: err.stack,
            attemptsMade: job?.attemptsMade
        }, 'Job failed');
        try {
            const metricsRedis = createMetricsRedis();
            const repoFullName = getRepoFullName(job as unknown as Job<JobData> | undefined);
            await updateFailedMetrics(metricsRedis, job as unknown as Job<JobData> | undefined, err, repoFullName);
            const activity: ActivityLog = {
                id: `activity-${Date.now()}-${job?.id || 'unknown'}`,
                type: 'error',
                timestamp: new Date().toISOString(),
                repository: repoFullName,
                issueNumber: jobData?.issueNumber,
                description: `Failed to process ${job?.name === 'processGitHubIssue' ? 'issue' : 'PR'} #${jobData?.issueNumber || 'unknown'}: ${err.message}`,
                status: 'error'
            };
            await logActivity(metricsRedis, activity);
            await metricsRedis.quit();
        } catch (error) {
            logger.error({ error: (error as Error).message }, 'Failed to update failure metrics');
        }
    });

    worker.on('error', (err: Error) => {
        logger.error({
            queue: queueName,
            errMessage: err.message
        }, 'Worker error');
    });

    worker.on('stalled', (jobId: string) => {
        logger.warn({ jobId }, 'Job stalled and will be retried');
    });

    logger.info({
        queue: queueName,
        concurrency: worker.opts.concurrency
    }, 'Worker started and listening to queue');

    return worker;
}

export async function shutdownQueue(): Promise<void> {
    logger.info('Shutting down queue...');

    if (!isInitialized) {
        logger.info('Queue was never initialized, nothing to shutdown');
        return;
    }

    try {
        if (_issueQueue) {
            await _issueQueue.close();
        }
        if (_analysisQueue) {
            await _analysisQueue.close();
        }
        if (_indexingQueue) {
            await _indexingQueue.close();
        }
        if (redisConnection) {
            await redisConnection.quit();
        }

        // Reset state
        _issueQueue = null;
        _analysisQueue = null;
        _indexingQueue = null;
        redisConnection = null;
        isInitialized = false;

        logger.info('Queue shutdown complete');
    } catch (err) {
        logger.error({ err }, 'Error during queue shutdown');
        throw err;
    }
}
