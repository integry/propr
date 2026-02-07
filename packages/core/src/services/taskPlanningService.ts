/* eslint-disable max-lines */
import { db } from '../db/connection.js';
import { generateContext, generateAdditionalContext } from './contextService.js';
import { loadFileSummaries, buildSummaryContext } from './relevance/contextBuilder.js';
import { runLightweightLLMAnalysis } from '../claude/claudeService.js';
import { REFINER_SYSTEM_PROMPT, Plan, PlanItem, RefinementResponse } from '../claude/prompts/plannerPrompts.js';
import { parseLlmJson, JsonParseError } from '../utils/jsonUtils.js';
import logger from '../utils/logger.js';
import { PathValidationService } from './pathValidationService.js';
import fs from 'fs-extra';
import path from 'path';
import {
  updateTrace, validatePromptTokens, CLAUDE_CODE_OVERHEAD, findFilesForPlan,
  GenerationTrace, RELEVANT_SUMMARY_COUNT, RESERVED_OVERHEAD_TOKENS, CHARS_PER_TOKEN,
  parseContextConfig, checkoutBaseBranch, TaskDraftConfig, Granularity, PlanningFailedError, buildFullContext,
  Base64Image, MinimalLogger, ContextRepository, getModelHardLimit
} from './planningHelpers.js';
import type { Attachment } from './attachmentService.js';
import { loadSettings } from '../config/configManager.js';

/** Default model for context analysis (fast, cost-effective) */
const DEFAULT_CONTEXT_MODEL = 'haiku';

/** Default model for plan generation (high capability) */
const DEFAULT_GENERATION_MODEL = 'opus';

/**
 * Parse attachments from draft (stored as JSON string in SQLite)
 */
function parseAttachments(draftAttachments: string | Attachment[] | undefined): Attachment[] {
  if (typeof draftAttachments === 'string') {
    try {
      return JSON.parse(draftAttachments);
    } catch {
      return [];
    }
  }
  if (Array.isArray(draftAttachments)) {
    return draftAttachments;
  }
  return [];
}

interface LoadedImages {
  images: Base64Image[];
  totalTokens: number;
}

/**
 * Calculate token estimate for base64 image data.
 * Base64 is ~4/3 of original size, then ~4 chars per token, plus XML overhead.
 */
function calculateBase64Tokens(base64Length: number): number {
  // base64 string is tokenized as text: ~4 chars per token, plus 10% for XML wrapper
  return Math.ceil((base64Length / 4) * 1.1);
}

/**
 * Load image attachments and convert them to base64.
 * Returns both the images and accurate token count based on actual base64 size.
 */
async function loadImageAttachmentsAsBase64(
  attachments: Attachment[],
  correlatedLogger: MinimalLogger
): Promise<LoadedImages> {
  const base64Images: Base64Image[] = [];
  const imageAttachments = attachments.filter(a => a.type === 'image');
  let totalTokens = 0;

  for (const img of imageAttachments) {
    try {
      const absolutePath = path.isAbsolute(img.storedPath)
        ? img.storedPath
        : path.join(process.cwd(), img.storedPath);
      const imageData = await fs.readFile(absolutePath);
      const base64Data = imageData.toString('base64');
      const imageTokens = calculateBase64Tokens(base64Data.length);
      totalTokens += imageTokens;

      base64Images.push({
        name: img.originalName,
        mimeType: img.mimeType,
        base64Data,
      });
      correlatedLogger.info({ imageName: img.originalName, fileSize: imageData.length, base64Length: base64Data.length, tokens: imageTokens }, 'Loaded image attachment');
    } catch (error) {
      correlatedLogger.warn({ imagePath: img.storedPath, error: (error as Error).message }, 'Failed to load image attachment');
    }
  }

  return { images: base64Images, totalTokens };
}

/**
 * Parse context_config from draft (JSON string from SQLite or object)
 */
function parseDraftContextConfig(
  contextConfig: string | TaskDraftConfig | null | undefined,
  draftId: string,
  correlatedLogger: MinimalLogger
): TaskDraftConfig | null {
  if (typeof contextConfig === 'string') {
    try {
      return JSON.parse(contextConfig);
    } catch {
      correlatedLogger.warn({ draftId }, 'Failed to parse context_config, using defaults');
      return null;
    }
  }
  if (contextConfig) {
    return contextConfig as TaskDraftConfig;
  }
  return null;
}

/**
 * Metadata about granularity enforcement actions
 */
export interface GranularityEnforcementMetadata {
  /** Whether enforcement was applied */
  enforced: boolean;
  /** The granularity setting that was used */
  granularity: Granularity;
  /** Original task count before enforcement */
  originalTaskCount: number;
  /** Final task count after enforcement */
  finalTaskCount: number;
  /** Human-readable message about the enforcement action */
  message?: string;
}

/**
 * Result of granularity enforcement
 */
interface EnforceGranularityResult {
  plan: Plan;
  metadata: GranularityEnforcementMetadata;
}

/**
 * Enforce granularity constraints on the generated plan.
 * - For 'single': If multiple tasks are returned, merge them into one comprehensive task
 * - For 'balanced' and 'granular': No enforcement needed, LLM output is used as-is
 */
function enforceGranularity(plan: Plan, granularity: Granularity, correlatedLogger: MinimalLogger): EnforceGranularityResult {
  const originalTaskCount = plan.length;

  if (granularity !== 'single') {
    // For balanced and granular, no enforcement needed
    return {
      plan,
      metadata: {
        enforced: false,
        granularity,
        originalTaskCount,
        finalTaskCount: plan.length
      }
    };
  }

  // For single granularity, enforce exactly one task
  if (plan.length === 1) {
    correlatedLogger.info({ taskCount: 1 }, 'Single granularity: Plan already has exactly one task');
    return {
      plan,
      metadata: {
        enforced: false,
        granularity,
        originalTaskCount: 1,
        finalTaskCount: 1
      }
    };
  }

  // Multiple tasks returned for single granularity - merge them
  correlatedLogger.warn(
    { taskCount: plan.length, granularity },
    'Single granularity selected but LLM returned multiple tasks - merging into one'
  );

  // Merge all tasks into a single comprehensive task
  const mergedTask: PlanItem = {
    title: plan.length > 0 ? plan[0].title : 'Comprehensive Implementation',
    body: mergeBodies(plan),
    implementation: mergeImplementations(plan)
  };

  correlatedLogger.info(
    { originalTaskCount: plan.length, mergedTitle: mergedTask.title },
    'Successfully merged tasks into single comprehensive task'
  );

  return {
    plan: [mergedTask],
    metadata: {
      enforced: true,
      granularity,
      originalTaskCount,
      finalTaskCount: 1,
      message: `${originalTaskCount} tasks merged into 1 per your Single Task setting`
    }
  };
}

/**
 * Merge multiple task bodies into a single comprehensive body
 */
function mergeBodies(tasks: PlanItem[]): string {
  if (tasks.length === 0) return '';
  if (tasks.length === 1) return tasks[0].body;

  const sections: string[] = [];

  // Add context section
  sections.push('## Context\n\nThis comprehensive task combines multiple related changes into a single implementation.\n');

  // Add requirements from all tasks
  sections.push('## Requirements\n');
  tasks.forEach((task, index) => {
    sections.push(`### Part ${index + 1}: ${task.title}\n\n${task.body}\n`);
  });

  // Add acceptance criteria
  sections.push('## Acceptance Criteria\n\n- [ ] All changes from the sections above are implemented correctly\n- [ ] Code follows existing patterns and conventions\n- [ ] All tests pass\n');

  return sections.join('\n');
}

/**
 * Merge multiple task implementations into a single comprehensive implementation
 */
function mergeImplementations(tasks: PlanItem[]): string {
  if (tasks.length === 0) return '';
  if (tasks.length === 1) return tasks[0].implementation;

  const implementations: string[] = [];

  tasks.forEach((task, index) => {
    if (task.implementation && task.implementation.trim()) {
      implementations.push(`// ============================================`);
      implementations.push(`// Part ${index + 1}: ${task.title}`);
      implementations.push(`// ============================================\n`);
      implementations.push(task.implementation);
      implementations.push('');
    }
  });

  return implementations.join('\n');
}

// Re-export for backwards compatibility
export { BranchNotFoundError, PlanningFailedError, buildFullContext } from './planningHelpers.js';
export { SmartFileSelection, PreviewStats, PreviewResult, GenerateContextPreviewOptions, generateContextPreview } from './planningHelpers.js';

export interface GeneratePlanOptions {
  draftId: string;
  worktreePath: string;
  githubToken: string;
  correlationId?: string;
}

interface TokenBudgetResult {
  summaryTokenCost: number;
  smartSummaryBudget: number;
  additionalContextBudget: number;
  repomixTokenLimit: number;
}

interface TokenBudgetOptions {
  tokenLimit: number;
  attachmentTokens: number;
  fullSummaryText: string;
  hasContextRepositories: boolean;
  correlatedLogger: MinimalLogger;
}

/** Maximum percentage of token budget that attachments can consume */
const MAX_ATTACHMENT_PERCENT = 0.25;

/** Safety factor to account for tiktoken-to-Claude estimation variance */
const BUDGET_SAFETY_FACTOR = 0.85;

/**
 * Calculate token budgets for different context components.
 * Allocates fixed percentages to ensure repomix always gets at least 50% of available space.
 * Applies a safety factor to account for tiktoken estimation variance.
 */
function calculateTokenBudgets(options: TokenBudgetOptions): TokenBudgetResult {
  const { tokenLimit, attachmentTokens, fullSummaryText, hasContextRepositories, correlatedLogger } = options;

  // Apply safety factor to total budget to account for tiktoken-to-Claude variance
  const safeTokenLimit = Math.floor(tokenLimit * BUDGET_SAFETY_FACTOR);

  // Cap attachments at 25% of budget
  const attachmentBudget = Math.floor(safeTokenLimit * MAX_ATTACHMENT_PERCENT);
  const effectiveAttachmentTokens = Math.min(attachmentTokens, attachmentBudget);
  const attachmentsCapped = attachmentTokens > attachmentBudget;

  if (attachmentsCapped) {
    correlatedLogger.warn({
      attachmentTokens, attachmentBudget, tokenLimit,
      percentUsed: Math.round((attachmentTokens / tokenLimit) * 100)
    }, 'Attachments exceed budget - images may be excluded or context reduced');
  }

  // Calculate available space after attachments and overhead
  const availableAfterFixed = safeTokenLimit - effectiveAttachmentTokens - RESERVED_OVERHEAD_TOKENS;

  // Allocate fixed percentages of the available space:
  // - 10% for file summaries (capped)
  // - 10% for smart summaries
  // - 20% for additional context repos (if any)
  // - Remaining 60-80% for repomix code context
  const fileSummaryBudget = Math.floor(availableAfterFixed * 0.10);
  const smartSummaryBudget = Math.floor(availableAfterFixed * 0.10);
  const additionalContextBudget = hasContextRepositories ? Math.floor(availableAfterFixed * 0.20) : 0;

  // Calculate actual summary cost and cap it
  const rawSummaryCost = Math.ceil(fullSummaryText.length / CHARS_PER_TOKEN);
  const summaryTokenCost = Math.min(rawSummaryCost, fileSummaryBudget);
  const summaryTruncated = rawSummaryCost > fileSummaryBudget;

  // Repomix gets the rest
  const repomixTokenLimit = Math.max(5000, availableAfterFixed - summaryTokenCost - smartSummaryBudget - additionalContextBudget);

  // Error if there's not enough room for context
  if (repomixTokenLimit < 5000) {
    throw new PlanningFailedError(
      `Attachments use ${attachmentTokens} tokens, leaving insufficient room for code context. ` +
      `Try removing large images or increasing the context level.`
    );
  }

  correlatedLogger.info({
    totalLimit: tokenLimit, safeTokenLimit, attachmentTokens, effectiveAttachmentTokens, attachmentsCapped,
    rawSummaryCost, summaryCost: summaryTokenCost, summaryTruncated, fileSummaryBudget,
    smartSummaryBudget, additionalContextBudget, repomixLimit: repomixTokenLimit
  }, 'Calculated token budgets');

  return { summaryTokenCost, smartSummaryBudget, additionalContextBudget, repomixTokenLimit };
}

interface AdditionalContextResult {
  context?: string;
}

interface AdditionalContextOptions {
  contextRepositories: ContextRepository[] | undefined;
  additionalContextBudget: number;
  githubToken: string;
  draftId: string;
  correlationId: string | undefined;
  correlatedLogger: MinimalLogger;
}

/**
 * Generate additional context from context repositories if configured
 */
async function generateAdditionalContextIfNeeded(options: AdditionalContextOptions): Promise<AdditionalContextResult> {
  const { contextRepositories, additionalContextBudget, githubToken, draftId, correlationId, correlatedLogger } = options;
  if (!contextRepositories || contextRepositories.length === 0) {
    return {};
  }

  correlatedLogger.info({
    repositoryCount: contextRepositories.length,
    repositories: contextRepositories.map(r => r.repository),
    budgetTokens: additionalContextBudget
  }, 'Generating additional context from context repositories');

  try {
    const additionalContextResult = await generateAdditionalContext({
      repositories: contextRepositories,
      tokenBudget: additionalContextBudget,
      authToken: githubToken,
      correlationId
    });

    if (additionalContextResult.repositoriesIncluded.length > 0) {
      correlatedLogger.info({
        repositoriesIncluded: additionalContextResult.repositoriesIncluded,
        totalTokens: additionalContextResult.totalTokens,
        errorCount: additionalContextResult.errors.length
      }, 'Additional context generated successfully');

      await updateTrace(draftId, 'additional_context', 'completed', {
        repositoriesIncluded: additionalContextResult.repositoriesIncluded,
        totalTokens: additionalContextResult.totalTokens,
        errors: additionalContextResult.errors
      });
    }

    if (additionalContextResult.errors.length > 0) {
      correlatedLogger.warn({ errors: additionalContextResult.errors }, 'Some context repositories could not be processed');
    }

    return { context: additionalContextResult.context };
  } catch (error) {
    correlatedLogger.warn({ error: (error as Error).message }, 'Failed to generate additional context, continuing without it');
    return {};
  }
}

export interface RefinePlanOptions {
  currentPlan: Plan;
  instruction: string;
  worktreePath: string;
  repository: string;
  githubToken: string;
  correlationId?: string;
  originalContext?: string;
}

export interface RefinePlanResult {
  plan: Plan;
  action: 'modified' | 'answered' | 'clarify';
  summary: string;
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
  attachments?: string | Attachment[];
  status: string;
  created_at: Date;
  updated_at: Date;
}

export type { Granularity, TaskDraftConfig, ContextRepository } from './planningHelpers.js';

interface CallLLMOptions {
  draftId: string;
  /** Full context XML including all enrichments (repomix, summaries, images, etc.) */
  fullContext: string;
  worktreePath: string;
  githubToken: string;
  repository: string;
  correlationId?: string;
  /** Token limit based on user's context level setting */
  tokenLimit: number;
  /** Model to use for plan generation (e.g., 'opus', 'claude:claude-opus-4-5-20251101') */
  model?: string;
  /** Optional context from additional repositories (marked as example/reference only) */
  additionalContext?: string;
  /** Granularity setting for task enforcement */
  granularity: Granularity;
}

interface CallLLMForPlanResult {
  plan: Plan;
  enforcementMetadata: GranularityEnforcementMetadata;
}

async function callLLMForPlan(opts: CallLLMOptions): Promise<CallLLMForPlanResult> {
  const { draftId, fullContext, worktreePath, githubToken, repository, correlationId, tokenLimit, model = DEFAULT_GENERATION_MODEL, granularity } = opts;
  const correlatedLogger = correlationId ? logger.withCorrelation(correlationId) : logger;
  await updateTrace(draftId, 'llm', 'pending');

  // Use model's hard limit for validation (context level is a guideline, not a hard limit)
  const modelHardLimit = getModelHardLimit(model);
  correlatedLogger.info({ model, tokenLimit, modelHardLimit, contextLength: fullContext.length }, 'Calling LLM for plan generation');

  // Validate token count before sending to LLM (use model's hard limit, not user's context level)
  const validation = await validatePromptTokens(fullContext, modelHardLimit, correlatedLogger);

  if (!validation.valid) {
    throw new PlanningFailedError(
      `Prompt exceeds model context window: ${validation.tokenCount} tokens (model limit: ${modelHardLimit - CLAUDE_CODE_OVERHEAD}). ` +
      `This shouldn't happen - please report this bug.`
    );
  }

  correlatedLogger.info({ tokenCount: validation.tokenCount, source: validation.source, modelHardLimit }, 'Token validation passed');

  const issueRef = { number: 0, repoOwner: repository.split('/')[0] || 'unknown', repoName: repository.split('/')[1] || 'unknown' };
  const response = await runLightweightLLMAnalysis({ prompt: fullContext, model, correlationId: correlationId || 'plan-generation', worktreePath, githubToken, issueRef, taskId: draftId });

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

  // Enforce granularity constraints - merge tasks if needed for 'single' mode
  const enforceResult = enforceGranularity(plan, granularity, correlatedLogger);
  return { plan: enforceResult.plan, enforcementMetadata: enforceResult.metadata };
}

interface ContextGenerationResult {
  fullContext: string;
  contextResult: Awaited<ReturnType<typeof generateContext>>;
}

interface ContextGenerationParams {
  worktreePath: string;
  config: ReturnType<typeof parseContextConfig>;
  relevantFilePaths: string[];
  candidateSummaries: { path: string; summary: string }[];
  budgets: TokenBudgetResult;
  base64Images: Base64Image[];
  draft: TaskDraft;
  draftId: string;
  githubToken: string;
  correlationId?: string;
  generationModel: string;
  correlatedLogger: MinimalLogger;
}

async function generateContextWithRetry(params: ContextGenerationParams): Promise<ContextGenerationResult> {
  const { worktreePath, config, relevantFilePaths, candidateSummaries, budgets, base64Images, draft, draftId, githubToken, correlationId, generationModel, correlatedLogger } = params;
  const modelHardLimit = getModelHardLimit(generationModel);
  let currentRepomixLimit = budgets.repomixTokenLimit;
  let contextResult: Awaited<ReturnType<typeof generateContext>> | undefined;
  let fullContext = '';
  const maxRetries = 5;

  for (let retryCount = 0; retryCount < maxRetries; retryCount++) {
    const filesToInclude = config.compress ? undefined : (relevantFilePaths.length > 0 ? relevantFilePaths : undefined);
    const priorityFiles = config.compress ? relevantFilePaths : undefined;
    contextResult = await generateContext({ repoPath: worktreePath, filesToInclude, priorityFiles, tokenLimit: currentRepomixLimit, compress: config.compress, correlationId });

    const includedFilesSet = new Set(contextResult.includedFiles);
    const filteredCandidates = candidateSummaries.filter(s => !includedFilesSet.has(s.path));
    const summaryBudgetChars = budgets.summaryTokenCost * CHARS_PER_TOKEN;
    let filteredSummaries = '';
    let summariesIncludedCount = 0;
    for (const s of filteredCandidates) {
      const entry = `FILE ${s.path}: ${s.summary}\n`;
      if (filteredSummaries.length + entry.length > summaryBudgetChars) break;
      filteredSummaries += entry;
      summariesIncludedCount++;
    }
    filteredSummaries = filteredSummaries.trim();

    correlatedLogger.info({ totalCandidates: candidateSummaries.length, includedInContext: contextResult.includedFiles.length, summariesIncluded: summariesIncludedCount, summariesTruncated: summariesIncludedCount < filteredCandidates.length, summaryBudgetChars, retryCount }, 'Filtered summaries for context enrichment');

    const smartSummaryResult = await buildSummaryContext({ tokenBudget: budgets.smartSummaryBudget, priorityPaths: relevantFilePaths, repoName: draft.repository, correlationId });
    const smartSummaries = smartSummaryResult.context || undefined;
    if (smartSummaries) {
      correlatedLogger.info({ fileSummaryCount: smartSummaryResult.fileSummaryCount, dirSummaryCount: smartSummaryResult.dirSummaryCount, estimatedTokens: smartSummaryResult.estimatedTokens, truncated: smartSummaryResult.truncated }, 'Built smart summary context');
    }

    const additionalContextResult = await generateAdditionalContextIfNeeded({ contextRepositories: config.contextRepositories, additionalContextBudget: budgets.additionalContextBudget, githubToken, draftId, correlationId, correlatedLogger });
    const additionalContext = additionalContextResult.context;

    fullContext = buildFullContext({ userRequest: draft.initial_prompt, repomixContext: contextResult.context, granularity: config.granularity, fileSummaries: filteredSummaries, smartSummaries, images: base64Images.length > 0 ? base64Images : undefined, additionalContext });

    const validation = await validatePromptTokens(fullContext, modelHardLimit, correlatedLogger);
    if (validation.valid) {
      correlatedLogger.info({ tokenCount: validation.tokenCount, modelHardLimit, retryCount, filesIncluded: contextResult.includedFiles.length }, 'Context fits within model limit');
      return { fullContext, contextResult };
    }

    const overage = validation.tokenCount - (modelHardLimit - CLAUDE_CODE_OVERHEAD);
    currentRepomixLimit = Math.floor(currentRepomixLimit * 0.7);

    correlatedLogger.warn({ tokenCount: validation.tokenCount, modelHardLimit, overage, newRepomixLimit: currentRepomixLimit, retryCount: retryCount + 1 }, 'Context exceeds model limit, reducing files and retrying');

    if (currentRepomixLimit < 5000) {
      throw new PlanningFailedError(`Cannot fit context within model limit even with minimal files. Attachments and fixed content use too many tokens. Try removing large images.`);
    }
  }

  throw new PlanningFailedError(`Failed to fit context within model limit after ${maxRetries} attempts. Try removing large images or reducing context complexity.`);
}

export async function generatePlan(options: GeneratePlanOptions): Promise<Plan> {
  const { draftId, worktreePath, githubToken, correlationId } = options;
  const correlatedLogger = correlationId ? logger.withCorrelation(correlationId) : logger;

  if (!db) throw new PlanningFailedError('Database not available');

  // Load planner models from settings (used as defaults)
  const settings = await loadSettings();
  const contextModel = settings.planner_context_model || DEFAULT_CONTEXT_MODEL;
  const defaultGenerationModel = settings.planner_generation_model || DEFAULT_GENERATION_MODEL;
  correlatedLogger.info({ draftId, contextModel, defaultGenerationModel }, 'Starting plan generation');

  const draft = await db<TaskDraft>('task_drafts').where({ draft_id: draftId }).first();
  if (!draft) throw new PlanningFailedError(`Draft not found: ${draftId}`);
  if (!draft.initial_prompt) throw new PlanningFailedError('Draft has no initial prompt');

  // Parse and load attachments - use actual base64 size for accurate token count
  const attachments = parseAttachments(draft.attachments);
  const { images: base64Images, totalTokens: imageTokens } = await loadImageAttachmentsAsBase64(attachments, correlatedLogger);
  const textAttachmentTokens = attachments.filter(a => a.type === 'text').reduce((sum, a) => sum + (a.tokenEstimate || 0), 0);
  const attachmentTokens = imageTokens + textAttachmentTokens;
  correlatedLogger.info({ attachmentCount: attachments.length, imageCount: base64Images.length, imageTokens, textAttachmentTokens, attachmentTokens }, 'Loaded attachments from draft');

  // Parse context_config - generationModel from draft config takes priority over global setting
  const parsedContextConfig = parseDraftContextConfig(draft.context_config, draftId, correlatedLogger);
  const config = parseContextConfig(parsedContextConfig, defaultGenerationModel);
  // Use the effective generation model: draft config > global setting
  const generationModel = config.generationModel || defaultGenerationModel;
  correlatedLogger.info({ draftId, granularity: config.granularity, contextLevel: config.contextLevel, tokenLimit: config.tokenLimit, rawContextLevel: parsedContextConfig?.contextLevel, generationModel, draftGenerationModel: config.generationModel }, 'Parsed context config for plan generation');
  await checkoutBaseBranch(worktreePath, config.baseBranch, correlatedLogger);

  const relevantFilePaths = await findFilesForPlan({ draftId, worktreePath, draft, manualFiles: config.manualFiles, autoFiles: config.autoFiles, correlationId, contextModel });

  await updateTrace(draftId, 'context', 'pending');
  correlatedLogger.info({ fileCount: relevantFilePaths.length, compress: config.compress }, 'Generating context');

  // Load and prepare file summaries
  const allSummaries = await loadFileSummaries();
  const repoPrefix = draft.repository + '/';
  const repoSummaries = allSummaries.filter(s => s.path.startsWith(repoPrefix)).map(s => ({ ...s, path: s.path.slice(repoPrefix.length) }));
  const summaryMap = new Map(repoSummaries.map(s => [s.path, s.summary]));
  const topRelevantFiles = relevantFilePaths.slice(0, RELEVANT_SUMMARY_COUNT);
  const candidateSummaries = topRelevantFiles.map(p => { const summary = summaryMap.get(p); return summary ? { path: p, summary } : null; }).filter((item): item is { path: string; summary: string } => item !== null);
  const fullSummaryText = candidateSummaries.map(s => `FILE ${s.path}: ${s.summary}`).join('\n');

  // Calculate token budgets
  const budgets = calculateTokenBudgets({
    tokenLimit: config.tokenLimit, attachmentTokens, fullSummaryText,
    hasContextRepositories: !!(config.contextRepositories && config.contextRepositories.length > 0), correlatedLogger
  });

  // Generate context with retry logic
  const { fullContext, contextResult } = await generateContextWithRetry({
    worktreePath, config, relevantFilePaths, candidateSummaries, budgets, base64Images,
    draft, draftId, githubToken, correlationId, generationModel, correlatedLogger
  });

  await updateTrace(draftId, 'context', 'completed', { includedFiles: contextResult.includedFiles, tokenCount: contextResult.totalTokens });

  const { plan, enforcementMetadata } = await callLLMForPlan({
    draftId, fullContext: fullContext!, worktreePath, githubToken, repository: draft.repository,
    correlationId, tokenLimit: config.tokenLimit, model: generationModel, granularity: config.granularity
  });

  correlatedLogger.info({ taskCount: plan.length }, 'Validating and repairing file paths');
  const validatedPlan = await PathValidationService.validateAndRepair(worktreePath, plan, { correlationId });
  correlatedLogger.info({ taskCount: validatedPlan.length }, 'Plan generated successfully');

  // Add trace step for granularity enforcement if tasks were merged
  if (enforcementMetadata.enforced) {
    await updateTrace(draftId, 'granularity_enforcement', 'completed', {
      originalTaskCount: enforcementMetadata.originalTaskCount, finalTaskCount: enforcementMetadata.finalTaskCount,
      granularity: enforcementMetadata.granularity, message: enforcementMetadata.message
    });
    correlatedLogger.info({ originalTaskCount: enforcementMetadata.originalTaskCount, finalTaskCount: enforcementMetadata.finalTaskCount }, 'Granularity enforcement applied - added trace step');
  }

  await updateTrace(draftId, 'llm', 'completed');

  const updatedContextConfig = { ...parsedContextConfig, granularityEnforcement: enforcementMetadata };

  await db('task_drafts').where({ draft_id: draftId }).update({
    plan_json: JSON.stringify(validatedPlan), context_config: JSON.stringify(updatedContextConfig),
    generated_context: fullContext, status: 'review', updated_at: db.fn.now()
  });

  return validatedPlan;
}

/**
 * Parse LLM response into a RefinementResponse, handling various response formats.
 * Wraps plain arrays and applies default values for missing fields.
 */
function parseRefinementResponse(
  response: string,
  correlatedLogger: typeof logger
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
  correlatedLogger: typeof logger
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

export async function refinePlan(options: RefinePlanOptions): Promise<RefinePlanResult> {
  const { currentPlan, instruction, worktreePath, repository, githubToken, correlationId, originalContext } = options;
  const correlatedLogger = correlationId ? logger.withCorrelation(correlationId) : logger;

  if (!Array.isArray(currentPlan)) throw new PlanningFailedError('Current plan must be an array');

  // Load planner generation model from settings (refinement uses the generation model)
  const settings = await loadSettings();
  const generationModel = settings.planner_generation_model || DEFAULT_GENERATION_MODEL;
  correlatedLogger.info({ instruction, taskCount: currentPlan.length, repository, generationModel, hasOriginalContext: !!originalContext }, 'Refining plan');

  const contextSection = originalContext
    ? `\n\nOriginal Context (codebase details from initial plan generation):\n${originalContext}\n`
    : '';
  const userPrompt = `${REFINER_SYSTEM_PROMPT}${contextSection}\n\nCurrent Plan:\n${JSON.stringify(currentPlan, null, 2)}\n\nUser Request:\n"${instruction}"`;
  const [repoOwner, repoName] = repository.split('/');
  const issueRef = { number: 0, repoOwner: repoOwner || 'unknown', repoName: repoName || 'unknown' };

  const response = await runLightweightLLMAnalysis({ prompt: userPrompt, model: generationModel, correlationId: correlationId || 'plan-refinement', worktreePath, githubToken, issueRef });

  // Debug: log raw response (first 1000 chars) to diagnose parsing issues
  correlatedLogger.info({ responsePreview: response.substring(0, 1000), responseLength: response.length }, 'Raw LLM refinement response');

  let refinementResponse: RefinementResponse;
  try {
    refinementResponse = parseRefinementResponse(response, correlatedLogger);
  } catch (error) {
    if (error instanceof JsonParseError) {
      correlatedLogger.error({ error: error.message, responsePreview: response.substring(0, 500) }, 'Failed to parse refined plan');
      throw new PlanningFailedError(`Failed to parse refined plan: ${error.message}`);
    }
    throw error;
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
    summary: refinementResponse.summary
  };
}

// Re-export checkoutBranch for backwards compatibility
export { checkoutBranch } from './planningHelpers.js';

/**
 * Checks if all plan issues for a draft are merged and updates the draft status accordingly.
 * - If all issues are merged, sets draft status to 'merged'
 * - If not all issues are merged (e.g., one is reopened), reverts draft status to 'executed'
 *
 * @param draftId - The ID of the draft to check and update
 */
export async function checkAndUpdateDraftStatus(draftId: string): Promise<void> {
  if (!db) {
    logger.warn({ draftId }, 'Database not available, cannot check draft status');
    return;
  }

  try {
    // Get all plan issues for this draft
    const planIssues = await db('plan_issues')
      .where({ draft_id: draftId })
      .select('status');

    if (planIssues.length === 0) {
      logger.debug({ draftId }, 'No plan issues found for draft, skipping status check');
      return;
    }

    // Check if all issues are merged
    const allMerged = planIssues.every(issue => issue.status === 'merged');

    // Get current draft status
    const draft = await db('task_drafts')
      .where({ draft_id: draftId })
      .select('status')
      .first();

    if (!draft) {
      logger.warn({ draftId }, 'Draft not found, cannot update status');
      return;
    }

    // Determine the new status
    let newStatus: string | null = null;

    if (allMerged && draft.status !== 'merged') {
      newStatus = 'merged';
    } else if (!allMerged && draft.status === 'merged') {
      // Revert to 'executed' if not all issues are merged (e.g., one was reopened)
      newStatus = 'executed';
    }

    if (newStatus) {
      await db('task_drafts')
        .where({ draft_id: draftId })
        .update({
          status: newStatus,
          updated_at: db.fn.now()
        });

      logger.info(
        { draftId, oldStatus: draft.status, newStatus, totalIssues: planIssues.length, allMerged },
        'Updated draft status based on plan issue statuses'
      );
    }
  } catch (error) {
    const err = error as Error;
    logger.error({ draftId, error: err.message }, 'Failed to check and update draft status');
  }
}
