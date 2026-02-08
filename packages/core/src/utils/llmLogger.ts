/**
 * LLM Logger - Persists LLM call logs to the llm_logs table.
 * This is separate from llmMetrics which handles task execution metrics.
 */

import { db } from '../db/connection.js';
import logger from './logger.js';
import { getOpenRouterId } from '../config/modelAliases.js';
import { getModelPricing } from '../services/pricingService.js';
import type { ExecutionType } from './llmMetrics.types.js';

export interface LlmLogEntry {
  executionType: ExecutionType;
  modelName: string;
  startTime: Date;
  endTime: Date;
  durationMs: number;
  success: boolean;
  inputTokens?: number;
  outputTokens?: number;
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
}

/**
 * Calculate cost based on model and token usage.
 */
async function calculateCost(modelName: string, inputTokens?: number, outputTokens?: number): Promise<number | undefined> {
  if (!inputTokens && !outputTokens) {
    return undefined;
  }

  try {
    const openRouterId = getOpenRouterId(modelName);
    const pricing = await getModelPricing(openRouterId);

    if (pricing) {
      const cost = ((inputTokens || 0) * pricing.prompt) + ((outputTokens || 0) * pricing.completion);
      return cost > 0 ? cost : undefined;
    }
  } catch (error) {
    logger.debug({ error: (error as Error).message, modelName }, 'Failed to calculate cost for LLM log');
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
    // Calculate cost if not provided and we have token usage
    let costUsd = entry.costUsd;
    if (costUsd === undefined && (entry.inputTokens || entry.outputTokens)) {
      costUsd = await calculateCost(entry.modelName, entry.inputTokens, entry.outputTokens);
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
    }).returning('log_id');

    const logId = typeof inserted === 'object' ? (inserted as { log_id: number }).log_id : inserted;

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
  error?: string;
  sessionId?: string;
  correlationId?: string;
  draftId?: string;
  repository?: string;
  agentAlias?: string;
  metadata?: Record<string, unknown>;
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
    cacheCreationInputTokens: params.tokenUsage?.cache_creation_input_tokens,
    cacheReadInputTokens: params.tokenUsage?.cache_read_input_tokens,
    errorMessage: params.error,
    sessionId: params.sessionId,
    correlationId: params.correlationId,
    draftId: params.draftId,
    repository: params.repository,
    agentAlias: params.agentAlias,
    metadata: params.metadata,
  };
}
