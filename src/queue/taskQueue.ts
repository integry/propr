import { Queue, Worker, Job } from 'bullmq';
import { Redis } from 'ioredis';
import logger from '../utils/logger.js';
import 'dotenv/config';

const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379', 10);

const connectionOptions = {
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

export interface IssueJobData {
    installationId?: number;
    repoOwner: string;
    repoName: string;
    number: number;
    repository?: string;
    modelName?: string;
    correlationId?: string;
    triggeringLabel?: string;
    baseBranch?: string;
    baseLabel?: string;
    modelLabel?: string;
    isChildJob?: boolean;
    issuePayload?: Record<string, unknown>;
    repoPayload?: Record<string, unknown>;
    title?: string;
    subtitle?: string;
}

export interface CommentJobData {
    pullRequestNumber: number;
    commentId?: number;
    commentBody?: string;
    commentAuthor?: string;
    comments?: Array<{
        id: number;
        body: string;
        author: string;
        type?: string;
        hasCodeContext?: boolean;
        updated_at?: string;
    }>;
    branchName?: string;
    repoOwner: string;
    repoName: string;
    llm?: string;
    correlationId?: string;
    title?: string;
    subtitle?: string;
}

export interface TaskImportJobData {
    taskDescription: string;
    repository: string;
    correlationId: string;
    user?: string;
}

export interface AnalysisJobData {
    repoOwner?: string;
    repoName?: string;
    analysisType: string;
    correlationId?: string;
    taskId?: string | null;
    executionId?: string;
    sessionId?: string;
    data?: Record<string, unknown>;
}

export type JobData = IssueJobData | CommentJobData | TaskImportJobData | AnalysisJobData;

export interface JobResult {
    status: string;
    issueNumber?: number;
    pullRequestNumber?: number;
    repository?: string;
    claudeResult?: {
        success: boolean;
        executionTime?: number;
        modifiedFiles?: string[];
        conversationLog?: unknown[];
        error?: string | null;
        sessionId?: string | null;
        conversationId?: string | null;
        model?: string | null;
    };
    postProcessing?: {
        success: boolean;
        pr?: {
            number: number;
            url: string;
            title: string;
        } | null;
        updatedLabels?: string[];
    };
    commit?: string;
    reason?: string;
    delay?: number;
}

export const GITHUB_ISSUE_QUEUE_NAME = process.env.GITHUB_ISSUE_QUEUE_NAME || 'github-issue-processor';
export const COMMENT_BATCH_DELAY_MS = parseInt(process.env.COMMENT_BATCH_DELAY_MS || '3000', 10);

export const issueQueue = new Queue<IssueJobData | CommentJobData | TaskImportJobData>(GITHUB_ISSUE_QUEUE_NAME, {
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
});

issueQueue.on('error', (err: Error) => {
    logger.error({ queue: GITHUB_ISSUE_QUEUE_NAME, err }, 'Queue error');
});

export const ANALYSIS_QUEUE_NAME = process.env.ANALYSIS_QUEUE_NAME || 'analysis-processor';

export const analysisQueue = new Queue<AnalysisJobData>(ANALYSIS_QUEUE_NAME, {
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
});

analysisQueue.on('error', (err: Error) => {
    logger.error({ queue: ANALYSIS_QUEUE_NAME, err }, 'Analysis Queue error');
});

function getRepoFullName(job: Job<JobData> | null | undefined): string | null {
    if (!job?.data) return null;
    const data = job.data as unknown as Record<string, unknown>;
    if (data.repository && typeof data.repository === 'string') return data.repository;
    if (data.repoOwner && data.repoName) return `${data.repoOwner}/${data.repoName}`;
    return null;
}

function extractCostFromResult(result: JobResult | null | undefined): number {
    const claudeResult = result?.claudeResult as Record<string, unknown> | undefined;
    if (!claudeResult) return 0;
    const cost = (claudeResult.claudeCostUsd ?? claudeResult.costUsd ?? (claudeResult.finalResult as Record<string, unknown> | undefined)?.cost_usd ?? 0) as number;
    return cost;
}

function extractModel(result: JobResult | null | undefined, job: Job<JobData>): string {
    const claudeResult = result?.claudeResult;
    if (claudeResult?.model) return claudeResult.model;
    const data = job.data as unknown as Record<string, unknown>;
    return (data.modelName as string) || 'unknown';
}

function extractTurns(result: JobResult | null | undefined): number {
    const claudeResult = result?.claudeResult as Record<string, unknown> | undefined;
    if (!claudeResult) return 0;
    const turns = (claudeResult.claudeNumTurns ?? (claudeResult.finalResult as Record<string, unknown> | undefined)?.num_turns ?? 0) as number;
    return turns;
}

interface AiMetrics {
    timestamp: number;
    cost: number;
    model: string;
    turns: number;
    executionTimeMs: number;
    issueNumber?: number;
    repo: string | null;
    status: string;
    correlationId?: string;
    error?: string;
}

function buildAiMetrics(job: Job<JobData>, result: JobResult | null | undefined, repoFullName: string | null, status: string): AiMetrics {
    const cost = extractCostFromResult(result);
    const parsedCost = typeof cost === 'string' ? parseFloat(cost) : cost;
    const claudeResult = result?.claudeResult as Record<string, unknown> | undefined;
    const data = job.data as unknown as Record<string, unknown>;

    return {
        timestamp: job.timestamp,
        cost: parsedCost,
        model: extractModel(result, job),
        turns: extractTurns(result),
        executionTimeMs: (claudeResult?.executionTime as number) || 0,
        issueNumber: (data.number as number) || (data.pullRequestNumber as number),
        repo: repoFullName,
        status,
        correlationId: (data.correlationId as string) || (result as Record<string, unknown> | undefined)?.correlationId as string,
    };
}

async function updateCompletedMetrics(metricsRedis: Redis, job: Job<JobData>, result: JobResult, options: { duration: number; repoFullName: string | null }): Promise<void> {
    const { duration, repoFullName } = options;
    const dateKey = new Date().toISOString().split('T')[0];
    await metricsRedis.incr('metrics:jobs:processed');
    await metricsRedis.incr(`metrics:daily:${dateKey}:processed`);
    const totalProcessed = await metricsRedis.get('metrics:jobs:processed') || '1';
    const currentAvg = parseFloat(await metricsRedis.get('metrics:jobs:avgTime') || '0');
    const newAvg = ((currentAvg * (parseInt(totalProcessed) - 1)) + (duration / 1000)) / parseInt(totalProcessed);
    await metricsRedis.set('metrics:jobs:avgTime', newAvg.toFixed(2));
    if (repoFullName) await metricsRedis.sadd('active:repositories', repoFullName);
    const claudeResult = result?.claudeResult as Record<string, unknown> | undefined;
    if (claudeResult) {
        const aiMetrics = buildAiMetrics(job, result, repoFullName, 'success');
        await metricsRedis.zadd('metrics:ai:log:v1', job.timestamp, JSON.stringify(aiMetrics));
    }
}

interface ActivityLog {
    id: string;
    type: string;
    timestamp: string;
    repository?: string | null;
    issueNumber?: number;
    description: string;
    status: string;
}

async function logActivity(metricsRedis: Redis, activity: ActivityLog): Promise<void> {
    await metricsRedis.lpush('system:activity:log', JSON.stringify(activity));
    await metricsRedis.ltrim('system:activity:log', 0, 999);
}

async function updateFailedMetrics(metricsRedis: Redis, job: Job<JobData> | null | undefined, err: Error, repoFullName: string | null): Promise<void> {
    const dateKey = new Date().toISOString().split('T')[0];
    await metricsRedis.incr('metrics:jobs:failed');
    await metricsRedis.incr(`metrics:daily:${dateKey}:failed`);
    if (job?.timestamp) {
        const data = job.data as unknown as Record<string, unknown>;
        const aiMetrics: AiMetrics & { error: string } = {
            timestamp: job.timestamp, cost: 0, model: (data.modelName as string) || 'unknown', turns: 0,
            executionTimeMs: (job.finishedOn || Date.now()) - (job.timestamp || Date.now()),
            issueNumber: (data.number as number) || (data.pullRequestNumber as number), repo: repoFullName, status: 'failed',
            correlationId: data.correlationId as string, error: err.message.substring(0, 100),
        };
        await metricsRedis.zadd('metrics:ai:log:v1', job.timestamp, JSON.stringify(aiMetrics));
    }
}

export interface WorkerOptions {
    concurrency?: number;
}

export type ProcessorFunction<T extends JobData> = (job: Job<T>) => Promise<JobResult>;

export function createWorker<T extends JobData>(
    queueName: string,
    processorFunction: ProcessorFunction<T>,
    options: WorkerOptions = {}
): Worker<T, JobResult> {
    const concurrency = options.concurrency || parseInt(process.env.WORKER_CONCURRENCY || '5', 10);
    const worker = new Worker<T, JobResult>(queueName, processorFunction, {
        connection: redisConnection,
        concurrency: concurrency,
        autorun: true,
    });

    worker.on('completed', async (job: Job<T>, result: JobResult) => {
        const duration = Date.now() - job.timestamp;
        logger.info({ jobId: job.id, jobName: job.name, result, duration }, 'Job completed successfully');
        try {
            const metricsRedis = new Redis(connectionOptions);
            const repoFullName = getRepoFullName(job as Job<JobData>);
            await updateCompletedMetrics(metricsRedis, job as Job<JobData>, result, { duration, repoFullName });
            const data = job.data as unknown as Record<string, unknown>;
            const activity: ActivityLog = {
                id: `activity-${Date.now()}-${job.id}`,
                type: job.name === 'processGitHubIssue' ? 'issue_processed' : 'pr_processed',
                timestamp: new Date().toISOString(), repository: repoFullName, issueNumber: (data.issueNumber as number) || (data.number as number) || (data.pullRequestNumber as number),
                description: `Successfully processed ${job.name === 'processGitHubIssue' ? 'issue' : 'PR'} #${(data.issueNumber as number) || (data.number as number) || (data.pullRequestNumber as number) || 'unknown'}`,
                status: 'success'
            };
            await logActivity(metricsRedis, activity);
            await metricsRedis.quit();
        } catch (error) {
            logger.error({ error: (error as Error).message }, 'Failed to update metrics');
        }
    });

    worker.on('failed', async (job: Job<T> | undefined, err: Error) => {
        const data = job?.data as Record<string, unknown> | undefined;
        logger.error({ jobId: job?.id, jobName: job?.name, data: job?.data, errMessage: err.message, stack: err.stack, attemptsMade: job?.attemptsMade }, 'Job failed');
        try {
            const metricsRedis = new Redis(connectionOptions);
            const repoFullName = getRepoFullName(job as Job<JobData> | undefined);
            await updateFailedMetrics(metricsRedis, job as Job<JobData> | undefined, err, repoFullName);
            const activity: ActivityLog = {
                id: `activity-${Date.now()}-${job?.id || 'unknown'}`, type: 'error',
                timestamp: new Date().toISOString(), repository: repoFullName, issueNumber: (data?.issueNumber as number) || (data?.number as number) || (data?.pullRequestNumber as number),
                description: `Failed to process ${job?.name === 'processGitHubIssue' ? 'issue' : 'PR'} #${(data?.issueNumber as number) || (data?.number as number) || (data?.pullRequestNumber as number) || 'unknown'}: ${err.message}`,
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

export type { Job };
