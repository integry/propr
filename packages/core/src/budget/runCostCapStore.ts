import { Redis } from 'ioredis';
import { db } from '../db/connection.js';
import type { RunCostCap } from './runCostCap.js';

/** Long enough to outlive any run and its retries, short enough to clean itself up. */
const OVERRIDE_TTL_SECONDS = 30 * 24 * 3600;
const RESOLVED_CAP_TTL_SECONDS = 90 * 24 * 3600;

export interface StoredRunCostCap extends RunCostCap {
    /** Earlier task IDs whose spend this run continues. */
    budgetTaskIds?: string[];
}

export interface CostCapRedisClient {
    get(key: string): Promise<string | null>;
    set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
    del(key: string): Promise<unknown>;
    quit?(): Promise<unknown>;
}

function connect(): CostCapRedisClient {
    return new Redis({
        host: process.env.REDIS_HOST ?? '127.0.0.1',
        port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
        maxRetriesPerRequest: 1,
        enableReadyCheck: false,
    });
}

async function withRedis<T>(client: CostCapRedisClient | undefined, operation: (redis: CostCapRedisClient) => Promise<T>): Promise<T> {
    const redis = client ?? connect();
    try { return await operation(redis); } finally { if (!client) await redis.quit?.(); }
}

export function issueCostCapOverrideKey(repository: string, issueNumber: number): string {
    return `propr:cost-cap:override:${repository.toLowerCase()}#${issueNumber}`;
}

export function runCostCapKey(taskId: string): string {
    return `propr:cost-cap:task:${taskId}`;
}

/**
 * Remembers a per-task `maxCostUsd` for an issue whose implementation is
 * started by labels, so the worker that picks the issue up applies it.
 */
export async function storeIssueCostCapOverride(repository: string, issueNumber: number, maxCostUsd: number | null, client?: CostCapRedisClient): Promise<void> {
    await withRedis(client, async redis => {
        const key = issueCostCapOverrideKey(repository, issueNumber);
        if (maxCostUsd && maxCostUsd > 0) await redis.set(key, String(maxCostUsd), 'EX', OVERRIDE_TTL_SECONDS);
        else await redis.del(key);
    });
}

export async function readIssueCostCapOverride(repository: string, issueNumber: number, client?: CostCapRedisClient): Promise<string | undefined> {
    return withRedis(client, async redis => (await redis.get(issueCostCapOverrideKey(repository, issueNumber))) ?? undefined);
}

/** Records the cap a run resolved, so task details can show it beside the spend. */
export async function storeResolvedRunCostCap(taskId: string, cap: StoredRunCostCap | null, client?: CostCapRedisClient): Promise<void> {
    await withRedis(client, async redis => {
        if (cap) await redis.set(runCostCapKey(taskId), JSON.stringify(cap), 'EX', RESOLVED_CAP_TTL_SECONDS);
        else await redis.del(runCostCapKey(taskId));
    });
}

/** Sum of the recorded execution costs of the given tasks. */
export async function readRecordedTaskSpend(taskIds: readonly string[]): Promise<number> {
    const ids = [...new Set(taskIds.filter(Boolean))];
    if (ids.length === 0) return 0;
    const row = await db('llm_executions').whereIn('task_id', ids).sum({ total: 'cost_usd' }).first() as { total?: number | string | null } | undefined;
    const total = Number(row?.total ?? 0);
    return Number.isFinite(total) ? total : 0;
}
