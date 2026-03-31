/**
 * LLM Logger - Persists LLM call logs to the llm_logs table.
 * This is separate from llmMetrics which handles task execution metrics.
 */

import { db } from '../db/connection.js';
import logger from './logger.js';
import { getOpenRouterId } from '../config/modelAliases.js';
import { getModelPricing } from '../services/pricingService.js';
import { calculateCostWithCachePricing } from './tokenCalculation.js';
import type { ExecutionType } from './llmMetrics.types.js';

/** A single structured usage metric record for DB persistence. */
export interface UsageMetricRecordEntry {
  agent: string;
  metricKey: string;
  metricValue: number;
}

export interface LlmLogEntry {
  executionType: ExecutionType;
  modelName: string;
  startTime: Date;
  endTime: Date;
  durationMs: number;
  success: boolean;
  inputTokens?: number;
  outputTokens?: number;
  /** Calculated token count from prompt (using tiktoken) - reliable for single-turn operations */
  estimatedInputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  costUsd?: number;
  errorMessage?: string;
  sessionId?: string;
  correlationId?: string;
  draftId?: string;
  repository?: string;
  agentAlias?: string;
  metadata?: Record<string, unknown>;
  usageMetrics?: Record<string, unknown>;
  /** Structured metric records (one per metric key) for the usage_metric_records table. */
  usageMetricRecords?: UsageMetricRecordEntry[];
}

/**
 * Calculate cost based on model and token usage, including cache tokens.
 * Reuses the shared calculateCostWithCachePricing function.
 */
async function calculateCost(entry: LlmLogEntry): Promise<number | undefined> {
  const inputTokens = entry.inputTokens || 0;
  const outputTokens = entry.outputTokens || 0;
  const cacheCreationTokens = entry.cacheCreationInputTokens || 0;
  const cacheReadTokens = entry.cacheReadInputTokens || 0;

  // No tokens = no cost
  if (inputTokens === 0 && outputTokens === 0 && cacheCreationTokens === 0 && cacheReadTokens === 0) {
    return undefined;
  }

  try {
    const openRouterId = getOpenRouterId(entry.modelName);
    const pricing = await getModelPricing(openRouterId);

    if (pricing) {
      const stats = {
        inputTokens,
        outputTokens,
        cacheCreationTokens,
        cacheReadTokens,
        totalTokens: inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens,
        totalInputWithCache: inputTokens + cacheCreationTokens + cacheReadTokens,
      };
      const cost = calculateCostWithCachePricing(entry.modelName, stats, pricing);
      return cost > 0 ? cost : undefined;
    }
  } catch (error) {
    logger.debug({ error: (error as Error).message, modelName: entry.modelName }, 'Failed to calculate cost for LLM log');
  }

  return undefined;
}

/**
 * Persists an LLM call log entry to the llm_logs table.
 */
export async function persistLlmLog(entry: LlmLogEntry): Promise<number | null> {
  if (!db) {
    logger.warn('Database not available, cannot persist LLM log');
    return null;
  }

  try {
    // Calculate cost if not provided and we have any token usage
    let costUsd = entry.costUsd;
    if (costUsd === undefined) {
      costUsd = await calculateCost(entry);
    }

    const [inserted] = await db('llm_logs').insert({
      execution_type: entry.executionType,
      model_name: entry.modelName,
      start_time: entry.startTime.toISOString(),
      end_time: entry.endTime.toISOString(),
      duration_ms: entry.durationMs,
      success: entry.success,
      input_tokens: entry.inputTokens ?? null,
      output_tokens: entry.outputTokens ?? null,
      estimated_input_tokens: entry.estimatedInputTokens ?? null,
      cache_creation_input_tokens: entry.cacheCreationInputTokens ?? null,
      cache_read_input_tokens: entry.cacheReadInputTokens ?? null,
      cost_usd: costUsd ?? null,
      error_message: entry.errorMessage ?? null,
      session_id: entry.sessionId ?? null,
      correlation_id: entry.correlationId ?? null,
      draft_id: entry.draftId ?? null,
      repository: entry.repository ?? null,
      agent_alias: entry.agentAlias ?? null,
      metadata: entry.metadata ? JSON.stringify(entry.metadata) : null,
      usage_metrics: entry.usageMetrics ? JSON.stringify(entry.usageMetrics) : null,
    }).returning('log_id');

    const logId = typeof inserted === 'object' ? (inserted as { log_id: number }).log_id : inserted;

    // Persist structured usage metric records if present
    if (logId && entry.usageMetricRecords && entry.usageMetricRecords.length > 0) {
      try {
        const rows = entry.usageMetricRecords.map(r => ({
          llm_log_id: logId,
          agent_name: r.agent,
          metric_key: r.metricKey,
          metric_value: r.metricValue,
        }));
        await db('usage_metric_records').insert(rows);
        logger.debug({ logId, recordCount: rows.length }, 'Usage metric records persisted');
      } catch (recordError) {
        const recErr = recordError as Error;
        logger.error({ error: recErr.message, logId }, 'Failed to persist usage metric records');
      }
    }

    logger.debug({
      logId,
      executionType: entry.executionType,
      modelName: entry.modelName,
      durationMs: entry.durationMs,
      success: entry.success,
      costUsd,
    }, 'LLM log persisted to database');

    return logId;
  } catch (error) {
    const err = error as Error;
    logger.error({
      error: err.message,
      stack: err.stack,
      executionType: entry.executionType,
      correlationId: entry.correlationId,
    }, 'Failed to persist LLM log to database');
    return null;
  }
}

/**
 * Helper to create an LlmLogEntry from agent analysis result.
 */
export function createLlmLogFromAnalysis(params: {
  executionType: ExecutionType;
  modelUsed: string;
  executionTimeMs: number;
  success: boolean;
  tokenUsage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  /** Calculated token count from prompt - more reliable than agent-reported for single-turn */
  estimatedInputTokens?: number;
  error?: string;
  sessionId?: string;
  correlationId?: string;
  draftId?: string;
  repository?: string;
  agentAlias?: string;
  metadata?: Record<string, unknown>;
  usageMetrics?: Record<string, unknown>;
  usageMetricRecords?: UsageMetricRecordEntry[];
}): LlmLogEntry {
  const now = new Date();
  const startTime = new Date(now.getTime() - params.executionTimeMs);

  return {
    executionType: params.executionType,
    modelName: params.modelUsed,
    startTime,
    endTime: now,
    durationMs: params.executionTimeMs,
    success: params.success,
    inputTokens: params.tokenUsage?.input_tokens,
    outputTokens: params.tokenUsage?.output_tokens,
    estimatedInputTokens: params.estimatedInputTokens,
    cacheCreationInputTokens: params.tokenUsage?.cache_creation_input_tokens,
    cacheReadInputTokens: params.tokenUsage?.cache_read_input_tokens,
    errorMessage: params.error,
    sessionId: params.sessionId,
    correlationId: params.correlationId,
    draftId: params.draftId,
    repository: params.repository,
    agentAlias: params.agentAlias,
    metadata: params.metadata,
    usageMetrics: params.usageMetrics,
    usageMetricRecords: params.usageMetricRecords,
  };
}
