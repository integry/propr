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
import { PlanningFailedError, getRawInputCharLimit, type MinimalLogger } from '../planning/index.js';
import type { RefinePlanOptions, RefinePlanResult, RefinePlanEstimation } from './types.js';

/** Default model for plan generation (high capability) */
const DEFAULT_GENERATION_MODEL = 'opus';

const TRUNCATION_MARKER = '\n\n…[truncated to fit the model input limit]…\n\n';

/**
 * Assemble the refinement prompt so it stays within the model's raw input
 * character limit (returned by getRawInputCharLimit — non-null only for
 * char-capped models like Codex/GPT; null for token-limited models such as
 * Claude, where no trimming is applied here).
 *
 * When the full prompt would exceed the limit, the least-essential content is
 * dropped first so the refinement still runs instead of the agent hard-failing
 * with input_too_large: original codebase context, then oversized per-task
 * `implementation` bodies, then the instruction (keeping its head and tail).
 * If even the trimmed prompt cannot fit, a PlanningFailedError is thrown with an
 * actionable message rather than forwarding an oversized prompt to the agent.
 */
export function assembleRefinementPrompt(params: {
  systemPrompt: string;
  originalContext?: string;
  currentPlan: PlanItem[];
  instruction: string;
  charLimit: number | null;
}): { prompt: string; truncated: string[] } {
  const { systemPrompt, originalContext, currentPlan, instruction, charLimit } = params;
  const truncated: string[] = [];

  const contextSection = (ctx: string) =>
    ctx ? `\n\nOriginal Context (codebase details from initial plan generation):\n${ctx}\n` : '';
  const build = (ctx: string, plan: PlanItem[], instr: string) =>
    `${systemPrompt}${contextSection(ctx)}\n\nCurrent Plan:\n${JSON.stringify(plan, null, 2)}\n\nUser Request:\n"${instr}"`;

  let context = originalContext || '';
  let plan = currentPlan;
  let instr = instruction;

  let prompt = build(context, plan, instr);
  if (charLimit == null || prompt.length <= charLimit) return { prompt, truncated };

  // 1. Drop original context — the refiner still has the full plan + instruction.
  if (context) {
    context = '';
    truncated.push('originalContext');
    prompt = build(context, plan, instr);
    if (prompt.length <= charLimit) return { prompt, truncated };
  }

  // 2. Truncate large per-task `implementation` bodies (the bulk of a big plan,
  //    and least needed to interpret a refinement instruction). Shrink the cap
  //    progressively until it fits.
  const capImplementations = (cap: number) => currentPlan.map((item) => {
    const impl = (item as { implementation?: unknown }).implementation;
    if (typeof impl === 'string' && impl.length > cap) {
      return { ...item, implementation: impl.slice(0, cap) + TRUNCATION_MARKER };
    }
    return item;
  });
  for (const cap of [20000, 8000, 2000, 500]) {
    const capped = capImplementations(cap);
    // capImplementations returns the same item reference when nothing is cut,
    // so only record the truncation when a body was actually shortened.
    const changed = capped.some((item, i) => item !== currentPlan[i]);
    plan = capped;
    if (changed && !truncated.includes('implementation')) truncated.push('implementation');
    prompt = build(context, plan, instr);
    if (prompt.length <= charLimit) return { prompt, truncated };
  }

  // 3. Truncate the instruction, keeping head and tail (the real ask usually
  //    bookends any pasted material like changelogs or logs).
  const fixedLen = build(context, plan, '').length;
  const instrBudget = charLimit - fixedLen - TRUNCATION_MARKER.length;
  if (instrBudget > 0 && instr.length > instrBudget) {
    const head = Math.floor(instrBudget * 0.6);
    const tail = instrBudget - head;
    instr = instr.slice(0, head) + TRUNCATION_MARKER + instr.slice(instr.length - tail);
    truncated.push('instruction');
    prompt = build(context, plan, instr);
    if (prompt.length <= charLimit) return { prompt, truncated };
  }

  // 4. Still too large — fail clearly instead of forwarding an oversized prompt.
  throw new PlanningFailedError(
    `This plan and instruction are too large to refine with the selected model (needs ${prompt.length.toLocaleString()} characters, limit ${charLimit.toLocaleString()}). Try a shorter instruction, remove pasted content, or split the plan into smaller tasks — or refine with a model that has a larger input limit.`
  );
}

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

  // Refine with the model the plan was generated with (passed by the caller
  // from the draft) so refinement matches the original plan; fall back to the
  // planner generation setting, then the default.
  const settings = await loadSettings();
  const generationModel = options.generationModel || settings.planner_generation_model || DEFAULT_GENERATION_MODEL;
  correlatedLogger.info({ instruction, taskCount: currentPlan.length, repository, generationModel, hasOriginalContext: !!originalContext, draftId }, 'Refining plan');

  // Assemble within the model's raw input character limit so oversized plans /
  // instructions get trimmed instead of hard-failing with input_too_large.
  const charLimit = getRawInputCharLimit(generationModel);
  const { prompt: userPrompt, truncated } = assembleRefinementPrompt({
    systemPrompt: REFINER_SYSTEM_PROMPT,
    originalContext,
    currentPlan,
    instruction,
    charLimit
  });
  if (truncated.length > 0) {
    correlatedLogger.warn({ generationModel, charLimit, truncated, promptLength: userPrompt.length }, 'Refinement prompt trimmed to fit the model input limit');
  }
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
    model: generationModel,
    estimation: {
      estimatedDurationMs: estimation.estimatedDurationMs,
      startedAt,
      isHistoricalEstimate: estimation.isHistoricalEstimate,
      sampleCount: estimation.sampleCount
    }
  };
}
