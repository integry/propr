import { repositoryStorageLifecycle, protectStorageQueue } from '../storage/lifecycle.js';
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
    GoalJobData,
    SystemTaskJobData,
    IndexingJobData,
    MergeConflictJobData,
    AgentRunJobData,
    AgentRunPhase,
    SystemAction,
    AutoResolveContext,
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
    GoalJobData,
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
let _issueQueue: Queue<IssueJobData | CommentJobData | import('./taskQueue.types.js').GoalJobData> | null = null;
let _indexingQueue: Queue<IndexingJobData> | null = null;
let isInitialized = false;

export const GITHUB_ISSUE_QUEUE_NAME = process.env.GITHUB_ISSUE_QUEUE_NAME || 'github-issue-processor';
export const COMMENT_BATCH_DELAY_MS = parseInt(process.env.COMMENT_BATCH_DELAY_MS || '3000', 10);
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

    _issueQueue = protectStorageQueue(new Queue<IssueJobData | CommentJobData | GoalJobData>(GITHUB_ISSUE_QUEUE_NAME, issueQueueOptions));
    _issueQueue.on('error', (err: Error) => {
        logger.error({ queue: GITHUB_ISSUE_QUEUE_NAME, err }, 'Queue error');
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

    _indexingQueue = protectStorageQueue(new Queue<IndexingJobData>(INDEXING_QUEUE_NAME, indexingQueueOptions));
    _indexingQueue.on('error', (err: Error) => {
        logger.error({ queue: INDEXING_QUEUE_NAME, err }, 'Indexing Queue error');
    });

    isInitialized = true;
    logger.debug('Task queues initialized lazily');
}

/**
 * Get the issue queue, initializing if needed.
 */
export async function getIssueQueue(): Promise<Queue<IssueJobData | CommentJobData | import('./taskQueue.types.js').GoalJobData>> {
    await ensureInitialized();
    return _issueQueue!;
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
// Use getIssueQueue(), getIndexingQueue() for safe access
export const issueQueue = new Proxy({} as Queue<IssueJobData | CommentJobData | import('./taskQueue.types.js').GoalJobData>, {
    get(_target, prop) {
        if (!_issueQueue) {
            throw new Error('issueQueue accessed before initialization. Use getIssueQueue() instead or call ensureInitialized() first.');
        }
        return (_issueQueue as unknown as Record<string | symbol, unknown>)[prop];
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
 * A plan issue refines while its PR has queued or running work. A failed
 * attempt settles it, so the retry BullMQ then delays, and later resumes,
 * must bring refinement back; and a retry that then succeeds cannot settle it
 * through its task, which stays failed, so the job's completion does.
 * Best effort, like the task-side settlement.
 */
async function syncPlanRefinementForJobAttempt(job: Job | undefined): Promise<void> {
    if (!job) return;
    try {
        const { syncPlanRefinementForJob } = await import('../services/taskPlanning/planRefinementSettlement.js');
        await syncPlanRefinementForJob(job.data);
    } catch (error) {
        logger.warn({ jobId: job.id, error: (error as Error).message }, 'Failed to sync plan refinement for job attempt');
    }
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
        autorun: options.autorun ?? true,
    };

    const worker = new Worker<T, R>(queueName, job => repositoryStorageLifecycle.use(() => processorFunction(job), {
        filesystem: process.env.GIT_WORKTREES_BASE_PATH || '/tmp/git-processor/worktrees',
        reserveBytes: Number(process.env.WORKTREE_ADMISSION_RESERVE_BYTES || 2 * 1024 ** 3),
        taskBytes: Number(process.env.WORKTREE_TASK_BUDGET_BYTES || 1024 ** 3),
    }), workerOptions);

    worker.on('completed', async (job: Job<T>, result: R) => {
        // BullMQ emits this after moving the job out of active work.
        void syncPlanRefinementForJobAttempt(job as unknown as Job);
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

    worker.on('active', (job: Job<T>) => {
        // Only an attempt resuming after a failure or stall; first attempts are admitted by their webhook.
        if (job.attemptsMade > 0 || (job.attemptsStarted ?? 0) > 1) void syncPlanRefinementForJobAttempt(job as unknown as Job);
    });

    worker.on('failed', async (job: Job<T> | undefined, err: Error) => {
        // BullMQ emits this after moving the job to delayed for its retry, or to failed for good.
        void syncPlanRefinementForJobAttempt(job as unknown as Job | undefined);
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
        concurrency: worker.opts.concurrency,
        autorun: worker.opts.autorun,
    }, worker.opts.autorun ? 'Worker started and listening to queue' : 'Worker configured with autorun disabled');

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
        if (_indexingQueue) {
            await _indexingQueue.close();
        }
        if (redisConnection) {
            await redisConnection.quit();
        }

        // Reset state
        _issueQueue = null;
        _indexingQueue = null;
        redisConnection = null;
        isInitialized = false;

        logger.info('Queue shutdown complete');
    } catch (err) {
        logger.error({ err }, 'Error during queue shutdown');
        throw err;
    }
}
