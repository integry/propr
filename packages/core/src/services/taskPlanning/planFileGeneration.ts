/**
 * File-based plan generation: the planning agent writes each task to its own
 * file in a scratch workspace and runs the plan validator until it passes.
 *
 * The plan then no longer depends on the agent's final chat message, which is
 * cut at the provider's per-message output limit for very large plans, and a
 * syntax mistake is fixed by the agent in place instead of by a separate
 * repair model re-emitting the whole plan.
 */

import type { Plan } from '../../claude/prompts/plannerPrompts.js';
import logger from '../../utils/logger.js';
import type { SyntheticRoutingSession } from '../syntheticRoutingService.js';
import { PlanFileAgentUnavailableError, runPlanFileAgent } from './planFileAgent.js';
import { PLAN_TASKS_DIR, PLAN_VALIDATOR_FILE } from './planValidation.js';

export type PlanGenerationMode = 'file' | 'response';

/**
 * `PROPR_PLAN_GENERATION_MODE=response` restores the previous behaviour, where
 * the plan is parsed from the model's reply. Anything else selects files.
 */
export function resolvePlanGenerationMode(env: NodeJS.ProcessEnv = process.env): PlanGenerationMode {
  return env.PROPR_PLAN_GENERATION_MODE?.trim().toLowerCase() === 'response' ? 'response' : 'file';
}

/** The planner prompt plus the file contract, which replaces its reply format. */
export function buildPlanFilePrompt(fullContext: string): string {
  return `${fullContext}

---
## How to deliver the plan (this replaces the output format above)

Do not put the plan in your reply. Write it to files in the current directory:

1. Write each task as its own file in plan order: \`${PLAN_TASKS_DIR}/001.json\`, \`${PLAN_TASKS_DIR}/002.json\`, and so on. Each file holds ONE JSON object with the string fields "title", "body" and "implementation", written exactly as the instructions above describe. Write one task per tool call; never put the whole plan into a single file or message.
2. Run \`node ${PLAN_VALIDATOR_FILE} --tasks ${PLAN_TASKS_DIR}\`. It assembles the task files into plan.json and prints a JSON report.
3. If the report lists errors, fix the files it names and run it again. Repeat until it exits with status 0 and reports "valid": true.
4. Do not edit ${PLAN_VALIDATOR_FILE} and do not write any other files. The workspace holds only these files; everything you need from the repository is in this prompt.
5. When the validator passes, reply with one short line, for example "Plan written: 4 tasks."`;
}

export interface FilePlanGenerationOptions {
  draftId: string;
  fullContext: string;
  model: string;
  repository: string;
  githubToken: string;
  correlationId?: string;
  metadata?: Record<string, unknown>;
  routingSession?: SyntheticRoutingSession;
}

/**
 * Generates the plan through files when that mode is selected. Returns null
 * when the response mode should be used instead: either it is selected, or
 * the agent workspace could not be set up or run at all. A plan that the
 * agent wrote but that fails validation is an error, not a fallback: running
 * the whole generation again as a reply would double its cost and would hit
 * the same model limits.
 */
export async function tryGeneratePlanWithFiles(options: FilePlanGenerationOptions): Promise<Plan | null> {
  if (resolvePlanGenerationMode() !== 'file') return null;
  const { draftId, fullContext, model, repository, githubToken, correlationId, metadata, routingSession } = options;
  const log = correlationId ? logger.withCorrelation(correlationId) : logger;
  try {
    return await runPlanFileAgent({
      purpose: 'generation',
      prompt: buildPlanFilePrompt(fullContext),
      taskFiles: true,
      model,
      draftId,
      repository,
      githubToken,
      executionType: 'plan-generation',
      correlationId,
      metadata: { ...metadata, planGenerationMode: 'file' },
      routingSession,
    });
  } catch (error) {
    if (!(error instanceof PlanFileAgentUnavailableError)) throw error;
    log.warn({ model, error: error.message }, 'File-based plan generation is unavailable, generating from the model reply instead');
    return null;
  }
}
