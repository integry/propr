import { db } from '../db/postgres.js';
import { generateContext } from './contextService.js';
import { findRelevantFiles } from './relevanceService.js';
import { runLightweightLLMAnalysis } from '../claude/claudeService.js';
import { PLANNER_SYSTEM_PROMPT, REFINER_SYSTEM_PROMPT, Plan, PlanItem } from '../claude/prompts/plannerPrompts.js';
import { parseLlmJson, JsonParseError } from '../utils/jsonUtils.js';
import logger from '../utils/logger.js';
import { PathValidationService } from './pathValidationService.js';

export class PlanningFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanningFailedError';
  }
}

export interface GeneratePlanOptions {
  draftId: string;
  worktreePath: string;
  githubToken: string;
  correlationId?: string;
}

export interface RefinePlanOptions {
  currentPlan: Plan;
  instruction: string;
  worktreePath: string;
  githubToken: string;
  correlationId?: string;
}

interface TaskDraft {
  draft_id: string;
  user_id: string;
  repository: string;
  name: string;
  initial_prompt: string;
  plan_json: Plan;
  context_config: Record<string, unknown>;
  status: string;
  created_at: Date;
  updated_at: Date;
}

export async function generatePlan(options: GeneratePlanOptions): Promise<Plan> {
  const { draftId, worktreePath, githubToken, correlationId } = options;
  const correlatedLogger = correlationId ? logger.withCorrelation(correlationId) : logger;

  if (!db) {
    throw new PlanningFailedError('Database not available');
  }

  correlatedLogger.info({ draftId }, 'Starting plan generation');

  const draft = await db<TaskDraft>('task_drafts').where({ draft_id: draftId }).first();
  if (!draft) {
    throw new PlanningFailedError(`Draft not found: ${draftId}`);
  }

  if (!draft.initial_prompt) {
    throw new PlanningFailedError('Draft has no initial prompt');
  }

  correlatedLogger.info({ repository: draft.repository }, 'Finding relevant files');

  const relevanceResult = await findRelevantFiles(worktreePath, draft.initial_prompt, {
    correlationId
  });
  const relevantFilePaths = relevanceResult.files.map(f => f.path);

  correlatedLogger.info({ fileCount: relevantFilePaths.length }, 'Generating context');

  const contextResult = await generateContext({
    repoPath: worktreePath,
    filesToInclude: relevantFilePaths.length > 0 ? relevantFilePaths : undefined,
    correlationId
  });

  const userPrompt = `${PLANNER_SYSTEM_PROMPT}

<context>
${contextResult.context}
</context>

<request>
${draft.initial_prompt}
</request>

Remember: Output ONLY a valid JSON array. No markdown, no explanations.`;

  correlatedLogger.info('Calling LLM for plan generation');

  const issueRef = {
    number: 0,
    repoOwner: draft.repository.split('/')[0] || 'unknown',
    repoName: draft.repository.split('/')[1] || 'unknown'
  };

  const response = await runLightweightLLMAnalysis({
    prompt: userPrompt,
    model: 'opus',
    correlationId: correlationId || 'plan-generation',
    worktreePath,
    githubToken,
    issueRef
  });

  let plan: Plan;
  try {
    plan = parseLlmJson<PlanItem[]>(response);
  } catch (error) {
    if (error instanceof JsonParseError) {
      correlatedLogger.error({ error: error.message, response: response.substring(0, 500) }, 'Failed to parse LLM response');
      throw new PlanningFailedError(`Failed to parse plan: ${error.message}`);
    }
    throw error;
  }

  if (!Array.isArray(plan) || plan.length === 0) {
    throw new PlanningFailedError('Generated plan is empty. The prompt may be too vague.');
  }

  correlatedLogger.info({ taskCount: plan.length }, 'Validating and repairing file paths');
  const validatedPlan = await PathValidationService.validateAndRepair(worktreePath, plan, {
    correlationId
  });

  correlatedLogger.info({ taskCount: validatedPlan.length }, 'Plan generated successfully');

  await db('task_drafts')
    .where({ draft_id: draftId })
    .update({
      plan_json: JSON.stringify(validatedPlan),
      status: 'review',
      updated_at: db.fn.now()
    });

  return validatedPlan;
}

export async function refinePlan(options: RefinePlanOptions): Promise<Plan> {
  const { currentPlan, instruction, worktreePath, githubToken, correlationId } = options;
  const correlatedLogger = correlationId ? logger.withCorrelation(correlationId) : logger;

  if (!Array.isArray(currentPlan)) {
    throw new PlanningFailedError('Current plan must be an array');
  }

  correlatedLogger.info({ instruction, taskCount: currentPlan.length }, 'Refining plan');

  const userPrompt = `${REFINER_SYSTEM_PROMPT}

Current Plan:
${JSON.stringify(currentPlan, null, 2)}

Instruction:
"${instruction}"

Remember: Return ONLY the updated JSON array. No markdown, no explanations.`;

  const issueRef = {
    number: 0,
    repoOwner: 'unknown',
    repoName: 'unknown'
  };

  const response = await runLightweightLLMAnalysis({
    prompt: userPrompt,
    model: 'opus',
    correlationId: correlationId || 'plan-refinement',
    worktreePath,
    githubToken,
    issueRef
  });

  let refinedPlan: Plan;
  try {
    refinedPlan = parseLlmJson<PlanItem[]>(response);
  } catch (error) {
    if (error instanceof JsonParseError) {
      correlatedLogger.error({ error: error.message }, 'Failed to parse refined plan');
      throw new PlanningFailedError(`Failed to parse refined plan: ${error.message}`);
    }
    throw error;
  }

  if (!Array.isArray(refinedPlan)) {
    throw new PlanningFailedError('Refined plan is not a valid array');
  }

  correlatedLogger.info({ taskCount: refinedPlan.length }, 'Plan refined successfully');

  return refinedPlan;
}
