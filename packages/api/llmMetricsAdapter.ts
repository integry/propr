import { Redis } from 'ioredis';
import { isDemoMode } from './demoMode.js';

// Redis configuration
const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379', 10);

const connectionOptions = {
    host: REDIS_HOST,
    port: REDIS_PORT,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
};

let metricsRedis: Redis | null = null;

function getMetricsRedis(): Redis | null {
    if (isDemoMode()) return null;
    metricsRedis ??= new Redis(connectionOptions);
    return metricsRedis;
}

async function getRedisString(key: string): Promise<string | null> {
    const redis = getMetricsRedis();
    if (!redis) return null;
    return redis.get(key);
}

async function getRedisSetMembers(key: string): Promise<string[]> {
    const redis = getMetricsRedis();
    if (!redis) return [];
    return redis.smembers(key);
}

async function getRedisListRange(key: string, start: number, stop: number): Promise<string[]> {
    const redis = getMetricsRedis();
    if (!redis) return [];
    return redis.lrange(key, start, stop);
}

interface ModelMetrics {
    totalRequests: number;
    successful: number;
    failed: number;
    successRate: number;
    totalCostUsd: number;
    avgCostPerRequest: number;
    totalTurns: number;
    avgTurnsPerRequest: number;
    avgExecutionTimeSec: number;
}

interface DailyMetric {
    date: string;
    successful: number;
    failed: number;
    total: number;
    costUsd: number;
}

interface HighCostAlert {
    [key: string]: unknown;
}

interface LLMMetricsSummary {
    summary: {
        totalRequests: number;
        totalSuccessful: number;
        totalFailed: number;
        successRate: number;
        totalCostUsd: number;
        avgCostPerRequest: number;
        totalTurns: number;
        avgTurnsPerRequest: number;
        avgExecutionTimeSec: number;
    };
    modelBreakdown: Record<string, ModelMetrics>;
    dailyMetrics: DailyMetric[];
    recentHighCostAlerts: HighCostAlert[];
    lastUpdated: string;
}

interface LLMMetricsDetail {
    [key: string]: unknown;
}

async function getTotalMetrics(): Promise<{
    totalSuccessful: number;
    totalFailed: number;
    totalCostUsd: number;
    totalTurns: number;
    totalExecutionTimeMs: number;
}> {
    const totalSuccessful = parseInt(await getRedisString('llm:metrics:total:successful') || '0');
    const totalFailed = parseInt(await getRedisString('llm:metrics:total:failed') || '0');
    const totalCostUsd = parseFloat(await getRedisString('llm:metrics:total:costUsd') || '0');
    const totalTurns = parseInt(await getRedisString('llm:metrics:total:turns') || '0');
    const totalExecutionTimeMs = parseInt(await getRedisString('llm:metrics:total:executionTimeMs') || '0');
    return { totalSuccessful, totalFailed, totalCostUsd, totalTurns, totalExecutionTimeMs };
}

async function getModelMetrics(model: string): Promise<ModelMetrics> {
    const modelSuccessful = parseInt(await getRedisString(`llm:metrics:model:${model}:successful`) || '0');
    const modelFailed = parseInt(await getRedisString(`llm:metrics:model:${model}:failed`) || '0');
    const modelCostUsd = parseFloat(await getRedisString(`llm:metrics:model:${model}:costUsd`) || '0');
    const modelTurns = parseInt(await getRedisString(`llm:metrics:model:${model}:turns`) || '0');
    const modelExecutionTimeMs = parseInt(await getRedisString(`llm:metrics:model:${model}:executionTimeMs`) || '0');
    const modelTotal = modelSuccessful + modelFailed;
    return {
        totalRequests: modelTotal,
        successful: modelSuccessful,
        failed: modelFailed,
        successRate: modelTotal > 0 ? modelSuccessful / modelTotal : 0,
        totalCostUsd: modelCostUsd,
        avgCostPerRequest: modelTotal > 0 ? modelCostUsd / modelTotal : 0,
        totalTurns: modelTurns,
        avgTurnsPerRequest: modelTotal > 0 ? modelTurns / modelTotal : 0,
        avgExecutionTimeSec: modelTotal > 0 ? (modelExecutionTimeMs / modelTotal) / 1000 : 0
    };
}

async function getDailyMetric(dateKey: string): Promise<DailyMetric> {
    const daySuccessful = parseInt(await getRedisString(`llm:metrics:daily:${dateKey}:successful`) || '0');
    const dayFailed = parseInt(await getRedisString(`llm:metrics:daily:${dateKey}:failed`) || '0');
    const dayCostUsd = parseFloat(await getRedisString(`llm:metrics:daily:${dateKey}:costUsd`) || '0');
    return {
        date: dateKey,
        successful: daySuccessful,
        failed: dayFailed,
        total: daySuccessful + dayFailed,
        costUsd: dayCostUsd
    };
}

function parseHighCostAlerts(alerts: string[]): HighCostAlert[] {
    return alerts.map((alert: string) => {
        try {
            return JSON.parse(alert) as HighCostAlert;
        } catch {
            return null;
        }
    }).filter((alert: HighCostAlert | null): alert is HighCostAlert => alert !== null);
}

export async function getLLMMetricsSummary(): Promise<LLMMetricsSummary> {
    try {
        const totals = await getTotalMetrics();
        const totalRequests = totals.totalSuccessful + totals.totalFailed;
        const successRate = totalRequests > 0 ? totals.totalSuccessful / totalRequests : 0;
        const avgCostPerRequest = totalRequests > 0 ? totals.totalCostUsd / totalRequests : 0;
        const avgTurnsPerRequest = totalRequests > 0 ? totals.totalTurns / totalRequests : 0;
        const avgExecutionTimeSec = totalRequests > 0 ? (totals.totalExecutionTimeMs / totalRequests) / 1000 : 0;

        const modelsUsed = await getRedisSetMembers('llm:metrics:models:used');
        const modelMetrics: Record<string, ModelMetrics> = {};
        for (const model of modelsUsed) {
            modelMetrics[model] = await getModelMetrics(model);
        }

        const dailyMetrics: DailyMetric[] = [];
        const today = new Date();
        for (let i = 0; i < 7; i++) {
            const date = new Date(today);
            date.setDate(date.getDate() - i);
            const dateKey = date.toISOString().split('T')[0];
            dailyMetrics.push(await getDailyMetric(dateKey));
        }

        const highCostAlerts = await getRedisListRange('llm:metrics:alerts:highcost', 0, 9);
        const parsedAlerts = parseHighCostAlerts(highCostAlerts);

        return {
            summary: {
                totalRequests,
                totalSuccessful: totals.totalSuccessful,
                totalFailed: totals.totalFailed,
                successRate,
                totalCostUsd: totals.totalCostUsd,
                avgCostPerRequest,
                totalTurns: totals.totalTurns,
                avgTurnsPerRequest,
                avgExecutionTimeSec
            },
            modelBreakdown: modelMetrics,
            dailyMetrics,
            recentHighCostAlerts: parsedAlerts,
            lastUpdated: new Date().toISOString()
        };
    } catch (error) {
        console.error('Failed to retrieve LLM metrics summary:', error);
        throw error;
    }
}

/**
 * Retrieves detailed LLM metrics for a specific correlation ID
 * @param {string} correlationId - Correlation ID
 * @returns {Promise<LLMMetricsDetail | null>} Detailed LLM metrics or null
 */
export async function getLLMMetricsByCorrelationId(correlationId: string): Promise<LLMMetricsDetail | null> {
    try {
        const metricsKey = `llm:metrics:${correlationId}`;
        const metricsData = await getRedisString(metricsKey);
        
        if (metricsData) {
            return JSON.parse(metricsData) as LLMMetricsDetail;
        }
        
        return null;
    } catch (error) {
        console.error('Failed to retrieve LLM metrics by correlation ID:', error);
        return null;
    }
}
