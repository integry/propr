/**
 * Plan refinement functionality.
 */

import { runLightweightLLMAnalysis } from '../../claude/claudeService.js';
import { REFINER_SYSTEM_PROMPT, PlanItem, RefinementResponse } from '../../claude/prompts/plannerPrompts.js';
import { parseLlmJson, extractLlmJsonText, JsonParseError } from '../../utils/jsonUtils.js';
import logger from '../../utils/logger.js';
import { estimateLlmDuration } from '../../utils/llmEstimation.js';
import { estimateTokens } from '../../utils/tokenCalculation.js';
import { loadSettings } from '../../config/configManager.js';
import { resolveConfiguredModel } from '../../config/configuredModel.js';
import { AgentRegistry } from '../../agents/AgentRegistry.js';
import { PlanningFailedError, getRawInputCharLimit, type MinimalLogger } from '../planning/index.js';
import { incompletePlanItems, PLAN_FILE, PLAN_ORIGINAL_FILE, unreadableDocumentOriginal } from './planValidation.js';
import { runPlanFileAgent } from './planFileAgent.js';
import {
  normalizeRefinedPlan,
  RefinementOutputError,
  type RefinementOutputDetails,
} from './refinementOutput.js';

export { incompletePlanItems };
import type { RefinePlanOptions, RefinePlanResult, RefinePlanEstimation } from './types.js';

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
 * Normalize a parsed LLM response into a RefinementResponse.
 * Wraps plain arrays and applies default values for missing fields.
 */
function toRefinementResponse(
  parsed: RefinementResponse | PlanItem[],
  correlatedLogger: MinimalLogger
): RefinementResponse {
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
    // Never `changes`: a list of edits is not a plan.
    const altKeys = ['tasks', 'items', 'issues'] as const;
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

/** Task for the agent that repairs a refinement response whose JSON does not parse. */
export function buildRefinementRepairPrompt(parseError: string): string {
  return `${PLAN_FILE} in this workspace holds a plan refinement response (a JSON object with "action", "summary" and a "plan" array of tasks) that another model wrote, but it is not valid JSON (${parseError}).

Fix ${PLAN_FILE} so that \`node validate-plan.mjs --document\` exits with status 0.

- Fix JSON syntax only: escaping of quotes, backslashes and newlines inside strings, and missing or extra commas, brackets or braces.
- Keep every field and value with its exact text. Never reword, summarize, shorten, reorder or add content: the validator compares ${PLAN_FILE} with ${PLAN_ORIGINAL_FILE} and rejects any content change.
- Do not modify ${PLAN_ORIGINAL_FILE} or validate-plan.mjs.
- Edit the broken spots in place instead of rewriting the whole file; it may be very large.

Run \`node validate-plan.mjs --document\` after each change and stop once it reports "valid": true.`;
}

/**
 * Task for the agent that salvages a refinement response the model started
 * over after being cut off: a partial first attempt followed by a restarted copy.
 */
export function buildRefinementSalvagePrompt(parseError: string, unreadable: string): string {
  return `${PLAN_FILE} in this workspace holds a plan refinement response (a JSON object with "action", "summary" and a "plan" array of tasks) that another model wrote, but it is not valid JSON (${parseError}) and cannot be read as one document (${unreadable}).

The model's answer was cut off part-way and the model then started the whole answer over, so the file holds an incomplete first attempt followed by a complete restarted copy, which may itself contain syntax errors.

Make ${PLAN_FILE} hold only the restarted copy, as valid JSON, so that \`node validate-plan.mjs --document --salvage\` exits with status 0.

- Delete the incomplete first attempt: everything before the point where the answer starts over (\`{\` followed by \`"action"\` again).
- In the restarted copy, fix JSON syntax only: escaping of quotes, backslashes and newlines inside strings, and missing or extra commas, brackets or braces.
- Keep every field, value and task of the restarted copy with its exact text. Never reword, summarize, shorten, reorder or add content: the validator compares the result with the restarted copy in ${PLAN_ORIGINAL_FILE} and rejects any content change.
- Do not modify ${PLAN_ORIGINAL_FILE} or validate-plan.mjs.
- The file may be very large: cut and edit it in place with your tools instead of retyping it.

Run \`node validate-plan.mjs --document --salvage\` after each change and stop once it reports "valid": true.`;
}

const isUsageLimitError = (error: unknown) => (error as Error)?.name === 'UsageLimitError';

interface RefinementRepairContext {
  draftId?: string;
  repository: string;
  githubToken: string;
  correlationId?: string;
  generationModel: string;
  correlatedLogger: MinimalLogger;
}

/**
 * Parses a refinement response. Malformed JSON is never re-requested from a
 * model: an agent repairs it in place in a file, and the validator proves the
 * repair changed syntax only.
 */
async function parseRefinementWithRepair(response: string, context: RefinementRepairContext): Promise<RefinementResponse> {
  const { correlatedLogger } = context;
  let parseError: JsonParseError;
  try {
    return toRefinementResponse(parseLlmJson<RefinementResponse | PlanItem[]>(response), correlatedLogger);
  } catch (error) {
    if (!(error instanceof JsonParseError)) throw error;
    parseError = error;
  }

  let original: string;
  try {
    original = extractLlmJsonText(response);
  } catch {
    // No JSON document at all: there is nothing to repair.
    throw new PlanningFailedError(`Failed to parse refined plan: ${parseError.message}`);
  }

  // An original the validator cannot read as one document is usually an answer
  // the model started over after being cut off: the agent salvages it, and the
  // validator then requires a syntax-only repair of the restarted copy.
  const unreadable = await unreadableDocumentOriginal(original);
  if (unreadable) {
    // Without a complete restarted copy the content is simply missing, and no
    // repair could pass validation.
    const unsalvageable = await unreadableDocumentOriginal(original, { salvage: true });
    if (unsalvageable) {
      correlatedLogger.error({ error: parseError.message, unreadable, unsalvageable, responseLength: response.length }, 'Refinement response cannot be repaired in place');
      throw new PlanningFailedError(`Failed to parse refined plan: ${parseError.message}. It cannot be repaired in place: ${unreadable}`);
    }
    correlatedLogger.warn({ error: parseError.message, unreadable, responseLength: response.length }, 'Refinement response restarts part-way; salvaging the restarted copy with an agent');
  }

  let repairModel: string | undefined;
  try {
    // JSON repair is handled by the configured default coding model, as for plan generation.
    repairModel = await resolveConfiguredModel();
    const separator = repairModel.indexOf(':');
    const repairRoute = AgentRegistry.getInstance().beginRoutingSession(separator < 0
      ? { requestedAgentAlias: repairModel }
      : { requestedAgentAlias: repairModel.slice(0, separator), requestedModel: repairModel.slice(separator + 1) });
    correlatedLogger.warn({
      error: parseError.message, responseLength: response.length, generationModel: context.generationModel, repairModel,
    }, 'Failed to parse refinement response, repairing it in place with an agent');
    const repaired = await runPlanFileAgent<RefinementResponse | PlanItem[]>({
      purpose: 'repair',
      document: true,
      salvage: !!unreadable,
      prompt: unreadable ? buildRefinementSalvagePrompt(parseError.message, unreadable) : buildRefinementRepairPrompt(parseError.message),
      files: { [PLAN_FILE]: original, [PLAN_ORIGINAL_FILE]: original },
      original,
      model: repairModel,
      draftId: context.draftId,
      repository: context.repository,
      githubToken: context.githubToken,
      executionType: 'plan-refinement',
      correlationId: context.correlationId ? `${context.correlationId}-repair` : undefined,
      metadata: { jsonRepair: true, jsonSalvage: !!unreadable, sourceModel: context.generationModel, sourceResponseLength: response.length },
      routingSession: repairRoute,
    });
    correlatedLogger.info({ originalError: parseError.message, repairModel, salvaged: !!unreadable }, 'Repaired refinement response passed validation');
    return toRefinementResponse(repaired, correlatedLogger);
  } catch (repairError) {
    if (isUsageLimitError(repairError)) throw repairError;
    correlatedLogger.error({
      originalError: parseError.message,
      repairError: repairError instanceof Error ? repairError.message : String(repairError),
      repairModel,
    }, 'Failed to repair refinement response');
    throw new PlanningFailedError(`Failed to parse refined plan, and the in-place repair failed: ${repairError instanceof Error ? repairError.message : String(repairError)}`);
  }
}

function incompletePlanRepairPrompt(currentPlan: PlanItem[], instruction: string, response: string, details: RefinementOutputDetails): string {
  return `Your previous response was not a safe complete refined plan (${details.reason}).

Apply the requested changes to the current plan below and return ONLY this JSON object:
{"action": "modified", "summary": "<what changed>", "plan": [ ... ]}

The plan array must contain EVERY issue of the refined plan in full, each as {"title", "body", "implementation"}, copying unchanged issues verbatim. Do not return edit instructions such as "retain", "extend" or "unchanged". No markdown or code fences.

Current plan:
${JSON.stringify(currentPlan)}

Requested change:
${instruction}

Your previous response:
${response}`;
}

/**
 * Asks once for the complete plan when a refinement returned edits or partial
 * issues. Saving those would replace the plan with stubs, so if the second
 * answer is still incomplete the refinement fails and the plan is kept.
 */
async function requestCompletePlan(
  details: RefinementOutputDetails,
  context: {
    currentPlan: PlanItem[];
    instruction: string;
    response: string;
    charLimit: number | null;
    correlatedLogger: MinimalLogger;
    llm: (prompt: string) => Promise<string>;
    parse: (response: string) => Promise<RefinementResponse>;
  },
): Promise<RefinementResponse | undefined> {
  const { currentPlan, instruction, response, charLimit, correlatedLogger } = context;
  correlatedLogger.warn({ details }, 'Refinement returned an invalid plan, asking for the full plan');
  const repairPrompt = incompletePlanRepairPrompt(currentPlan, instruction, response, details);
  if (charLimit === null || repairPrompt.length <= charLimit) {
    try {
      const repaired = validateRefinementResponse(await context.parse(await context.llm(repairPrompt)), correlatedLogger);
      return repaired.action === 'modified' ? repaired : { ...repaired, plan: currentPlan };
    } catch (repairError) {
      // Usage limits keep their identity for upstream requeueing.
      if (isUsageLimitError(repairError)) throw repairError;
      correlatedLogger.warn({ error: repairError instanceof Error ? repairError.message : String(repairError) }, 'Complete-plan repair failed');
    }
  }
  return undefined;
}

export async function refinePlan(options: RefinePlanOptions): Promise<RefinePlanResult & { estimation?: RefinePlanEstimation }> {
  const { currentPlan, instruction, worktreePath, repository, githubToken, correlationId, originalContext, draftId } = options;
  const correlatedLogger = correlationId ? logger.withCorrelation(correlationId) : logger;

  if (!Array.isArray(currentPlan)) throw new PlanningFailedError('Current plan must be an array');

  // Refine with the model the plan was generated with (passed by the caller
  // from the draft) so refinement matches the original plan; fall back to the
  // planner generation setting, then the configured default agent.
  const settings = await loadSettings();
  const requestedGenerationModel = await resolveConfiguredModel(options.generationModel || settings.planner_generation_model);
  const registry = AgentRegistry.getInstance();
  await registry.ensureInitialized();
  const separator = requestedGenerationModel.indexOf(':');
  const routingSession = registry.beginRoutingSession(separator < 0
    ? { requestedAgentAlias: requestedGenerationModel }
    : {
        requestedAgentAlias: requestedGenerationModel.slice(0, separator),
        requestedModel: requestedGenerationModel.slice(separator + 1),
      });
  const selection = await routingSession.select();
  const generationModel = `${selection.physicalAgentAlias}:${selection.physicalModel}`;
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
  const response = await runLightweightLLMAnalysis({ prompt: userPrompt, model: generationModel, correlationId: correlationId || 'plan-refinement', worktreePath, githubToken, issueRef, taskId: draftId, executionType: 'plan-refinement', metadata: refinementMetadata, routingSession });

  // Debug: log raw response (first 1000 chars) to diagnose parsing issues
  correlatedLogger.info({ responsePreview: response.substring(0, 1000), responseLength: response.length }, 'Raw LLM refinement response');

  const repairContext: RefinementRepairContext = { draftId, repository, githubToken, correlationId, generationModel, correlatedLogger };
  let refinementResponse = await parseRefinementWithRepair(response, repairContext);

  refinementResponse = validateRefinementResponse(refinementResponse, correlatedLogger);

  // Answers and clarifying questions never change the plan, whatever came back with them.
  if (refinementResponse.action !== 'modified') {
    refinementResponse.plan = currentPlan;
  }

  let normalized = refinementResponse.action === 'modified'
    ? normalizeRefinedPlan(currentPlan, refinementResponse.plan)
    : { ok: true as const, plan: currentPlan, merged: false, operations: undefined };
  if (!normalized.ok) {
    const repaired = await requestCompletePlan(normalized.details, {
      currentPlan, instruction, response, charLimit, correlatedLogger,
      parse: completeResponse => parseRefinementWithRepair(completeResponse, repairContext),
      llm: prompt => runLightweightLLMAnalysis({
        prompt,
        model: generationModel,
        correlationId: correlationId ? `${correlationId}-complete-plan` : 'plan-refinement-complete-plan',
        worktreePath,
        githubToken,
        issueRef,
        taskId: draftId,
        executionType: 'plan-refinement',
        routingSession: routingSession.fork(),
      }),
    });
    if (repaired) {
      refinementResponse = repaired;
      normalized = refinementResponse.action === 'modified'
        ? normalizeRefinedPlan(currentPlan, refinementResponse.plan)
        : { ok: true as const, plan: currentPlan, merged: false, operations: undefined };
    }
  }
  if (!normalized.ok) {
    throw new RefinementOutputError(normalized.message, normalized.details);
  }

  refinementResponse.plan = normalized.plan;
  if (normalized.merged) {
    const mergeSummary = `Applied ${normalized.operations} edits to the existing plan.`;
    refinementResponse.summary = refinementResponse.summary
      ? `${mergeSummary} ${refinementResponse.summary}`
      : mergeSummary;
  }

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
    merged: normalized.merged,
    operations: normalized.operations,
    estimation: {
      estimatedDurationMs: estimation.estimatedDurationMs,
      startedAt,
      isHistoricalEstimate: estimation.isHistoricalEstimate,
      sampleCount: estimation.sampleCount
    }
  };
}
