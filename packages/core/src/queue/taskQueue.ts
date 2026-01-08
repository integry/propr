// Task queue module for processing GitHub issues and PR comments
import { Queue, Worker, Job, QueueOptions, WorkerOptions } from 'bullmq';
import { Redis, RedisOptions } from 'ioredis';
import logger from '../utils/logger.js';
import type { ConversationStep } from '../utils/llmMetrics.types.js';
import 'dotenv/config';

export interface IssueJobData {
    repoOwner: string;
    repoName: string;
    number: number;
    repository?: string;
    agentAlias?: string;       // Agent to use (e.g., 'claude', 'gemini', 'codex')
    modelName?: string;
    correlationId?: string;
    triggeringLabel?: string;
    baseBranch?: string;
    baseLabel?: string | null;
    modelLabel?: string | null;
    isChildJob?: boolean;
    issuePayload?: Record<string, unknown>;
    repoPayload?: Record<string, unknown>;
    title?: string;
    subtitle?: string;
    issueNumber?: number;
}

export interface CommentJobData {
    pullRequestNumber: number;
    commentId?: number;
    commentBody?: string;
    commentAuthor?: string;
    comments?: UnprocessedComment[];
    branchName?: string;
    repoOwner: string;
    repoName: string;
    llm?: string | null;
    correlationId: string;
    title?: string;
    subtitle?: string;
}

export interface UnprocessedComment {
    id: number;
    body: string;
    body_html?: string;  // HTML with signed image URLs (from accept: application/vnd.github.full+json)
    author: string;
    type: 'review' | 'issue';
    hasCodeContext?: boolean;
}

export interface TaskImportJobData {
    taskDescription: string;
    repository: string;
    correlationId: string;
    user?: string;
}

export interface AnalysisJobData {
    taskId: string;
    executionId: string;
    sessionId: string;
    correlationId: string;
}

export interface SystemTaskJobData {
    type: 'revert';
    repoName: string;
    prNumber: number;
    commitHash: string;
    targetCommentId: number;
    prBranch: string;
    owner: string;
    correlationId: string;
}

export interface IndexingJobData {
    repository: string;      // Full repo name (e.g., 'owner/repo')
    repoPath: string;        // Path to the cloned repository
    correlationId: string;
    priority?: 'high' | 'normal' | 'low';
    fullReindex?: boolean;   // Force full re-index even if summaries exist
    baseBranch?: string;     // Optional specific branch to index (defaults to repo default branch)
}

export type JobData = IssueJobData | CommentJobData | TaskImportJobData | AnalysisJobData | SystemTaskJobData | IndexingJobData;

export interface ClaudeOutputResult {
    type?: string;
    is_error?: boolean;
    result?: string;
    total_cost_usd?: number;
    cost_usd?: number;
    num_turns?: number;
    model?: string;
    conversation_id?: string;
}

export interface ClaudeResult {
    success: boolean;
    sessionId?: string | null;
    conversationId?: string;
    executionTime?: number;
    model?: string;
    finalResult?: ClaudeOutputResult | null;
    conversationLog?: ConversationStep[];
    claudeCostUsd?: number;
    costUsd?: number;
    claudeNumTurns?: number;
    output?: {
        rawOutput?: string;
    };
    rawOutput?: string;
    error?: string;
}

export interface JobResult {
    status: string;
    claudeResult?: ClaudeResult;
    correlationId?: string;
    [key: string]: unknown;
}

export interface AiMetrics {
    timestamp: number;
    cost: number;
    model: string;
    turns: number;
    executionTimeMs: number;
    issueNumber?: number;
    repo: string | null;
    status: 'success' | 'failed';
    correlationId?: string;
    error?: string;
}

export interface WorkerCreateOptions {
    concurrency?: number;
}

const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379', 10);

const connectionOptions: RedisOptions = {
    host: REDIS_HOST,
    port: REDIS_PORT,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
};

// Lazy-loaded Redis connection - only created when actually needed
let redisConnection: Redis | null = null;
let redisConnectionInitialized = false;

/**
 * Get the shared Redis connection, creating it lazily if needed.
 * This prevents connections from being created at module load time.
 */
function getRedisConnection(): Redis {
    if (!redisConnection) {
        redisConnection = new Redis(connectionOptions);
        redisConnectionInitialized = true;

        redisConnection.on('connect', () => {
            logger.info('Successfully connected to Redis for BullMQ.');
        });

        redisConnection.on('error', (err: Error) => {
            logger.error({ err }, 'Redis connection error for BullMQ.');
        });
    }
    return redisConnection;
}

export const GITHUB_ISSUE_QUEUE_NAME = process.env.GITHUB_ISSUE_QUEUE_NAME || 'github-issue-processor';

export const COMMENT_BATCH_DELAY_MS = parseInt(process.env.COMMENT_BATCH_DELAY_MS || '3000', 10);

// Lazy-loaded queues - only created when actually accessed
let _issueQueue: Queue<IssueJobData | CommentJobData> | null = null;
let _analysisQueue: Queue<AnalysisJobData> | null = null;
let _indexingQueue: Queue<IndexingJobData> | null = null;

function getIssueQueueOptions(): QueueOptions {
    return {
        connection: getRedisConnection(),
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
}

/**
 * Get the issue queue, creating it lazily if needed.
 */
export function getIssueQueue(): Queue<IssueJobData | CommentJobData> {
    if (!_issueQueue) {
        _issueQueue = new Queue<IssueJobData | CommentJobData>(GITHUB_ISSUE_QUEUE_NAME, getIssueQueueOptions());
        _issueQueue.on('error', (err: Error) => {
            logger.error({ queue: GITHUB_ISSUE_QUEUE_NAME, err }, 'Queue error');
        });
    }
    return _issueQueue;
}

// Backwards compatibility - getter that lazily initializes the queue
export const issueQueue = {
    get add() { return getIssueQueue().add.bind(getIssueQueue()); },
    get close() { return getIssueQueue().close.bind(getIssueQueue()); },
    get on() { return getIssueQueue().on.bind(getIssueQueue()); },
    get getJob() { return getIssueQueue().getJob.bind(getIssueQueue()); },
    get getJobs() { return getIssueQueue().getJobs.bind(getIssueQueue()); },
    get getActive() { return getIssueQueue().getActive.bind(getIssueQueue()); },
    get getWaiting() { return getIssueQueue().getWaiting.bind(getIssueQueue()); },
    get getDelayed() { return getIssueQueue().getDelayed.bind(getIssueQueue()); },
    get obliterate() { return getIssueQueue().obliterate.bind(getIssueQueue()); },
    get pause() { return getIssueQueue().pause.bind(getIssueQueue()); },
    get resume() { return getIssueQueue().resume.bind(getIssueQueue()); },
    get drain() { return getIssueQueue().drain.bind(getIssueQueue()); },
    get clean() { return getIssueQueue().clean.bind(getIssueQueue()); },
    get getRepeatableJobs() { return getIssueQueue().getRepeatableJobs.bind(getIssueQueue()); },
    get removeRepeatableByKey() { return getIssueQueue().removeRepeatableByKey.bind(getIssueQueue()); },
    get name() { return GITHUB_ISSUE_QUEUE_NAME; },
};

export const ANALYSIS_QUEUE_NAME = process.env.ANALYSIS_QUEUE_NAME || 'analysis-processor';

function getAnalysisQueueOptions(): QueueOptions {
    return {
        connection: getRedisConnection(),
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
}

/**
 * Get the analysis queue, creating it lazily if needed.
 */
export function getAnalysisQueue(): Queue<AnalysisJobData> {
    if (!_analysisQueue) {
        _analysisQueue = new Queue<AnalysisJobData>(ANALYSIS_QUEUE_NAME, getAnalysisQueueOptions());
        _analysisQueue.on('error', (err: Error) => {
            logger.error({ queue: ANALYSIS_QUEUE_NAME, err }, 'Analysis Queue error');
        });
    }
    return _analysisQueue;
}

// Backwards compatibility - getter that lazily initializes the queue
export const analysisQueue = {
    get add() { return getAnalysisQueue().add.bind(getAnalysisQueue()); },
    get close() { return getAnalysisQueue().close.bind(getAnalysisQueue()); },
    get on() { return getAnalysisQueue().on.bind(getAnalysisQueue()); },
    get getJob() { return getAnalysisQueue().getJob.bind(getAnalysisQueue()); },
    get getJobs() { return getAnalysisQueue().getJobs.bind(getAnalysisQueue()); },
    get obliterate() { return getAnalysisQueue().obliterate.bind(getAnalysisQueue()); },
    get pause() { return getAnalysisQueue().pause.bind(getAnalysisQueue()); },
    get resume() { return getAnalysisQueue().resume.bind(getAnalysisQueue()); },
    get drain() { return getAnalysisQueue().drain.bind(getAnalysisQueue()); },
    get clean() { return getAnalysisQueue().clean.bind(getAnalysisQueue()); },
    get getRepeatableJobs() { return getAnalysisQueue().getRepeatableJobs.bind(getAnalysisQueue()); },
    get removeRepeatableByKey() { return getAnalysisQueue().removeRepeatableByKey.bind(getAnalysisQueue()); },
    get name() { return ANALYSIS_QUEUE_NAME; },
};

// --- Indexing Queue ---

export const INDEXING_QUEUE_NAME = process.env.INDEXING_QUEUE_NAME || 'indexing-processor';

function getIndexingQueueOptions(): QueueOptions {
    return {
        connection: getRedisConnection(),
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
}

/**
 * Get the indexing queue, creating it lazily if needed.
 */
export function getIndexingQueue(): Queue<IndexingJobData> {
    if (!_indexingQueue) {
        _indexingQueue = new Queue<IndexingJobData>(INDEXING_QUEUE_NAME, getIndexingQueueOptions());
        _indexingQueue.on('error', (err: Error) => {
            logger.error({ queue: INDEXING_QUEUE_NAME, err }, 'Indexing Queue error');
        });
    }
    return _indexingQueue;
}

// Backwards compatibility - getter that lazily initializes the queue
export const indexingQueue = {
    get add() { return getIndexingQueue().add.bind(getIndexingQueue()); },
    get close() { return getIndexingQueue().close.bind(getIndexingQueue()); },
    get on() { return getIndexingQueue().on.bind(getIndexingQueue()); },
    get getJob() { return getIndexingQueue().getJob.bind(getIndexingQueue()); },
    get getJobs() { return getIndexingQueue().getJobs.bind(getIndexingQueue()); },
    get obliterate() { return getIndexingQueue().obliterate.bind(getIndexingQueue()); },
    get pause() { return getIndexingQueue().pause.bind(getIndexingQueue()); },
    get resume() { return getIndexingQueue().resume.bind(getIndexingQueue()); },
    get drain() { return getIndexingQueue().drain.bind(getIndexingQueue()); },
    get clean() { return getIndexingQueue().clean.bind(getIndexingQueue()); },
    get getRepeatableJobs() { return getIndexingQueue().getRepeatableJobs.bind(getIndexingQueue()); },
    get removeRepeatableByKey() { return getIndexingQueue().removeRepeatableByKey.bind(getIndexingQueue()); },
    get name() { return INDEXING_QUEUE_NAME; },
};

function getRepoFullName(job: Job<JobData> | undefined | null): string | null {
    if (!job?.data) return null;
    const data = job.data as IssueJobData;
    if (data.repository) return data.repository;
    if (data.repoOwner && data.repoName) return `${data.repoOwner}/${data.repoName}`;
    return null;
}

function extractCostFromResult(result: JobResult | undefined): number {
    const claudeResult = result?.claudeResult;
    if (!claudeResult) return 0;
    return claudeResult.claudeCostUsd || claudeResult.costUsd || claudeResult.finalResult?.cost_usd || 0;
}

function extractModel(result: JobResult | undefined, job: Job<JobData>): string {
    const data = job.data as IssueJobData;
    return result?.claudeResult?.model || data?.modelName || 'unknown';
}

function extractTurns(result: JobResult | undefined): number {
    const claudeResult = result?.claudeResult;
    if (!claudeResult) return 0;
    return claudeResult.claudeNumTurns || claudeResult.finalResult?.num_turns || 0;
}

function buildAiMetrics(job: Job<JobData>, result: JobResult | undefined, repoFullName: string | null, status: 'success' | 'failed'): AiMetrics {
    const cost = extractCostFromResult(result);
    const parsedCost = typeof cost === 'string' ? parseFloat(cost) : cost;
    const data = job.data as IssueJobData;

    return {
        timestamp: job.timestamp,
        cost: parsedCost,
        model: extractModel(result, job),
        turns: extractTurns(result),
        executionTimeMs: result?.claudeResult?.executionTime || 0,
        issueNumber: data?.number || data?.issueNumber,
        repo: repoFullName,
        status,
        correlationId: data?.correlationId || result?.correlationId,
    };
}

interface MetricsUpdateOptions {
    duration: number;
    repoFullName: string | null;
}

async function updateCompletedMetrics(
    metricsRedis: Redis,
    job: Job<JobData>,
    result: JobResult | undefined,
    options: MetricsUpdateOptions
): Promise<void> {
    const { duration, repoFullName } = options;
    const dateKey = new Date().toISOString().split('T')[0];
    await metricsRedis.incr('metrics:jobs:processed');
    await metricsRedis.incr(`metrics:daily:${dateKey}:processed`);
    const totalProcessed = await metricsRedis.get('metrics:jobs:processed') || '1';
    const currentAvg = parseFloat(await metricsRedis.get('metrics:jobs:avgTime') || '0');
    const newAvg = ((currentAvg * (parseInt(totalProcessed) - 1)) + (duration / 1000)) / parseInt(totalProcessed);
    await metricsRedis.set('metrics:jobs:avgTime', newAvg.toFixed(2));
    if (repoFullName) await metricsRedis.sadd('active:repositories', repoFullName);
    if (result?.claudeResult) {
        const aiMetrics = buildAiMetrics(job, result, repoFullName, 'success');
        await metricsRedis.zadd('metrics:ai:log:v1', job.timestamp, JSON.stringify(aiMetrics));
    }
}

interface ActivityLog {
    id: string;
    type: string;
    timestamp: string;
    repository: string | null;
    issueNumber?: number;
    description: string;
    status: 'success' | 'error' | 'info';
}

async function logActivity(metricsRedis: Redis, activity: ActivityLog): Promise<void> {
    await metricsRedis.lpush('system:activity:log', JSON.stringify(activity));
    await metricsRedis.ltrim('system:activity:log', 0, 999);
}

async function updateFailedMetrics(
    metricsRedis: Redis,
    job: Job<JobData> | undefined | null,
    err: Error,
    repoFullName: string | null
): Promise<void> {
    const dateKey = new Date().toISOString().split('T')[0];
    await metricsRedis.incr('metrics:jobs:failed');
    await metricsRedis.incr(`metrics:daily:${dateKey}:failed`);
    if (job?.timestamp) {
        const data = job.data as IssueJobData;
        const aiMetrics: AiMetrics = {
            timestamp: job.timestamp,
            cost: 0,
            model: data?.modelName || 'unknown',
            turns: 0,
            executionTimeMs: (job.finishedOn || Date.now()) - (job.timestamp || Date.now()),
            issueNumber: data?.number,
            repo: repoFullName,
            status: 'failed',
            correlationId: data?.correlationId,
            error: err.message.substring(0, 100),
        };
        await metricsRedis.zadd('metrics:ai:log:v1', job.timestamp, JSON.stringify(aiMetrics));
    }
}

export type ProcessorFunction<T = JobData, R = JobResult> = (job: Job<T>) => Promise<R>;

// Track created workers for cleanup
const createdWorkers: Worker<JobData, JobResult>[] = [];

export function createWorker<T extends JobData = JobData, R extends JobResult = JobResult>(
    queueName: string,
    processorFunction: ProcessorFunction<T, R>,
    options: WorkerCreateOptions = {}
): Worker<T, R> {
    const concurrency = options.concurrency || parseInt(process.env.WORKER_CONCURRENCY || '5', 10);

    const workerOptions: WorkerOptions = {
        connection: getRedisConnection(),
        concurrency: concurrency,
        autorun: true,
    };

    const worker = new Worker<T, R>(queueName, processorFunction, workerOptions);

    worker.on('completed', async (job: Job<T>, result: R) => {
        const duration = Date.now() - job.timestamp;
        logger.info({ jobId: job.id, jobName: job.name, result, duration }, 'Job completed successfully');
        try {
            const metricsRedis = new Redis(connectionOptions);
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
            const metricsRedis = new Redis(connectionOptions);
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

    // Track worker for cleanup
    createdWorkers.push(worker as unknown as Worker<JobData, JobResult>);

    return worker;
}

/**
 * Shutdown all queues, workers, and Redis connections.
 * This ensures clean exit without hanging connections.
 */
export async function shutdownQueue(): Promise<void> {
    logger.info('Shutting down queue...');

    const errors: Error[] = [];

    // Close all tracked workers first
    for (const worker of createdWorkers) {
        try {
            await worker.close();
        } catch (err) {
            errors.push(err as Error);
            logger.error({ err }, 'Error closing worker');
        }
    }
    createdWorkers.length = 0;

    // Close queues if they were created
    if (_issueQueue) {
        try {
            await _issueQueue.close();
        } catch (err) {
            errors.push(err as Error);
            logger.error({ err }, 'Error closing issue queue');
        }
        _issueQueue = null;
    }

    if (_analysisQueue) {
        try {
            await _analysisQueue.close();
        } catch (err) {
            errors.push(err as Error);
            logger.error({ err }, 'Error closing analysis queue');
        }
        _analysisQueue = null;
    }

    if (_indexingQueue) {
        try {
            await _indexingQueue.close();
        } catch (err) {
            errors.push(err as Error);
            logger.error({ err }, 'Error closing indexing queue');
        }
        _indexingQueue = null;
    }

    // Close Redis connection if it was created
    if (redisConnection && redisConnectionInitialized) {
        try {
            await redisConnection.quit();
        } catch (err) {
            errors.push(err as Error);
            logger.error({ err }, 'Error closing Redis connection');
        }
        redisConnection = null;
        redisConnectionInitialized = false;
    }

    if (errors.length > 0) {
        logger.warn({ errorCount: errors.length }, 'Queue shutdown completed with errors');
    } else {
        logger.info('Queue shutdown complete');
    }
}

/**
 * Check if any queue resources have been initialized.
 * Useful for tests to determine if cleanup is needed.
 */
export function hasQueueResources(): boolean {
    return redisConnectionInitialized || _issueQueue !== null || _analysisQueue !== null || _indexingQueue !== null;
}


