import { Queue, Worker, Job, QueueOptions, WorkerOptions } from 'bullmq';
import { Redis, RedisOptions } from 'ioredis';
import logger from '../utils/logger.js';
import 'dotenv/config';

export interface IssueJobData {
    repoOwner: string;
    repoName: string;
    number: number;
    repository?: string;
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

export type JobData = IssueJobData | CommentJobData | TaskImportJobData | AnalysisJobData;

export interface ClaudeResult {
    success: boolean;
    sessionId?: string;
    conversationId?: string;
    executionTime?: number;
    model?: string;
    finalResult?: {
        cost_usd?: number;
        num_turns?: number;
        result?: string;
    };
    claudeCostUsd?: number;
    costUsd?: number;
    claudeNumTurns?: number;
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

const redisConnection = new Redis(connectionOptions);

redisConnection.on('connect', () => {
    logger.info('Successfully connected to Redis for BullMQ.');
});

redisConnection.on('error', (err: Error) => {
    logger.error({ err }, 'Redis connection error for BullMQ.');
});

export const GITHUB_ISSUE_QUEUE_NAME = process.env.GITHUB_ISSUE_QUEUE_NAME || 'github-issue-processor';

export const COMMENT_BATCH_DELAY_MS = parseInt(process.env.COMMENT_BATCH_DELAY_MS || '3000', 10);

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

export const issueQueue = new Queue<IssueJobData | CommentJobData>(GITHUB_ISSUE_QUEUE_NAME, issueQueueOptions);

issueQueue.on('error', (err: Error) => {
    logger.error({ queue: GITHUB_ISSUE_QUEUE_NAME, err }, 'Queue error');
});

export const ANALYSIS_QUEUE_NAME = process.env.ANALYSIS_QUEUE_NAME || 'analysis-processor';

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

export const analysisQueue = new Queue<AnalysisJobData>(ANALYSIS_QUEUE_NAME, analysisQueueOptions);

analysisQueue.on('error', (err: Error) => {
    logger.error({ queue: ANALYSIS_QUEUE_NAME, err }, 'Analysis Queue error');
});

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

export function createWorker<T extends JobData = JobData, R extends JobResult = JobResult>(
    queueName: string,
    processorFunction: ProcessorFunction<T, R>,
    options: WorkerCreateOptions = {}
): Worker<T, R> {
    const concurrency = options.concurrency || parseInt(process.env.WORKER_CONCURRENCY || '5', 10);
    
    const workerOptions: WorkerOptions = {
        connection: redisConnection,
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

    return worker;
}

export async function shutdownQueue(): Promise<void> {
    logger.info('Shutting down queue...');

    try {
        await issueQueue.close();
        await analysisQueue.close();
        await redisConnection.quit();
        logger.info('Queue shutdown complete');
    } catch (err) {
        logger.error({ err }, 'Error during queue shutdown');
        throw err;
    }
}


