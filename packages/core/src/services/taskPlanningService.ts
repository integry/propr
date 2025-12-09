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

interface GenerationTraceStep {
  name: string;
  status: 'pending' | 'completed' | 'failed';
  data?: Record<string, unknown>;
}

interface GenerationTrace {
  steps: GenerationTraceStep[];
}

async function updateTrace(
  draftId: string,
  step: string,
  status: 'pending' | 'completed' | 'failed',
  data?: Record<string, unknown>
): Promise<void> {
  if (!db) return;

  const draft = await db('task_drafts')
    .where({ draft_id: draftId })
    .select('generation_trace')
    .first();

  const rawTrace = draft?.generation_trace as GenerationTrace | undefined;
  const trace: GenerationTrace = {
    steps: Array.isArray(rawTrace?.steps) ? rawTrace.steps : []
  };

  const existingStepIndex = trace.steps.findIndex((s) => s.name === step);
  if (existingStepIndex >= 0) {
    trace.steps[existingStepIndex] = {
      ...trace.steps[existingStepIndex],
      status,
      data: { ...trace.steps[existingStepIndex].data, ...data }
    };
  } else {
    trace.steps.push({ name: step, status, data });
  }

  await db('task_drafts')
    .where({ draft_id: draftId })
    .update({ generation_trace: JSON.stringify(trace) });
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
  repository: string;
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
  generation_trace: GenerationTrace;
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

  await updateTrace(draftId, 'relevance', 'pending');

  correlatedLogger.info({ repository: draft.repository }, 'Finding relevant files');

  const relevanceResult = await findRelevantFiles(worktreePath, draft.initial_prompt, {
    correlationId
  });
  const relevantFilePaths = relevanceResult.files.map(f => f.path);

  await updateTrace(draftId, 'relevance', 'completed', {
    keywords: relevanceResult.keywordsDetected,
    candidates: relevanceResult.files.map(f => ({
      path: f.path,
      reason: f.reason,
      score: f.score
    }))
  });

  await updateTrace(draftId, 'context', 'pending');

  correlatedLogger.info({ fileCount: relevantFilePaths.length }, 'Generating context');

  // Use a lower token limit for planner to leave room for system prompt, request, and response
  // Default is 150K but we need ~10-15K for prompts and response
  const PLANNER_CONTEXT_TOKEN_LIMIT = 100000;

  const contextResult = await generateContext({
    repoPath: worktreePath,
    filesToInclude: relevantFilePaths.length > 0 ? relevantFilePaths : undefined,
    tokenLimit: PLANNER_CONTEXT_TOKEN_LIMIT,
    correlationId
  });

  await updateTrace(draftId, 'context', 'completed', {
    includedFiles: contextResult.includedFiles,
    tokenCount: contextResult.totalTokens
  });

  await updateTrace(draftId, 'llm', 'pending');

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

  await updateTrace(draftId, 'llm', 'completed');

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
  const { currentPlan, instruction, worktreePath, repository, githubToken, correlationId } = options;
  const correlatedLogger = correlationId ? logger.withCorrelation(correlationId) : logger;

  if (!Array.isArray(currentPlan)) {
    throw new PlanningFailedError('Current plan must be an array');
  }

  correlatedLogger.info({ instruction, taskCount: currentPlan.length, repository }, 'Refining plan');

  const userPrompt = `${REFINER_SYSTEM_PROMPT}

Current Plan:
${JSON.stringify(currentPlan, null, 2)}

Instruction:
"${instruction}"

Remember: Return ONLY the updated JSON array. No markdown, no explanations.`;

  const [repoOwner, repoName] = repository.split('/');
  const issueRef = {
    number: 0,
    repoOwner: repoOwner || 'unknown',
    repoName: repoName || 'unknown'
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
