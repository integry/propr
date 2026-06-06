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
 * These are floor values for sanity checking, set low to avoid
 * overriding accurate historical estimates.
 */
const MIN_DURATION_BY_TYPE: Record<string, number> = {
  'plan-generation': 5000,     // 5 seconds minimum
  'plan-refinement': 5000,     // 5 seconds minimum
  'context-analysis': 15000,   // 15 seconds minimum - relevance analysis typically takes longer
  'repo-chat': 3000,           // 3 seconds minimum - chat responses can be quick
  'repo-improvements': 5000,   // 5 seconds minimum - improvement suggestions take a bit longer
  'default': 3000              // 3 seconds fallback for unknown types
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
 * Strip agent prefix from model name if present.
 * Model names should be used as-is for matching, but agent prefixes should be ignored.
 * e.g., 'claude:claude-opus-4-5-20251101' -> 'claude-opus-4-5-20251101'
 * e.g., 'antigravity:antigravity-gemini-3-pro-preview' -> 'antigravity-gemini-3-pro-preview'
 * e.g., 'opus' -> 'opus' (no change for aliases)
 */
function stripAgentPrefix(modelName: string): string {
  // Handle agent:model format by extracting the model part
  if (modelName.includes(':')) {
    const parts = modelName.split(':');
    return parts.slice(1).join(':'); // Handle model IDs that might contain colons
  }
  return modelName;
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
  // Strip agent prefix but keep the exact model name for matching
  const cleanModelName = stripAgentPrefix(modelName);

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
    // Log query parameters for debugging
    correlatedLogger.info(
      {
        queryParams: {
          executionType,
          originalModelName: modelName,
          cleanModelName,
          inputTokenCount,
          historySampleSize: HISTORY_SAMPLE_SIZE
        }
      },
      'Querying llm_logs for historical estimation data'
    );

    // Query recent successful executions for the same type
    // Match model names: exact match OR model names containing the provided name
    // This handles both cases:
    // - Full model IDs (e.g., 'claude-opus-4-5-20251101')
    // - Aliases passed that need to match stored full IDs (e.g., 'opus' matches 'claude-opus-4-5-20251101')
    //
    // We prefer estimated_input_tokens (calculated from prompt, reliable for single-turn)
    // over input_tokens (agent-reported, may be cumulative for multi-turn agents)
    const recentLogs = await db('llm_logs')
      .select('duration_ms', 'input_tokens', 'estimated_input_tokens')
      .where('execution_type', executionType)
      .where('success', true)
      .whereNotNull('duration_ms')
      .where(function() {
        // Require at least one of the token fields to be valid
        this.where(function() {
          this.whereNotNull('estimated_input_tokens').where('estimated_input_tokens', '>', 0);
        }).orWhere(function() {
          this.whereNotNull('input_tokens').where('input_tokens', '>', 0);
        });
      })
      .where(function() {
        this.where('model_name', cleanModelName)
          .orWhere('model_name', 'like', `%${cleanModelName}%`);
      })
      .orderBy('start_time', 'desc')
      .limit(HISTORY_SAMPLE_SIZE);

    // Log the raw query results for debugging
    correlatedLogger.info(
      {
        executionType,
        modelName: cleanModelName,
        queryResultCount: recentLogs.length,
        rawResults: recentLogs.slice(0, 5).map(log => ({
          duration_ms: log.duration_ms,
          input_tokens: log.input_tokens,
          estimated_input_tokens: log.estimated_input_tokens
        }))
      },
      'Historical LLM logs query results'
    );

    if (recentLogs.length === 0) {
      const minDuration = getMinDuration(executionType);
      const tokenBasedEstimate = inputTokenCount * DEFAULT_MS_PER_TOKEN;
      correlatedLogger.info(
        { executionType, modelName: cleanModelName, inputTokenCount, tokenBasedEstimate, minDuration },
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
    // Prefer estimated_input_tokens (calculated from prompt) over input_tokens (agent-reported)
    // because agent-reported tokens can be cumulative across internal retries/turns
    let totalMsPerToken = 0;
    let validSamples = 0;
    const sampleDetails: Array<{ inputTokens: number; durationMs: number; msPerToken: number; source: string }> = [];

    for (const log of recentLogs) {
      const durationMs = log.duration_ms as number;
      // Prefer estimated_input_tokens, fall back to input_tokens for older records
      const estimatedTokens = log.estimated_input_tokens as number | null;
      const reportedTokens = log.input_tokens as number | null;
      const tokens = (estimatedTokens && estimatedTokens > 0) ? estimatedTokens : reportedTokens;
      const tokenSource = (estimatedTokens && estimatedTokens > 0) ? 'estimated' : 'reported';

      if (durationMs > 0 && tokens && tokens > 0) {
        const msPerToken = durationMs / tokens;
        totalMsPerToken += msPerToken;
        validSamples++;
        sampleDetails.push({ inputTokens: tokens, durationMs, msPerToken, source: tokenSource });
      }
    }

    if (validSamples === 0) {
      correlatedLogger.info(
        { executionType, modelName: cleanModelName },
        'No valid samples for LLM estimation, using defaults'
      );
      return {
        estimatedDurationMs: DEFAULT_ESTIMATED_DURATION_MS,
        isHistoricalEstimate: false,
        sampleCount: 0
      };
    }

    const avgMsPerToken = totalMsPerToken / validSamples;
    const rawEstimatedDurationMs = avgMsPerToken * inputTokenCount;
    const estimatedDurationMs = Math.round(rawEstimatedDurationMs);

    // Clamp to reasonable bounds (using execution-type-specific minimum)
    const minDuration = getMinDuration(executionType);
    const clampedDuration = Math.min(
      Math.max(estimatedDurationMs, minDuration),
      MAX_ESTIMATED_DURATION_MS
    );

    // Log detailed calculation breakdown for debugging
    const estimatedCount = sampleDetails.filter(s => s.source === 'estimated').length;
    const reportedCount = sampleDetails.filter(s => s.source === 'reported').length;
    correlatedLogger.info(
      {
        executionType,
        modelName: cleanModelName,
        inputTokenCount,
        sampleCount: validSamples,
        tokenSources: { estimated: estimatedCount, reported: reportedCount },
        sampleDetails: sampleDetails.slice(0, 5).map(s => ({
          inputTokens: s.inputTokens,
          durationMs: s.durationMs,
          msPerToken: Number(s.msPerToken.toFixed(4)),
          source: s.source
        })),
        calculation: {
          avgMsPerToken: Number(avgMsPerToken.toFixed(4)),
          rawEstimatedMs: Math.round(rawEstimatedDurationMs),
          minDuration,
          maxDuration: MAX_ESTIMATED_DURATION_MS,
          finalEstimateMs: clampedDuration,
          wasClamped: clampedDuration !== estimatedDurationMs
        }
      },
      'LLM duration estimation calculation breakdown'
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
 * Heuristic usage-percent estimator.
 *
 * Estimates what fraction of a 5-hour session window a single plan-generation
 * task will consume based on its token count. The estimate is modelled on
 * Claude Max subscription limits observed via Agent Tank:
 *
 *   - A 5-hour session window allows roughly 4 000 000 tokens of mixed I/O.
 *   - Each plan-generation call uses `inputTokens` input and an estimated
 *     output equal to ~20 % of the input (capped at a reasonable ceiling).
 *
 * The returned value is a percentage (0–100). It intentionally rounds *up*
 * so the user never under-estimates cost.
 */

/** Approximate total token budget per 5-hour session window */
const SESSION_TOKEN_BUDGET = 4_000_000;

/** Assumed ratio of output tokens to input tokens for plan generation */
const OUTPUT_TO_INPUT_RATIO = 0.2;

export function estimateUsagePercent(inputTokens: number): number {
  if (inputTokens <= 0) return 0;
  const estimatedOutputTokens = Math.round(inputTokens * OUTPUT_TO_INPUT_RATIO);
  const totalTokens = inputTokens + estimatedOutputTokens;
  const percent = (totalTokens / SESSION_TOKEN_BUDGET) * 100;
  // Round up to one decimal, clamp to 0–100
  return Math.min(100, Math.round(percent * 10) / 10);
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
