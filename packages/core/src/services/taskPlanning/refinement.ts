/**
 * Plan refinement functionality.
 */

import { runLightweightLLMAnalysis } from '../../claude/claudeService.js';
import { REFINER_SYSTEM_PROMPT, PlanItem, RefinementResponse } from '../../claude/prompts/plannerPrompts.js';
import { parseLlmJson, JsonParseError } from '../../utils/jsonUtils.js';
import logger from '../../utils/logger.js';
import { estimateLlmDuration } from '../../utils/llmEstimation.js';
import { estimateTokens } from '../../utils/tokenCalculation.js';
import { loadSettings } from '../../config/configManager.js';
import { PlanningFailedError, MinimalLogger } from '../planningHelpers.js';
import type { RefinePlanOptions, RefinePlanResult, RefinePlanEstimation } from './types.js';

/** Default model for plan generation (high capability) */
const DEFAULT_GENERATION_MODEL = 'opus';

/**
 * Parse LLM response into a RefinementResponse, handling various response formats.
 * Wraps plain arrays and applies default values for missing fields.
 */
function parseRefinementResponse(
  response: string,
  correlatedLogger: MinimalLogger
): RefinementResponse {
  const parsed = parseLlmJson<RefinementResponse | PlanItem[]>(response);

  // Check if LLM returned a plain array instead of structured response
  if (Array.isArray(parsed)) {
    correlatedLogger.warn('LLM returned plain array instead of structured response, wrapping');
    return {
      action: 'modified',
      summary: 'Plan updated based on your instruction.',
      plan: parsed
    };
  }

  correlatedLogger.info({
    parsedKeys: Object.keys(parsed),
    hasPlan: 'plan' in parsed,
    planIsArray: Array.isArray(parsed.plan)
  }, 'Parsed refinement response structure');

  return parsed;
}

/**
 * Validate and normalize a RefinementResponse, ensuring it has required fields.
 * Handles alternative keys that LLMs might use for the plan array.
 */
function validateRefinementResponse(
  refinementResponse: RefinementResponse,
  correlatedLogger: MinimalLogger
): RefinementResponse {
  // Handle alternative keys for plan array
  if (!refinementResponse.plan || !Array.isArray(refinementResponse.plan)) {
    const altKeys = ['tasks', 'items', 'issues', 'changes'] as const;
    const responseObj = refinementResponse as unknown as Record<string, unknown>;
    for (const key of altKeys) {
      if (Array.isArray(responseObj[key])) {
        correlatedLogger.warn({ foundKey: key }, 'LLM used alternative key for plan array, remapping');
        refinementResponse.plan = responseObj[key] as PlanItem[];
        break;
      }
    }
  }

  // Validate plan array exists
  if (!refinementResponse.plan || !Array.isArray(refinementResponse.plan)) {
    correlatedLogger.error({
      refinementResponse: JSON.stringify(refinementResponse).substring(0, 500)
    }, 'Invalid refinement response structure');
    throw new PlanningFailedError('Refined plan is not a valid array');
  }

  // Apply defaults for missing fields
  if (!refinementResponse.action || !['modified', 'answered', 'clarify'].includes(refinementResponse.action)) {
    refinementResponse.action = 'modified';
  }
  if (!refinementResponse.summary || typeof refinementResponse.summary !== 'string') {
    refinementResponse.summary = 'Plan processed.';
  }

  return refinementResponse;
}

export async function refinePlan(options: RefinePlanOptions): Promise<RefinePlanResult & { estimation?: RefinePlanEstimation }> {
  const { currentPlan, instruction, worktreePath, repository, githubToken, correlationId, originalContext, draftId } = options;
  const correlatedLogger = correlationId ? logger.withCorrelation(correlationId) : logger;

  if (!Array.isArray(currentPlan)) throw new PlanningFailedError('Current plan must be an array');

  // Load planner generation model from settings (refinement uses the generation model)
  const settings = await loadSettings();
  const generationModel = settings.planner_generation_model || DEFAULT_GENERATION_MODEL;
  correlatedLogger.info({ instruction, taskCount: currentPlan.length, repository, generationModel, hasOriginalContext: !!originalContext, draftId }, 'Refining plan');

  const contextSection = originalContext
    ? `\n\nOriginal Context (codebase details from initial plan generation):\n${originalContext}\n`
    : '';
  const userPrompt = `${REFINER_SYSTEM_PROMPT}${contextSection}\n\nCurrent Plan:\n${JSON.stringify(currentPlan, null, 2)}\n\nUser Request:\n"${instruction}"`;
  const [repoOwner, repoName] = repository.split('/');
  const issueRef = { number: 0, repoOwner: repoOwner || 'unknown', repoName: repoName || 'unknown' };

  // Estimate input token count using tiktoken (more accurate than rough char/4 estimate)
  const estimatedInputTokens = estimateTokens(userPrompt);

  // Estimate LLM execution duration based on historical data
  const estimation = await estimateLlmDuration({
    executionType: 'plan-refinement',
    modelName: generationModel,
    inputTokenCount: estimatedInputTokens,
    correlationId
  });

  const startedAt = new Date().toISOString();
  correlatedLogger.info({
    estimatedDurationMs: estimation.estimatedDurationMs,
    isHistoricalEstimate: estimation.isHistoricalEstimate,
    sampleCount: estimation.sampleCount,
    estimatedInputTokens
  }, 'Estimated refinement duration');

  // Build metadata for LLM log tracking
  const refinementMetadata = {
    instructionLength: instruction.length,
    instructionSnippet: instruction.length > 100 ? instruction.substring(0, 100) + '...' : instruction,
    currentTaskCount: currentPlan.length,
    hasOriginalContext: !!originalContext,
  };
  const response = await runLightweightLLMAnalysis({ prompt: userPrompt, model: generationModel, correlationId: correlationId || 'plan-refinement', worktreePath, githubToken, issueRef, taskId: draftId, executionType: 'plan-refinement', metadata: refinementMetadata });

  // Debug: log raw response (first 1000 chars) to diagnose parsing issues
  correlatedLogger.info({ responsePreview: response.substring(0, 1000), responseLength: response.length }, 'Raw LLM refinement response');

  let refinementResponse: RefinementResponse;
  try {
    refinementResponse = parseRefinementResponse(response, correlatedLogger);
  } catch (error) {
    if (error instanceof JsonParseError) {
      correlatedLogger.warn({ error: error.message, responseLength: response.length }, 'Failed to parse refinement response, attempting repair');

      // Try to repair the JSON by asking the same LLM to fix it
      const repairPrompt = `The following JSON is malformed and cannot be parsed.
Error: ${error.message}

Please fix the JSON syntax errors and return ONLY the corrected JSON.
Do not include any explanation, markdown formatting, or code fences.
Ensure all strings are properly escaped (especially quotes and newlines within string values).

Broken JSON:
${response}`;

      try {
        const repairedResponse = await runLightweightLLMAnalysis({
          prompt: repairPrompt,
          model: generationModel,
          correlationId: correlationId ? `${correlationId}-repair` : 'plan-refinement-repair',
          worktreePath,
          githubToken,
          issueRef,
          taskId: draftId,
          executionType: 'plan-refinement'
        });

        refinementResponse = parseRefinementResponse(repairedResponse, correlatedLogger);
        correlatedLogger.info({ originalError: error.message }, 'Successfully repaired refinement JSON response');
      } catch (repairError) {
        correlatedLogger.error({
          originalError: error.message,
          repairError: repairError instanceof Error ? repairError.message : 'Unknown error',
          responsePreview: response.substring(0, 500)
        }, 'Failed to repair refinement response');
        throw new PlanningFailedError(`Failed to parse refined plan: ${error.message}`);
      }
    } else {
      throw error;
    }
  }

  refinementResponse = validateRefinementResponse(refinementResponse, correlatedLogger);

  correlatedLogger.info({
    taskCount: refinementResponse.plan.length,
    action: refinementResponse.action,
    summaryLength: refinementResponse.summary.length
  }, 'Plan refinement completed');

  return {
    plan: refinementResponse.plan,
    action: refinementResponse.action,
    summary: refinementResponse.summary,
    estimation: {
      estimatedDurationMs: estimation.estimatedDurationMs,
      startedAt,
      isHistoricalEstimate: estimation.isHistoricalEstimate,
      sampleCount: estimation.sampleCount
    }
  };
}
