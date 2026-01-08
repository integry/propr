// Worker metrics module - extracted from taskQueue.ts to reduce file size
import { Redis } from 'ioredis';
import { Job } from 'bullmq';
import type { IssueJobData, JobData, JobResult, AiMetrics } from './taskQueue.types.js';

export interface ActivityLog {
    id: string;
    type: string;
    timestamp: string;
    repository: string | null;
    issueNumber?: number;
    description: string;
    status: 'success' | 'error' | 'info';
}

export interface MetricsUpdateOptions {
    duration: number;
    repoFullName: string | null;
}

export function getRepoFullName(job: Job<JobData> | undefined | null): string | null {
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

export function buildAiMetrics(
    job: Job<JobData>,
    result: JobResult | undefined,
    repoFullName: string | null,
    status: 'success' | 'failed'
): AiMetrics {
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

export async function logActivity(metricsRedis: Redis, activity: ActivityLog): Promise<void> {
    await metricsRedis.lpush('system:activity:log', JSON.stringify(activity));
    await metricsRedis.ltrim('system:activity:log', 0, 999);
}

export async function updateCompletedMetrics(
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

export async function updateFailedMetrics(
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
