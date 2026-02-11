/**
 * LLM Estimation Utility - Estimates LLM execution time based on historical data.
 * Uses llm_logs table to calculate average speed (ms/token) for similar executions.
 */

import { db } from '../db/connection.js';
import logger from './logger.js';
import type { ExecutionType } from './llmMetrics.types.js';

/** Default estimated duration in milliseconds when no historical data is available */
const DEFAULT_ESTIMATED_DURATION_MS = 90000; // 90 seconds - realistic for plan generation

/** Maximum estimated duration to prevent unreasonably long estimates */
const MAX_ESTIMATED_DURATION_MS = 300000; // 5 minutes

/** Number of recent logs to consider for estimation */
const HISTORY_SAMPLE_SIZE = 20;

/**
 * Default ms per token when no historical data exists.
 * Based on typical Claude API performance with network overhead:
 * - Claude processes ~50-100 output tokens/second
 * - But we measure total request time including prompt processing
 * - A conservative estimate of ~8ms per input token accounts for
 *   prompt processing, network latency, and response generation
 */
const DEFAULT_MS_PER_TOKEN = 8;

/**
 * Execution-type-specific minimum durations.
 * Different operations have different baseline overhead costs.
 */
const MIN_DURATION_BY_TYPE: Record<string, number> = {
  'plan-generation': 30000,    // 30 seconds minimum - complex task with large prompts
  'plan-refinement': 15000,    // 15 seconds minimum - simpler than full generation
  'default': 10000             // 10 seconds fallback for unknown types
};

/** Get minimum duration for a specific execution type */
function getMinDuration(executionType: string): number {
  return MIN_DURATION_BY_TYPE[executionType] ?? MIN_DURATION_BY_TYPE['default'];
}

export interface EstimationResult {
  /** Estimated duration in milliseconds */
  estimatedDurationMs: number;
  /** Whether the estimate is based on historical data or defaults */
  isHistoricalEstimate: boolean;
  /** Number of historical samples used (0 if using defaults) */
  sampleCount: number;
  /** Average ms per token from historical data (if available) */
  avgMsPerToken?: number;
}

export interface EstimationOptions {
  /** The type of LLM execution (e.g., 'plan-generation', 'plan-refinement') */
  executionType: ExecutionType;
  /** The model being used (e.g., 'opus', 'claude:claude-opus-4-5-20251101') */
  modelName: string;
  /** Estimated input token count for this execution */
  inputTokenCount: number;
  /** Optional correlation ID for logging */
  correlationId?: string;
}

/**
 * Normalize model name for comparison.
 * Handles both short aliases (e.g., 'opus') and full model IDs.
 */
function normalizeModelName(modelName: string): string {
  // Extract the base model name for comparison
  // e.g., 'claude:claude-opus-4-5-20251101' -> 'opus'
  // e.g., 'opus' -> 'opus'
  const lowerName = modelName.toLowerCase();

  if (lowerName.includes('opus')) return 'opus';
  if (lowerName.includes('sonnet')) return 'sonnet';
  if (lowerName.includes('haiku')) return 'haiku';

  return lowerName;
}

/**
 * Estimate LLM execution duration based on historical data.
 *
 * Queries the llm_logs table for recent successful executions of the same type
 * and model to calculate an average speed (ms/token), then applies that to
 * the expected input token count.
 *
 * @param options - Estimation options including execution type, model, and token count
 * @returns Estimation result with duration and metadata
 */
export async function estimateLlmDuration(options: EstimationOptions): Promise<EstimationResult> {
  const { executionType, modelName, inputTokenCount, correlationId } = options;
  const correlatedLogger = correlationId ? logger.withCorrelation(correlationId) : logger;
  const normalizedModel = normalizeModelName(modelName);

  // Return defaults if no database connection
  if (!db) {
    correlatedLogger.warn('Database not available for LLM estimation, using defaults');
    return {
      estimatedDurationMs: DEFAULT_ESTIMATED_DURATION_MS,
      isHistoricalEstimate: false,
      sampleCount: 0
    };
  }

  try {
    // Query recent successful executions for the same type
    // Use LIKE for model name to match both aliases and full model IDs
    const recentLogs = await db('llm_logs')
      .select('duration_ms', 'input_tokens')
      .where('execution_type', executionType)
      .where('success', true)
      .whereNotNull('duration_ms')
      .whereNotNull('input_tokens')
      .where('input_tokens', '>', 0)
      .where(function() {
        this.where('model_name', 'like', `%${normalizedModel}%`)
          .orWhere('model_name', modelName);
      })
      .orderBy('start_time', 'desc')
      .limit(HISTORY_SAMPLE_SIZE);

    if (recentLogs.length === 0) {
      const minDuration = getMinDuration(executionType);
      const tokenBasedEstimate = inputTokenCount * DEFAULT_MS_PER_TOKEN;
      correlatedLogger.info(
        { executionType, modelName: normalizedModel, inputTokenCount, tokenBasedEstimate, minDuration },
        'No historical data for LLM estimation, using defaults'
      );
      return {
        estimatedDurationMs: Math.min(
          Math.max(tokenBasedEstimate, minDuration),
          MAX_ESTIMATED_DURATION_MS
        ),
        isHistoricalEstimate: false,
        sampleCount: 0,
        avgMsPerToken: DEFAULT_MS_PER_TOKEN
      };
    }

    // Calculate average ms per token from historical data
    let totalMsPerToken = 0;
    let validSamples = 0;

    for (const log of recentLogs) {
      const durationMs = log.duration_ms as number;
      const tokens = log.input_tokens as number;

      if (durationMs > 0 && tokens > 0) {
        totalMsPerToken += durationMs / tokens;
        validSamples++;
      }
    }

    if (validSamples === 0) {
      correlatedLogger.info(
        { executionType, modelName: normalizedModel },
        'No valid samples for LLM estimation, using defaults'
      );
      return {
        estimatedDurationMs: DEFAULT_ESTIMATED_DURATION_MS,
        isHistoricalEstimate: false,
        sampleCount: 0
      };
    }

    const avgMsPerToken = totalMsPerToken / validSamples;
    const estimatedDurationMs = Math.round(avgMsPerToken * inputTokenCount);

    // Clamp to reasonable bounds (using execution-type-specific minimum)
    const minDuration = getMinDuration(executionType);
    const clampedDuration = Math.min(
      Math.max(estimatedDurationMs, minDuration),
      MAX_ESTIMATED_DURATION_MS
    );

    correlatedLogger.info(
      {
        executionType,
        modelName: normalizedModel,
        inputTokenCount,
        avgMsPerToken: avgMsPerToken.toFixed(3),
        estimatedDurationMs: clampedDuration,
        sampleCount: validSamples
      },
      'Estimated LLM duration from historical data'
    );

    return {
      estimatedDurationMs: clampedDuration,
      isHistoricalEstimate: true,
      sampleCount: validSamples,
      avgMsPerToken
    };
  } catch (error) {
    const err = error as Error;
    correlatedLogger.error(
      { error: err.message, executionType, modelName },
      'Failed to query historical data for LLM estimation'
    );

    return {
      estimatedDurationMs: DEFAULT_ESTIMATED_DURATION_MS,
      isHistoricalEstimate: false,
      sampleCount: 0
    };
  }
}

/**
 * Format duration for display (e.g., "1m 30s").
 * Exported for use in frontend utilities.
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;

  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes === 0) return `${seconds}s`;
  if (seconds === 0) return `${minutes}m`;
  return `${minutes}m ${seconds}s`;
}
