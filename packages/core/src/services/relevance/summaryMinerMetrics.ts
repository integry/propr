import { Redis } from 'ioredis';

// --- Types ---

/**
 * Minimal logger interface that both pino Logger and EnhancedLogger satisfy
 */
interface MinimalLogger {
  info: (obj: unknown, msg?: string) => void;
  debug: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
}

/**
 * Metrics for a single summarization LLM call
 */
export interface SummarizationCallMetrics {
  timestamp: string;
  callType: 'batch_summarization' | 'directory_aggregation' | 'semantic_scoring';
  model: string;
  agentAlias: string;
  repository?: string;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedTotalTokens: number;
  fileCount?: number;
  directoryPath?: string;
  success: boolean;
  durationMs: number;
  error?: string;
}

/**
 * Aggregated summarization metrics
 */
export interface SummarizationMetricsSummary {
  totalCalls: number;
  successfulCalls: number;
  failedCalls: number;
  totalEstimatedInputTokens: number;
  totalEstimatedOutputTokens: number;
  totalDurationMs: number;
  byModel: Record<string, {
    calls: number;
    inputTokens: number;
    outputTokens: number;
  }>;
}

// --- Constants ---

const REDIS_HOST: string = process.env.REDIS_HOST ?? '127.0.0.1';
const REDIS_PORT: number = parseInt(process.env.REDIS_PORT ?? '6379', 10);

// --- Summarization Metrics Logging ---

/**
 * Logs a summarization LLM call to both the logger and Redis for tracking
 */
export async function logSummarizationCall(metrics: SummarizationCallMetrics, log: MinimalLogger): Promise<void> {
  // Log to pino logger
  log.info({
    summarizationCall: true,
    callType: metrics.callType,
    model: metrics.model,
    agentAlias: metrics.agentAlias,
    repository: metrics.repository,
    estimatedInputTokens: metrics.estimatedInputTokens,
    estimatedOutputTokens: metrics.estimatedOutputTokens,
    estimatedTotalTokens: metrics.estimatedTotalTokens,
    fileCount: metrics.fileCount,
    directoryPath: metrics.directoryPath,
    success: metrics.success,
    durationMs: metrics.durationMs,
    error: metrics.error
  }, `Summarization LLM call: ${metrics.callType}`);

  // Store in Redis for aggregation
  let redis: InstanceType<typeof Redis> | null = null;
  try {
    redis = new Redis({
      host: REDIS_HOST,
      port: REDIS_PORT,
      maxRetriesPerRequest: null,
      enableReadyCheck: false
    });

    const dateKey = metrics.timestamp.split('T')[0];

    // Store individual call record (keep last 1000)
    await redis.lpush('summarization:calls:history', JSON.stringify(metrics));
    await redis.ltrim('summarization:calls:history', 0, 999);

    // Update aggregated metrics
    const successKey = metrics.success ? 'successful' : 'failed';
    await redis.incr('summarization:metrics:total:calls');
    await redis.incr(`summarization:metrics:total:${successKey}`);
    await redis.incr(`summarization:metrics:daily:${dateKey}:calls`);
    await redis.incr(`summarization:metrics:daily:${dateKey}:${successKey}`);

    // Track token usage
    const currentInputTokens = parseInt(await redis.get('summarization:metrics:total:inputTokens') ?? '0');
    await redis.set('summarization:metrics:total:inputTokens', currentInputTokens + metrics.estimatedInputTokens);

    const currentOutputTokens = parseInt(await redis.get('summarization:metrics:total:outputTokens') ?? '0');
    await redis.set('summarization:metrics:total:outputTokens', currentOutputTokens + metrics.estimatedOutputTokens);

    // Track by model
    await redis.incr(`summarization:metrics:model:${metrics.model}:calls`);
    const modelInputTokens = parseInt(await redis.get(`summarization:metrics:model:${metrics.model}:inputTokens`) ?? '0');
    await redis.set(`summarization:metrics:model:${metrics.model}:inputTokens`, modelInputTokens + metrics.estimatedInputTokens);
    const modelOutputTokens = parseInt(await redis.get(`summarization:metrics:model:${metrics.model}:outputTokens`) ?? '0');
    await redis.set(`summarization:metrics:model:${metrics.model}:outputTokens`, modelOutputTokens + metrics.estimatedOutputTokens);

    // Track total duration
    const currentDuration = parseInt(await redis.get('summarization:metrics:total:durationMs') ?? '0');
    await redis.set('summarization:metrics:total:durationMs', currentDuration + metrics.durationMs);

    // Track models used
    await redis.sadd('summarization:metrics:models:used', metrics.model);

    log.debug({ model: metrics.model, tokens: metrics.estimatedTotalTokens }, 'Summarization metrics stored in Redis');
  } catch (error) {
    // Don't fail the summarization if metrics logging fails
    log.warn({ error: (error as Error).message }, 'Failed to store summarization metrics in Redis');
  } finally {
    if (redis) {
      await redis.quit();
    }
  }
}

/**
 * Retrieves summarization metrics summary from Redis
 */
export async function getSummarizationMetricsSummary(): Promise<SummarizationMetricsSummary> {
  const redis = new Redis({
    host: REDIS_HOST,
    port: REDIS_PORT,
    maxRetriesPerRequest: null,
    enableReadyCheck: false
  });

  try {
    const totalCalls = parseInt(await redis.get('summarization:metrics:total:calls') ?? '0');
    const successfulCalls = parseInt(await redis.get('summarization:metrics:total:successful') ?? '0');
    const failedCalls = parseInt(await redis.get('summarization:metrics:total:failed') ?? '0');
    const totalEstimatedInputTokens = parseInt(await redis.get('summarization:metrics:total:inputTokens') ?? '0');
    const totalEstimatedOutputTokens = parseInt(await redis.get('summarization:metrics:total:outputTokens') ?? '0');
    const totalDurationMs = parseInt(await redis.get('summarization:metrics:total:durationMs') ?? '0');

    // Get model breakdown
    const modelsUsed = await redis.smembers('summarization:metrics:models:used');
    const byModel: Record<string, { calls: number; inputTokens: number; outputTokens: number }> = {};

    for (const model of modelsUsed) {
      const calls = parseInt(await redis.get(`summarization:metrics:model:${model}:calls`) ?? '0');
      const inputTokens = parseInt(await redis.get(`summarization:metrics:model:${model}:inputTokens`) ?? '0');
      const outputTokens = parseInt(await redis.get(`summarization:metrics:model:${model}:outputTokens`) ?? '0');
      byModel[model] = { calls, inputTokens, outputTokens };
    }

    return {
      totalCalls,
      successfulCalls,
      failedCalls,
      totalEstimatedInputTokens,
      totalEstimatedOutputTokens,
      totalDurationMs,
      byModel
    };
  } finally {
    await redis.quit();
  }
}

/**
 * Retrieves recent summarization call history from Redis
 */
export async function getSummarizationCallHistory(limit: number = 100): Promise<SummarizationCallMetrics[]> {
  const redis = new Redis({
    host: REDIS_HOST,
    port: REDIS_PORT,
    maxRetriesPerRequest: null,
    enableReadyCheck: false
  });

  try {
    const history = await redis.lrange('summarization:calls:history', 0, limit - 1);
    return history.map(entry => {
      try {
        return JSON.parse(entry) as SummarizationCallMetrics;
      } catch {
        return null;
      }
    }).filter((entry): entry is SummarizationCallMetrics => entry !== null);
  } finally {
    await redis.quit();
  }
}
