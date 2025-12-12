import { db } from '../db/postgres.js';
import { generateContext } from './contextService.js';
import { getEffectiveTokenLimit, ContextLevel, DEFAULT_CONTEXT_LEVEL, TIKTOKEN_TO_CLAUDE_RATIO } from '../config/modelLimits.js';
import { findRelevantFiles } from './relevanceService.js';
import { runLightweightLLMAnalysis } from '../claude/claudeService.js';
import { PLANNER_SYSTEM_PROMPT, REFINER_SYSTEM_PROMPT, Plan, PlanItem, GRANULARITY_INSTRUCTIONS, Granularity as GranularityType } from '../claude/prompts/plannerPrompts.js';
import { parseLlmJson, JsonParseError } from '../utils/jsonUtils.js';
import logger from '../utils/logger.js';
import { PathValidationService } from './pathValidationService.js';
import {
  updateTrace,
  validatePromptTokens,
  checkoutBranch,
  BranchNotFoundError,
  CLAUDE_CODE_OVERHEAD,
  getDefaultModelLimit,
  calculateCostEstimate,
  findFilesForPlan,
  GenerationTrace
} from './planningHelpers.js';

export class PlanningFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanningFailedError';
  }
}

// Re-export for backwards compatibility
export { BranchNotFoundError } from './planningHelpers.js';

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
  compress?: boolean;
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
  totalTokens: number;      // Estimated actual Claude tokens
  tiktokenCount?: number;   // Raw tiktoken count (for debugging)
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
  compress?: boolean;
  files?: string[];
  worktreePath: string;
  correlationId?: string;
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

  // Validate token count before sending to LLM
  const modelLimit = getDefaultModelLimit();
  const validation = await validatePromptTokens(userPrompt, modelLimit, correlatedLogger);

  if (!validation.valid) {
    throw new PlanningFailedError(
      `Prompt exceeds token limit: ${validation.tokenCount} tokens (limit: ${modelLimit - CLAUDE_CODE_OVERHEAD}). ` +
      `Try reducing the context level or selecting fewer files.`
    );
  }

  correlatedLogger.info({ tokenCount: validation.tokenCount, source: validation.source }, 'Token validation passed');

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

interface ParsedContextConfig {
  baseBranch?: string;
  granularity: Granularity;
  contextLevel: ContextLevel;
  compress: boolean;
  tokenLimit: number;
  manualFiles: string[];
  autoFiles: string[];
}

function parseContextConfig(contextConfig: TaskDraftConfig | null): ParsedContextConfig {
  return {
    baseBranch: contextConfig?.baseBranch,
    granularity: contextConfig?.granularity || 'balanced',
    contextLevel: contextConfig?.contextLevel ?? DEFAULT_CONTEXT_LEVEL,
    compress: contextConfig?.compress ?? false,
    tokenLimit: getEffectiveTokenLimit(undefined, contextConfig?.contextLevel ?? DEFAULT_CONTEXT_LEVEL),
    manualFiles: contextConfig?.manualFiles || [],
    autoFiles: contextConfig?.autoFiles || []
  };
}

async function checkoutBaseBranch(
  worktreePath: string,
  baseBranch: string | undefined,
  correlatedLogger: typeof logger
): Promise<void> {
  if (!baseBranch) return;
  try {
    await checkoutBranch(worktreePath, baseBranch);
    correlatedLogger.info({ baseBranch, worktreePath }, 'Checked out configured base branch');
  } catch (error) {
    if (error instanceof BranchNotFoundError) throw error;
    correlatedLogger.warn({ baseBranch, error: (error as Error).message }, 'Failed to checkout base branch');
  }
}

export async function generatePlan(options: GeneratePlanOptions): Promise<Plan> {
  const { draftId, worktreePath, githubToken, correlationId } = options;
  const correlatedLogger = correlationId ? logger.withCorrelation(correlationId) : logger;

  if (!db) throw new PlanningFailedError('Database not available');
  correlatedLogger.info({ draftId }, 'Starting plan generation');

  const draft = await db<TaskDraft>('task_drafts').where({ draft_id: draftId }).first();
  if (!draft) throw new PlanningFailedError(`Draft not found: ${draftId}`);
  if (!draft.initial_prompt) throw new PlanningFailedError('Draft has no initial prompt');

  const config = parseContextConfig(draft.context_config as TaskDraftConfig | null);
  await checkoutBaseBranch(worktreePath, config.baseBranch, correlatedLogger);

  const relevantFilePaths = await findFilesForPlan({ draftId, worktreePath, draft, manualFiles: config.manualFiles, autoFiles: config.autoFiles, correlationId });

  await updateTrace(draftId, 'context', 'pending');
  correlatedLogger.info({ fileCount: relevantFilePaths.length, compress: config.compress }, 'Generating context');

  // When compression is enabled, include all files but prioritize relevant ones
  const filesToInclude = config.compress ? undefined : (relevantFilePaths.length > 0 ? relevantFilePaths : undefined);
  const priorityFiles = config.compress ? relevantFilePaths : undefined;
  const contextResult = await generateContext({ repoPath: worktreePath, filesToInclude, priorityFiles, tokenLimit: config.tokenLimit, compress: config.compress, correlationId });
  await updateTrace(draftId, 'context', 'completed', { includedFiles: contextResult.includedFiles, tokenCount: contextResult.totalTokens });

  const plan = await callLLMForPlan({ draftId, context: contextResult.context, prompt: draft.initial_prompt, granularity: config.granularity, worktreePath, githubToken, repository: draft.repository, correlationId });

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

// Re-export checkoutBranch for backwards compatibility
export { checkoutBranch } from './planningHelpers.js';

export async function generateContextPreview(options: GenerateContextPreviewOptions): Promise<PreviewResult> {
  const { draftId, prompt, baseBranch, granularity, contextLevel = DEFAULT_CONTEXT_LEVEL, compress = false, files, worktreePath, correlationId } = options;
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

  // Detailed logging for preview file selection breakdown
  correlatedLogger.info({
    manualFiles: {
      count: manualFiles.length,
      files: manualFiles.slice(0, 10)
    },
    autoFiles: {
      count: autoFilePaths.length,
      topCandidates: relevanceResult.files.slice(0, 5).map(f => ({
        path: f.path,
        score: f.score,
        reason: f.reason
      }))
    },
    scoreDistribution: {
      high: relevanceResult.files.filter(f => f.score > 80).length,
      medium: relevanceResult.files.filter(f => f.score > 50 && f.score <= 80).length,
      low: relevanceResult.files.filter(f => f.score <= 50).length
    },
    combinedCount: combinedFiles.length,
    overlap: manualFiles.filter(f => autoFilePaths.includes(f)).length
  }, 'Preview file selection breakdown');

  // When compression is enabled, include all files but prioritize relevant ones
  // This allows repomix to pack as many files as possible within the budget
  const filesToInclude = compress ? undefined : (combinedFiles.length > 0 ? combinedFiles : undefined);
  const priorityFiles = compress ? combinedFiles : undefined;
  const contextResult = await generateContext({ repoPath: worktreePath, filesToInclude, priorityFiles, tokenLimit: previewTokenLimit, compress, correlationId });
  const costEstimate = await calculateCostEstimate(contextResult.totalTokens, warnings, correlatedLogger);

  const includedFilesSet = new Set(contextResult.includedFiles);

  // Build smart selection - when compress is enabled, show all included files
  let smartSelection: SmartFileSelection[];
  if (compress) {
    // Create a map of relevance scores for files that were found by relevance
    const relevanceScores = new Map(relevanceResult.files.map(f => [f.path, f]));
    smartSelection = contextResult.includedFiles.map(path => {
      const relevanceInfo = relevanceScores.get(path);
      if (manualFiles.includes(path)) {
        return { path, reason: 'Explicitly included', source: 'manual' as const };
      } else if (relevanceInfo) {
        return { path, reason: `${relevanceInfo.reason} (score: ${relevanceInfo.score})`, source: 'auto' as const, score: relevanceInfo.score };
      } else {
        return { path, reason: 'Included via compression', source: 'auto' as const };
      }
    });
  } else {
    smartSelection = [
      ...manualFiles.filter(p => includedFilesSet.has(p)).map(p => ({ path: p, reason: 'Explicitly included', source: 'manual' as const })),
      ...relevanceResult.files.filter(f => includedFilesSet.has(f.path)).map(f => ({ path: f.path, reason: `${f.reason} (score: ${f.score})`, source: 'auto' as const, score: f.score }))
    ];
  }

  const fullContext = buildFullContext({ userRequest: prompt, repomixContext: contextResult.context, granularity });

  await db('task_drafts').where({ draft_id: draftId }).update({
    initial_prompt: prompt,
    context_config: JSON.stringify({ baseBranch, granularity, contextLevel, compress, manualFiles, autoFiles: autoFilePaths }),
    generated_context: fullContext,
    updated_at: db.fn.now()
  });

  // Convert tiktoken count to estimated actual Claude tokens for UI display
  const estimatedActualTokens = Math.ceil(contextResult.totalTokens * TIKTOKEN_TO_CLAUDE_RATIO);

  correlatedLogger.info({
    tiktokenCount: contextResult.totalTokens,
    estimatedActualTokens,
    costEstimate,
    fileCount: contextResult.includedFiles.length
  }, 'Context preview completed');

  return {
    success: true,
    stats: {
      totalTokens: estimatedActualTokens,  // Show estimated actual Claude tokens
      tiktokenCount: contextResult.totalTokens,  // Also include raw tiktoken for debugging
      costEstimate,
      contextLength: contextResult.totalCharacters,
      fileCount: contextResult.includedFiles.length
    },
    smartSelection,
    warnings
  };
}
