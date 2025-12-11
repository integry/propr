import { db } from '../db/postgres.js';
import { generateContext } from './contextService.js';
import { getEffectiveTokenLimit, ContextLevel, DEFAULT_CONTEXT_LEVEL } from '../config/modelLimits.js';
import { findRelevantFiles } from './relevanceService.js';
import { runLightweightLLMAnalysis } from '../claude/claudeService.js';
import { PLANNER_SYSTEM_PROMPT, REFINER_SYSTEM_PROMPT, Plan, PlanItem, GRANULARITY_INSTRUCTIONS, Granularity as GranularityType } from '../claude/prompts/plannerPrompts.js';
import { parseLlmJson, JsonParseError } from '../utils/jsonUtils.js';
import logger from '../utils/logger.js';
import { PathValidationService } from './pathValidationService.js';
import { simpleGit } from 'simple-git';
import { getModelPricing } from './pricingService.js';

export class PlanningFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanningFailedError';
  }
}

interface BuildFullContextOptions {
  userRequest: string;
  repomixContext: string;
  granularity: GranularityType;
}

export function buildFullContext(options: BuildFullContextOptions): string {
  const { userRequest, repomixContext, granularity } = options;
  const granularitySpec = GRANULARITY_INSTRUCTIONS[granularity];
  
  return `<?xml version="1.0" encoding="UTF-8"?>
<llm-context>
  <system-prompt><![CDATA[${PLANNER_SYSTEM_PROMPT}]]></system-prompt>
  <user-request><![CDATA[${userRequest}]]></user-request>
  <granularity-spec><![CDATA[${granularitySpec}]]></granularity-spec>
  <repository-context>
${repomixContext}
  </repository-context>
  <output-guidelines><![CDATA[Output ONLY a valid JSON array. No markdown, no explanations.]]></output-guidelines>
</llm-context>`;
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
  context_config: TaskDraftConfig;
  generation_trace: GenerationTrace;
  status: string;
  created_at: Date;
  updated_at: Date;
}

export interface TaskDraftConfig {
  baseBranch: string;
  granularity: 'single' | 'balanced' | 'granular';
  contextLevel?: ContextLevel;
  manualFiles: string[];
  autoFiles: string[];
}

export type Granularity = 'single' | 'balanced' | 'granular';

export interface SmartFileSelection {
  path: string;
  reason: string;
  source: 'manual' | 'auto';
  score?: number;
}

export interface PreviewStats {
  totalTokens: number;
  costEstimate: number;
  contextLength: number;
  fileCount: number;
}

export interface PreviewResult {
  success: boolean;
  stats: PreviewStats;
  smartSelection: SmartFileSelection[];
  warnings: string[];
}

export interface GenerateContextPreviewOptions {
  draftId: string;
  prompt: string;
  baseBranch: string;
  granularity: Granularity;
  contextLevel?: ContextLevel;
  files?: string[];
  worktreePath: string;
  correlationId?: string;
}

interface FindFilesOptions {
  draftId: string;
  worktreePath: string;
  draft: TaskDraft;
  manualFiles: string[];
  autoFiles: string[];
  correlationId?: string;
}

async function findFilesForPlan(opts: FindFilesOptions): Promise<string[]> {
  const { draftId, worktreePath, draft, manualFiles, autoFiles, correlationId } = opts;
  const correlatedLogger = correlationId ? logger.withCorrelation(correlationId) : logger;
  await updateTrace(draftId, 'relevance', 'pending');
  const hasPrecomputedFiles = manualFiles.length > 0 || autoFiles.length > 0;

  if (hasPrecomputedFiles) {
    const relevantFilePaths = [...new Set([...manualFiles, ...autoFiles])];
    correlatedLogger.info({ manualCount: manualFiles.length, autoCount: autoFiles.length, totalCount: relevantFilePaths.length }, 'Using precomputed file selection');
    await updateTrace(draftId, 'relevance', 'completed', {
      keywords: [],
      candidates: relevantFilePaths.map(p => ({ path: p, reason: manualFiles.includes(p) ? 'manual' : 'auto', score: 100 })),
      source: 'precomputed'
    });
    return relevantFilePaths;
  }

  correlatedLogger.info({ repository: draft.repository }, 'Finding relevant files');
  const relevanceResult = await findRelevantFiles(worktreePath, draft.initial_prompt, { correlationId });
  const relevantFilePaths = relevanceResult.files.map(f => f.path);
  await updateTrace(draftId, 'relevance', 'completed', {
    keywords: relevanceResult.keywordsDetected,
    candidates: relevanceResult.files.map(f => ({ path: f.path, reason: f.reason, score: f.score }))
  });
  return relevantFilePaths;
}

interface CallLLMOptions {
  draftId: string;
  context: string;
  prompt: string;
  granularity: Granularity;
  worktreePath: string;
  githubToken: string;
  repository: string;
  correlationId?: string;
}

async function callLLMForPlan(opts: CallLLMOptions): Promise<Plan> {
  const { draftId, context, prompt, granularity, worktreePath, githubToken, repository, correlationId } = opts;
  const correlatedLogger = correlationId ? logger.withCorrelation(correlationId) : logger;
  await updateTrace(draftId, 'llm', 'pending');

  const userPrompt = buildFullContext({ userRequest: prompt, repomixContext: context, granularity });
  correlatedLogger.info('Calling LLM for plan generation');

  const issueRef = { number: 0, repoOwner: repository.split('/')[0] || 'unknown', repoName: repository.split('/')[1] || 'unknown' };
  const response = await runLightweightLLMAnalysis({ prompt: userPrompt, model: 'opus', correlationId: correlationId || 'plan-generation', worktreePath, githubToken, issueRef });

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
  return plan;
}

export async function generatePlan(options: GeneratePlanOptions): Promise<Plan> {
  const { draftId, worktreePath, githubToken, correlationId } = options;
  const correlatedLogger = correlationId ? logger.withCorrelation(correlationId) : logger;

  if (!db) throw new PlanningFailedError('Database not available');
  correlatedLogger.info({ draftId }, 'Starting plan generation');

  const draft = await db<TaskDraft>('task_drafts').where({ draft_id: draftId }).first();
  if (!draft) throw new PlanningFailedError(`Draft not found: ${draftId}`);
  if (!draft.initial_prompt) throw new PlanningFailedError('Draft has no initial prompt');

  const contextConfig = draft.context_config as TaskDraftConfig | null;
  const baseBranch = contextConfig?.baseBranch;
  const granularity: Granularity = contextConfig?.granularity || 'balanced';
  const contextLevel: ContextLevel = contextConfig?.contextLevel ?? DEFAULT_CONTEXT_LEVEL;
  const tokenLimit = getEffectiveTokenLimit(undefined, contextLevel);

  if (baseBranch) {
    try {
      await checkoutBranch(worktreePath, baseBranch);
      correlatedLogger.info({ baseBranch, worktreePath }, 'Checked out configured base branch');
    } catch (error) {
      if (error instanceof BranchNotFoundError) throw error;
      correlatedLogger.warn({ baseBranch, error: (error as Error).message }, 'Failed to checkout base branch');
    }
  }

  const relevantFilePaths = await findFilesForPlan({ draftId, worktreePath, draft, manualFiles: contextConfig?.manualFiles || [], autoFiles: contextConfig?.autoFiles || [], correlationId });

  await updateTrace(draftId, 'context', 'pending');
  correlatedLogger.info({ fileCount: relevantFilePaths.length }, 'Generating context');

  const contextResult = await generateContext({ repoPath: worktreePath, filesToInclude: relevantFilePaths.length > 0 ? relevantFilePaths : undefined, tokenLimit, correlationId });
  await updateTrace(draftId, 'context', 'completed', { includedFiles: contextResult.includedFiles, tokenCount: contextResult.totalTokens });

  const plan = await callLLMForPlan({ draftId, context: contextResult.context, prompt: draft.initial_prompt, granularity, worktreePath, githubToken, repository: draft.repository, correlationId });

  correlatedLogger.info({ taskCount: plan.length }, 'Validating and repairing file paths');
  const validatedPlan = await PathValidationService.validateAndRepair(worktreePath, plan, { correlationId });
  correlatedLogger.info({ taskCount: validatedPlan.length }, 'Plan generated successfully');

  await updateTrace(draftId, 'llm', 'completed');
  await db('task_drafts').where({ draft_id: draftId }).update({ plan_json: JSON.stringify(validatedPlan), status: 'review', updated_at: db.fn.now() });

  return validatedPlan;
}

export async function refinePlan(options: RefinePlanOptions): Promise<Plan> {
  const { currentPlan, instruction, worktreePath, repository, githubToken, correlationId } = options;
  const correlatedLogger = correlationId ? logger.withCorrelation(correlationId) : logger;

  if (!Array.isArray(currentPlan)) throw new PlanningFailedError('Current plan must be an array');
  correlatedLogger.info({ instruction, taskCount: currentPlan.length, repository }, 'Refining plan');

  const userPrompt = `${REFINER_SYSTEM_PROMPT}\n\nCurrent Plan:\n${JSON.stringify(currentPlan, null, 2)}\n\nInstruction:\n"${instruction}"\n\nRemember: Return ONLY the updated JSON array. No markdown, no explanations.`;
  const [repoOwner, repoName] = repository.split('/');
  const issueRef = { number: 0, repoOwner: repoOwner || 'unknown', repoName: repoName || 'unknown' };

  const response = await runLightweightLLMAnalysis({ prompt: userPrompt, model: 'opus', correlationId: correlationId || 'plan-refinement', worktreePath, githubToken, issueRef });

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

  if (!Array.isArray(refinedPlan)) throw new PlanningFailedError('Refined plan is not a valid array');
  correlatedLogger.info({ taskCount: refinedPlan.length }, 'Plan refined successfully');
  return refinedPlan;
}

export class BranchNotFoundError extends Error {
  constructor(branch: string) { super(`Branch '${branch}' not found`); this.name = 'BranchNotFoundError'; }
}

export async function checkoutBranch(repoPath: string, branch: string): Promise<void> {
  const git = simpleGit(repoPath);
  try { await git.fetch(['origin', '--prune']); } catch (e) { logger.warn({ repoPath, branch, error: (e as Error).message }, 'Failed to fetch'); }

  try {
    const branchExists = await git.raw(['rev-parse', '--verify', `origin/${branch}`]).then(() => true).catch(() => false);
    if (!branchExists) {
      const localExists = await git.raw(['rev-parse', '--verify', branch]).then(() => true).catch(() => false);
      if (!localExists) throw new BranchNotFoundError(branch);
    }
    await git.checkout(branch);
    try { await git.pull('origin', branch); } catch { logger.debug({ repoPath, branch }, 'Pull failed, using local'); }
  } catch (error) {
    if (error instanceof BranchNotFoundError) throw error;
    throw new BranchNotFoundError(branch);
  }
}

const DEFAULT_OUTPUT_TOKENS = 4000, SONNET_MODEL_ID = 'anthropic/claude-sonnet-4-20250514';

async function calculateCostEstimate(totalTokens: number, warnings: string[], correlatedLogger: { warn: typeof logger.warn }): Promise<number> {
  try {
    const pricing = await getModelPricing(SONNET_MODEL_ID);
    if (pricing) return totalTokens * pricing.prompt + DEFAULT_OUTPUT_TOKENS * pricing.completion;
    warnings.push('Using fallback pricing - could not fetch current model pricing');
  } catch (e) {
    warnings.push('Using fallback pricing - pricing service error');
    correlatedLogger.warn({ error: (e as Error).message }, 'Failed to get model pricing');
  }
  return (totalTokens / 1_000_000) * 3 + (DEFAULT_OUTPUT_TOKENS / 1_000_000) * 15;
}

export async function generateContextPreview(options: GenerateContextPreviewOptions): Promise<PreviewResult> {
  const { draftId, prompt, baseBranch, granularity, contextLevel = DEFAULT_CONTEXT_LEVEL, files, worktreePath, correlationId } = options;
  const previewTokenLimit = getEffectiveTokenLimit(undefined, contextLevel);
  const correlatedLogger = correlationId ? logger.withCorrelation(correlationId) : logger;
  const warnings: string[] = [];

  if (!db) throw new PlanningFailedError('Database not available');
  correlatedLogger.info({ draftId, baseBranch, granularity }, 'Starting context preview generation');

  const draft = await db<TaskDraft>('task_drafts').where({ draft_id: draftId }).first();
  if (!draft) throw new PlanningFailedError(`Draft not found: ${draftId}`);

  try {
    await checkoutBranch(worktreePath, baseBranch);
    correlatedLogger.info({ baseBranch, worktreePath }, 'Checked out branch for preview');
  } catch (error) {
    if (error instanceof BranchNotFoundError) throw error;
    throw new PlanningFailedError(`Failed to checkout branch '${baseBranch}': ${(error as Error).message}`);
  }

  correlatedLogger.info({ repository: draft.repository }, 'Finding relevant files for preview');
  const relevanceResult = await findRelevantFiles(worktreePath, prompt, { correlationId });
  const manualFiles = files || [], autoFilePaths = relevanceResult.files.map(f => f.path);
  const combinedFiles = [...new Set([...manualFiles, ...autoFilePaths])];
  correlatedLogger.info({ manualCount: manualFiles.length, autoCount: autoFilePaths.length, combinedCount: combinedFiles.length }, 'Merged files');

  const contextResult = await generateContext({ repoPath: worktreePath, filesToInclude: combinedFiles.length > 0 ? combinedFiles : undefined, tokenLimit: previewTokenLimit, correlationId });
  const costEstimate = await calculateCostEstimate(contextResult.totalTokens, warnings, correlatedLogger);

  const includedFilesSet = new Set(contextResult.includedFiles);
  const smartSelection: SmartFileSelection[] = [
    ...manualFiles.filter(p => includedFilesSet.has(p)).map(p => ({ path: p, reason: 'Explicitly included', source: 'manual' as const })),
    ...relevanceResult.files.filter(f => includedFilesSet.has(f.path)).map(f => ({ path: f.path, reason: `${f.reason} (score: ${f.score})`, source: 'auto' as const, score: f.score }))
  ];

  const fullContext = buildFullContext({ userRequest: prompt, repomixContext: contextResult.context, granularity });

  await db('task_drafts').where({ draft_id: draftId }).update({
    initial_prompt: prompt,
    context_config: JSON.stringify({ baseBranch, granularity, contextLevel, manualFiles, autoFiles: autoFilePaths }),
    generated_context: fullContext,
    updated_at: db.fn.now()
  });

  correlatedLogger.info({ totalTokens: contextResult.totalTokens, costEstimate, fileCount: contextResult.includedFiles.length }, 'Context preview completed');
  return { success: true, stats: { totalTokens: contextResult.totalTokens, costEstimate, contextLength: contextResult.totalCharacters, fileCount: contextResult.includedFiles.length }, smartSelection, warnings };
}
