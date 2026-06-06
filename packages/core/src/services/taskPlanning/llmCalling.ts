/**
 * LLM calling for plan generation.
 */

import { runLightweightLLMAnalysis } from '../../claude/claudeService.js';
import { PlanItem } from '../../claude/prompts/plannerPrompts.js';
import { parseLlmJson, JsonParseError } from '../../utils/jsonUtils.js';
import logger from '../../utils/logger.js';
import { estimateLlmDuration } from '../../utils/llmEstimation.js';
import {
  updateTrace, validatePromptTokens, CLAUDE_CODE_OVERHEAD, PlanningFailedError, getModelHardLimit, getRawInputCharLimit
} from '../planning/index.js';
import { enforceGranularity } from './granularity.js';
import type { Plan } from '../../claude/prompts/plannerPrompts.js';
import type { CallLLMOptions, CallLLMForPlanResult } from './types.js';

/** Default model for plan generation (high capability) */
const DEFAULT_GENERATION_MODEL = 'opus';

export async function callLLMForPlan(opts: CallLLMOptions): Promise<CallLLMForPlanResult> {
  const { draftId, fullContext, worktreePath, githubToken, repository, correlationId, tokenLimit, model = DEFAULT_GENERATION_MODEL, granularity } = opts;
  const correlatedLogger = correlationId ? logger.withCorrelation(correlationId) : logger;

  // Use model's hard limit for validation (context level is a guideline, not a hard limit)
  const modelHardLimit = getModelHardLimit(model);
  correlatedLogger.info({ model, tokenLimit, modelHardLimit, contextLength: fullContext.length }, 'Calling LLM for plan generation');

  const rawInputCharLimit = getRawInputCharLimit(model);
  if (rawInputCharLimit !== null && fullContext.length > rawInputCharLimit) {
    throw new PlanningFailedError(
      `Prompt exceeds agent input size: ${fullContext.length} characters (limit: ${rawInputCharLimit}). ` +
      `Regenerate the plan with less context or remove large attachments.`
    );
  }

  // Validate token count before sending to LLM (use model's hard limit, not user's context level)
  const validation = await validatePromptTokens(fullContext, modelHardLimit, correlatedLogger, model);

  if (!validation.valid) {
    throw new PlanningFailedError(
      `Prompt exceeds model context window: ${validation.tokenCount} tokens (model limit: ${modelHardLimit - CLAUDE_CODE_OVERHEAD}). ` +
      `This shouldn't happen - please report this bug.`
    );
  }

  correlatedLogger.info({ tokenCount: validation.tokenCount, source: validation.source, modelHardLimit }, 'Token validation passed');

  // Estimate LLM execution duration based on historical data
  correlatedLogger.info({
    estimationInput: {
      executionType: 'plan-generation',
      modelName: model,
      inputTokenCount: validation.tokenCount,
      contextCharLength: fullContext.length
    }
  }, 'Calling estimateLlmDuration with parameters');

  const estimation = await estimateLlmDuration({
    executionType: 'plan-generation',
    modelName: model,
    inputTokenCount: validation.tokenCount,
    correlationId
  });

  const startedAt = new Date().toISOString();

  correlatedLogger.info({
    estimationResult: {
      estimatedDurationMs: estimation.estimatedDurationMs,
      estimatedDurationFormatted: `${Math.floor(estimation.estimatedDurationMs / 60000)}m ${Math.floor((estimation.estimatedDurationMs % 60000) / 1000)}s`,
      isHistoricalEstimate: estimation.isHistoricalEstimate,
      sampleCount: estimation.sampleCount,
      avgMsPerToken: estimation.avgMsPerToken
    },
    inputTokenCount: validation.tokenCount,
    startedAt
  }, 'LLM duration estimation completed');

  // Update trace with in_progress status, estimated duration, and start time
  await updateTrace(draftId, 'llm', 'in_progress', {
    estimatedDuration: estimation.estimatedDurationMs,
    startedAt,
    isHistoricalEstimate: estimation.isHistoricalEstimate,
    sampleCount: estimation.sampleCount
  });

  const issueRef = { number: 0, repoOwner: repository.split('/')[0] || 'unknown', repoName: repository.split('/')[1] || 'unknown' };
  // Build metadata for LLM log tracking
  const planGenerationMetadata = {
    granularity,
    contextLevel: opts.tokenLimit,
    tokenLimit: opts.tokenLimit,
    contextLength: fullContext.length,
  };
  const response = await runLightweightLLMAnalysis({ prompt: fullContext, model, correlationId: correlationId || 'plan-generation', worktreePath, githubToken, issueRef, taskId: draftId, executionType: 'plan-generation', metadata: planGenerationMetadata });

  let plan: Plan;
  try {
    plan = parseLlmJson<PlanItem[]>(response);
  } catch (error) {
    if (error instanceof JsonParseError) {
      correlatedLogger.warn({ error: error.message, responseLength: response.length }, 'Failed to parse LLM response, attempting repair');

      // Try to repair the JSON by asking the same LLM to fix it
      const repairPrompt = `The following JSON array is malformed and cannot be parsed.
Error: ${error.message}

Please fix the JSON syntax errors and return ONLY the corrected JSON array.
Do not include any explanation, markdown formatting, or code fences.
Ensure all strings are properly escaped (especially quotes and newlines within string values).

Broken JSON:
${response}`;

      try {
        const repairedResponse = await runLightweightLLMAnalysis({
          prompt: repairPrompt,
          model,
          correlationId: correlationId ? `${correlationId}-repair` : 'plan-generation-repair',
          worktreePath,
          githubToken,
          issueRef,
          taskId: draftId,
          executionType: 'plan-generation'
        });

        plan = parseLlmJson<PlanItem[]>(repairedResponse);
        correlatedLogger.info({ originalError: error.message }, 'Successfully repaired JSON response');
      } catch (repairError) {
        correlatedLogger.error({
          originalError: error.message,
          repairError: repairError instanceof Error ? repairError.message : 'Unknown error',
          response: response.substring(0, 500)
        }, 'Failed to repair LLM response');
        throw new PlanningFailedError(`Failed to parse plan: ${error.message}`);
      }
    } else {
      throw error;
    }
  }

  if (!Array.isArray(plan) || plan.length === 0) {
    throw new PlanningFailedError('Generated plan is empty. The prompt may be too vague.');
  }

  // Enforce granularity constraints - merge tasks if needed for 'single' mode
  const enforceResult = enforceGranularity(plan, granularity, correlatedLogger);
  return { plan: enforceResult.plan, enforcementMetadata: enforceResult.metadata };
}
