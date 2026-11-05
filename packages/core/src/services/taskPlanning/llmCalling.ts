/**
 * LLM calling for plan generation.
 */

import { runLightweightLLMAnalysis } from '../../claude/claudeService.js';
import { PlanItem } from '../../claude/prompts/plannerPrompts.js';
import { parseLlmJson, JsonParseError } from '../../utils/jsonUtils.js';
import logger from '../../utils/logger.js';
import { estimateLlmDuration } from '../../utils/llmEstimation.js';
import {
  updateTraceForRun, validatePromptTokens, CLAUDE_CODE_OVERHEAD, PlanningFailedError, getModelHardLimit, getRawInputCharLimit
} from '../planning/index.js';
import { enforceGranularity } from './granularity.js';
import { runPlanFileAgent } from './planFileAgent.js';
import { extractWholeJsonArray, incompletePlanItems, PLAN_FILE, PLAN_ORIGINAL_FILE } from './planValidation.js';
import { resolvePlanGenerationMode, tryGeneratePlanWithFiles } from './planFileGeneration.js';
import type { Plan } from '../../claude/prompts/plannerPrompts.js';
import type { CallLLMOptions, CallLLMForPlanResult } from './types.js';

export async function callLLMForPlan(opts: CallLLMOptions): Promise<CallLLMForPlanResult> {
  const {
    draftId, runId, fullContext, worktreePath, githubToken, repository,
    correlationId, tokenLimit, model, repairModel, granularity,
  } = opts;
  const correlatedLogger = correlationId ? logger.withCorrelation(correlationId) : logger;
  if (!model) throw new PlanningFailedError('No model configured for plan generation. Select a Planning Model in Settings.');

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
  const traceData = {
    estimatedDuration: estimation.estimatedDurationMs,
    startedAt,
    isHistoricalEstimate: estimation.isHistoricalEstimate,
    sampleCount: estimation.sampleCount
  };
  await updateTraceForRun(draftId, 'llm', 'in_progress', { expectedRunId: runId, data: traceData });

  const issueRef = { number: 0, repoOwner: repository.split('/')[0] || 'unknown', repoName: repository.split('/')[1] || 'unknown' };
  // Build metadata for LLM log tracking
  const planGenerationMetadata = {
    granularity,
    contextLevel: opts.tokenLimit,
    tokenLimit: opts.tokenLimit,
    contextLength: fullContext.length,
  };
  // File mode: the agent writes and validates the plan in a workspace (see planFileGeneration.ts).
  const fileMode = resolvePlanGenerationMode() === 'file';
  const filePlan = await tryGeneratePlanWithFiles({
    draftId, fullContext, model, repository, githubToken, correlationId, metadata: planGenerationMetadata, routingSession: opts.routingSession,
  });
  if (filePlan) {
    const fileEnforceResult = enforceGranularity(filePlan, granularity, correlatedLogger);
    return { plan: fileEnforceResult.plan, enforcementMetadata: fileEnforceResult.metadata };
  }

  // Unavailable file execution may have exhausted every routing member. Response
  // fallback is a distinct call; preserve the supplied session in response mode.
  const responseRoutingSession = fileMode ? opts.routingSession?.fork() : opts.routingSession;
  const response = await runLightweightLLMAnalysis({ prompt: fullContext, model, correlationId: correlationId || 'plan-generation', worktreePath, githubToken, issueRef, taskId: draftId, executionType: 'plan-generation', metadata: planGenerationMetadata, routingSession: responseRoutingSession });

  // Check boundaries before parsing too: the generic parser may otherwise
  // accept an initial array and silently discard a trailing partial task.
  const planArray = extractWholeJsonArray(response);
  if (!planArray) {
    correlatedLogger.warn({
      responseLength: response.length, generationModel: model,
      responseStart: response.slice(0, 200),
    }, 'Plan response is not a whole JSON array; refusing to repair a fragment');
    throw new PlanningFailedError(
      `The model's response was incomplete (${response.length} characters, not a whole JSON plan), so nothing was saved. ` +
      'Regenerate the plan, or choose a lower granularity for a shorter plan.'
    );
  }

  let plan: Plan;
  try {
    plan = parseLlmJson<PlanItem[]>(planArray);
  } catch (error) {
    if (!(error instanceof JsonParseError)) throw error;

    correlatedLogger.warn({
      error: error.message, responseLength: response.length, generationModel: model, repairModel,
    }, 'Failed to parse LLM response, repairing plan.json with an agent');
    plan = await runPlanFileAgent({
      purpose: 'repair',
      prompt: buildPlanRepairPrompt(error.message),
      files: { [PLAN_FILE]: planArray, [PLAN_ORIGINAL_FILE]: planArray },
      original: planArray,
      model: repairModel,
      draftId,
      repository,
      githubToken,
      executionType: 'plan-generation',
      correlationId: correlationId ? `${correlationId}-repair` : undefined,
      metadata: { ...planGenerationMetadata, jsonRepair: true, sourceModel: model, sourceResponseLength: response.length },
      routingSession: opts.repairRoutingSession,
    });
    correlatedLogger.info({ generationModel: model, repairModel, taskCount: plan.length }, 'Repaired plan passed validation');
  }

  if (!Array.isArray(plan) || plan.length === 0) {
    throw new PlanningFailedError('Generated plan is empty. The prompt may be too vague.');
  }

  // Saving tasks without a title, body or implementation shows an empty plan.
  const incomplete = incompletePlanItems(plan);
  if (incomplete.length > 0) {
    correlatedLogger.warn({ incomplete, taskCount: plan.length, generationModel: model }, 'Generated plan has incomplete tasks');
    throw new PlanningFailedError(
      `The generated plan has incomplete tasks (${incomplete.join(', ')} lack a title, body or implementation), so it was not saved. Regenerate the plan.`
    );
  }

  // Enforce granularity constraints - merge tasks if needed for 'single' mode
  const enforceResult = enforceGranularity(plan, granularity, correlatedLogger);
  return { plan: enforceResult.plan, enforcementMetadata: enforceResult.metadata };
}

/** Task for the agent that repairs a plan whose JSON does not parse. */
export function buildPlanRepairPrompt(parseError: string): string {
  return `${PLAN_FILE} in this workspace holds an implementation plan that another model wrote as a JSON array of tasks, but it is not valid JSON (${parseError}).

Fix ${PLAN_FILE} so that \`node validate-plan.mjs\` exits with status 0.

- Fix JSON syntax only: escaping of quotes, backslashes and newlines inside strings, and missing or extra commas, brackets or braces.
- Keep every task and every field with its exact text. Never reword, summarize, shorten, reorder or add content: the validator compares ${PLAN_FILE} with ${PLAN_ORIGINAL_FILE} and rejects any content change.
- Do not modify ${PLAN_ORIGINAL_FILE} or validate-plan.mjs.
- Edit the broken spots in place instead of rewriting the whole file; it may be very large.

Run \`node validate-plan.mjs\` after each change and stop once it reports "valid": true.`;
}
