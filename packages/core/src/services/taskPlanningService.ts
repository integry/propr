/* eslint-disable max-lines */
import { db } from '../db/connection.js';
import { generateContext, generateAdditionalContext } from './contextService.js';
import { loadFileSummaries } from './relevance/contextBuilder.js';
import { runLightweightLLMAnalysis } from '../claude/claudeService.js';
import { REFINER_SYSTEM_PROMPT, Plan, PlanItem } from '../claude/prompts/plannerPrompts.js';
import { parseLlmJson, JsonParseError } from '../utils/jsonUtils.js';
import logger from '../utils/logger.js';
import { PathValidationService } from './pathValidationService.js';
import fs from 'fs-extra';
import path from 'path';
import {
  updateTrace, validatePromptTokens, CLAUDE_CODE_OVERHEAD, getDefaultModelLimit, findFilesForPlan,
  GenerationTrace, RELEVANT_SUMMARY_COUNT, RESERVED_OVERHEAD_TOKENS, CHARS_PER_TOKEN,
  parseContextConfig, checkoutBaseBranch, TaskDraftConfig, Granularity, PlanningFailedError, buildFullContext,
  Base64Image, MinimalLogger
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

/**
 * Load image attachments and convert them to base64
 */
async function loadImageAttachmentsAsBase64(
  attachments: Attachment[],
  correlatedLogger: MinimalLogger
): Promise<Base64Image[]> {
  const base64Images: Base64Image[] = [];
  const imageAttachments = attachments.filter(a => a.type === 'image');

  for (const img of imageAttachments) {
    try {
      const absolutePath = path.isAbsolute(img.storedPath)
        ? img.storedPath
        : path.join(process.cwd(), img.storedPath);
      const imageData = await fs.readFile(absolutePath);
      base64Images.push({
        name: img.originalName,
        mimeType: img.mimeType,
        base64Data: imageData.toString('base64'),
      });
      correlatedLogger.info({ imageName: img.originalName, size: imageData.length }, 'Loaded image attachment as base64');
    } catch (error) {
      correlatedLogger.warn({ imagePath: img.storedPath, error: (error as Error).message }, 'Failed to load image attachment');
    }
  }

  return base64Images;
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
  attachments?: string | Attachment[];
  status: string;
  created_at: Date;
  updated_at: Date;
}

export type { Granularity, TaskDraftConfig, ContextRepository } from './planningHelpers.js';

interface CallLLMOptions {
  draftId: string;
  context: string;
  prompt: string;
  granularity: Granularity;
  worktreePath: string;
  githubToken: string;
  repository: string;
  correlationId?: string;
  /** Optional file summaries for files not fully included in the context */
  fileSummaries?: string;
  /** Optional base64-encoded images to include in the prompt */
  images?: Base64Image[];
  /** Model to use for plan generation (e.g., 'opus', 'claude:claude-opus-4-5-20251101') */
  model?: string;
  /** Optional context from additional repositories (marked as example/reference only) */
  additionalContext?: string;
}

interface CallLLMForPlanResult {
  plan: Plan;
  enforcementMetadata: GranularityEnforcementMetadata;
}

async function callLLMForPlan(opts: CallLLMOptions): Promise<CallLLMForPlanResult> {
  const { draftId, context, prompt, granularity, worktreePath, githubToken, repository, correlationId, fileSummaries, images, model = DEFAULT_GENERATION_MODEL, additionalContext } = opts;
  const correlatedLogger = correlationId ? logger.withCorrelation(correlationId) : logger;
  await updateTrace(draftId, 'llm', 'pending');

  // Build prompt with images embedded as base64 and additional context from context repositories
  const userPrompt = buildFullContext({ userRequest: prompt, repomixContext: context, granularity, fileSummaries, images, additionalContext });
  correlatedLogger.info({ hasImages: !!(images && images.length > 0), imageCount: images?.length || 0, model, hasAdditionalContext: !!additionalContext }, 'Calling LLM for plan generation');

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
  const response = await runLightweightLLMAnalysis({ prompt: userPrompt, model, correlationId: correlationId || 'plan-generation', worktreePath, githubToken, issueRef });

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

export async function generatePlan(options: GeneratePlanOptions): Promise<Plan> {
  const { draftId, worktreePath, githubToken, correlationId } = options;
  const correlatedLogger = correlationId ? logger.withCorrelation(correlationId) : logger;

  if (!db) throw new PlanningFailedError('Database not available');

  // Load planner models from settings
  const settings = await loadSettings();
  const contextModel = settings.planner_context_model || DEFAULT_CONTEXT_MODEL;
  const generationModel = settings.planner_generation_model || DEFAULT_GENERATION_MODEL;
  correlatedLogger.info({ draftId, contextModel, generationModel }, 'Starting plan generation');

  const draft = await db<TaskDraft>('task_drafts').where({ draft_id: draftId }).first();
  if (!draft) throw new PlanningFailedError(`Draft not found: ${draftId}`);
  if (!draft.initial_prompt) throw new PlanningFailedError('Draft has no initial prompt');

  // Parse and load attachments
  const attachments = parseAttachments(draft.attachments);
  const base64Images = await loadImageAttachmentsAsBase64(attachments, correlatedLogger);
  const attachmentTokens = attachments.reduce((sum, a) => sum + (a.tokenEstimate || 0), 0);
  correlatedLogger.info({ attachmentCount: attachments.length, imageCount: base64Images.length, attachmentTokens }, 'Loaded attachments from draft');

  // Parse context_config
  const parsedContextConfig = parseDraftContextConfig(draft.context_config, draftId, correlatedLogger);
  const config = parseContextConfig(parsedContextConfig);
  correlatedLogger.info({ draftId, granularity: config.granularity }, 'Using granularity setting for plan generation');
  await checkoutBaseBranch(worktreePath, config.baseBranch, correlatedLogger);

  const relevantFilePaths = await findFilesForPlan({ draftId, worktreePath, draft, manualFiles: config.manualFiles, autoFiles: config.autoFiles, correlationId, contextModel });

  await updateTrace(draftId, 'context', 'pending');
  correlatedLogger.info({ fileCount: relevantFilePaths.length, compress: config.compress }, 'Generating context');

  // Load all file summaries and prepare the top relevant ones
  const allSummaries = await loadFileSummaries();
  const repoPrefix = draft.repository + '/';

  // Filter summaries to this repository and strip the prefix
  const repoSummaries = allSummaries
    .filter(s => s.path.startsWith(repoPrefix))
    .map(s => ({ ...s, path: s.path.slice(repoPrefix.length) }));

  // Create a map for quick lookup
  const summaryMap = new Map(repoSummaries.map(s => [s.path, s.summary]));

  // Get the top N most relevant files for summary inclusion
  const topRelevantFiles = relevantFilePaths.slice(0, RELEVANT_SUMMARY_COUNT);

  // Prepare candidate summaries for the relevant files
  const candidateSummaries = topRelevantFiles
    .map(path => {
      const summary = summaryMap.get(path);
      return summary ? { path, summary } : null;
    })
    .filter((item): item is { path: string; summary: string } => item !== null);

  // Calculate token cost for summaries (3 chars per token estimate)
  const fullSummaryText = candidateSummaries
    .map(s => `FILE ${s.path}: ${s.summary}`)
    .join('\n');
  const summaryTokenCost = Math.ceil(fullSummaryText.length / CHARS_PER_TOKEN);

  // Calculate reduced token limit for repomix context (subtract attachments, summaries, overhead)
  const availableForContext = config.tokenLimit - attachmentTokens - summaryTokenCost - RESERVED_OVERHEAD_TOKENS;
  const repomixTokenLimit = Math.max(5000, availableForContext);

  // Warn if attachments consume more than 50% of token budget
  if (attachmentTokens > config.tokenLimit * 0.5) {
    correlatedLogger.warn({
      attachmentTokens,
      tokenLimit: config.tokenLimit,
      percentUsed: Math.round((attachmentTokens / config.tokenLimit) * 100)
    }, 'Attachments consuming significant portion of token budget');
  }

  // Error if there's not enough room for context
  if (availableForContext < 5000) {
    throw new PlanningFailedError(
      `Attachments use ${attachmentTokens} tokens, leaving insufficient room for code context. ` +
      `Try removing large images or increasing the context level.`
    );
  }

  correlatedLogger.info({
    totalLimit: config.tokenLimit,
    attachmentTokens,
    summaryCost: summaryTokenCost,
    repomixLimit: repomixTokenLimit,
    candidateSummaryCount: candidateSummaries.length
  }, 'Calculated token budgets');

  // When compression is enabled, include all files but prioritize relevant ones
  const filesToInclude = config.compress ? undefined : (relevantFilePaths.length > 0 ? relevantFilePaths : undefined);
  const priorityFiles = config.compress ? relevantFilePaths : undefined;

  // Generate context with reduced token limit to make room for summaries
  const contextResult = await generateContext({
    repoPath: worktreePath,
    filesToInclude,
    priorityFiles,
    tokenLimit: repomixTokenLimit,
    compress: config.compress,
    correlationId
  });
  await updateTrace(draftId, 'context', 'completed', { includedFiles: contextResult.includedFiles, tokenCount: contextResult.totalTokens });

  // Filter summaries: Only include descriptions for files NOT fully included in repomix context
  const includedFilesSet = new Set(contextResult.includedFiles);
  const filteredSummaries = candidateSummaries
    .filter(s => !includedFilesSet.has(s.path))
    .map(s => `FILE ${s.path}: ${s.summary}`)
    .join('\n');

  correlatedLogger.info({
    totalCandidates: candidateSummaries.length,
    includedInContext: contextResult.includedFiles.length,
    summariesIncluded: candidateSummaries.filter(s => !includedFilesSet.has(s.path)).length
  }, 'Filtered summaries for context enrichment');

  // Generate additional context from context repositories if configured
  let additionalContext: string | undefined;
  if (config.contextRepositories && config.contextRepositories.length > 0) {
    correlatedLogger.info({
      repositoryCount: config.contextRepositories.length,
      repositories: config.contextRepositories.map(r => r.repository)
    }, 'Generating additional context from context repositories');

    // Allocate 20% of the remaining token budget for additional context
    const additionalContextBudget = Math.floor(config.tokenLimit * 0.2);

    try {
      const additionalContextResult = await generateAdditionalContext({
        repositories: config.contextRepositories,
        tokenBudget: additionalContextBudget,
        authToken: githubToken,
        correlationId
      });

      if (additionalContextResult.repositoriesIncluded.length > 0) {
        additionalContext = additionalContextResult.context;
        correlatedLogger.info({
          repositoriesIncluded: additionalContextResult.repositoriesIncluded,
          totalTokens: additionalContextResult.totalTokens,
          errorCount: additionalContextResult.errors.length
        }, 'Additional context generated successfully');

        // Update trace with additional context info
        await updateTrace(draftId, 'additional_context', 'completed', {
          repositoriesIncluded: additionalContextResult.repositoriesIncluded,
          totalTokens: additionalContextResult.totalTokens,
          errors: additionalContextResult.errors
        });
      }

      if (additionalContextResult.errors.length > 0) {
        correlatedLogger.warn({
          errors: additionalContextResult.errors
        }, 'Some context repositories could not be processed');
      }
    } catch (error) {
      correlatedLogger.warn({
        error: (error as Error).message
      }, 'Failed to generate additional context, continuing without it');
    }
  }

  const { plan, enforcementMetadata } = await callLLMForPlan({
    draftId,
    context: contextResult.context,
    prompt: draft.initial_prompt,
    granularity: config.granularity,
    worktreePath,
    githubToken,
    repository: draft.repository,
    correlationId,
    fileSummaries: filteredSummaries,
    images: base64Images.length > 0 ? base64Images : undefined,
    model: generationModel,
    additionalContext,
  });

  correlatedLogger.info({ taskCount: plan.length }, 'Validating and repairing file paths');
  const validatedPlan = await PathValidationService.validateAndRepair(worktreePath, plan, { correlationId });
  correlatedLogger.info({ taskCount: validatedPlan.length }, 'Plan generated successfully');

  // Add trace step for granularity enforcement if tasks were merged
  if (enforcementMetadata.enforced) {
    await updateTrace(draftId, 'granularity_enforcement', 'completed', {
      originalTaskCount: enforcementMetadata.originalTaskCount,
      finalTaskCount: enforcementMetadata.finalTaskCount,
      granularity: enforcementMetadata.granularity,
      message: enforcementMetadata.message
    });
    correlatedLogger.info(
      { originalTaskCount: enforcementMetadata.originalTaskCount, finalTaskCount: enforcementMetadata.finalTaskCount },
      'Granularity enforcement applied - added trace step'
    );
  }

  await updateTrace(draftId, 'llm', 'completed');

  // Merge enforcement metadata into context_config for UI display
  // Use the already-parsed config (parsedContextConfig) instead of raw string
  const updatedContextConfig = {
    ...parsedContextConfig,
    granularityEnforcement: enforcementMetadata
  };

  await db('task_drafts').where({ draft_id: draftId }).update({
    plan_json: JSON.stringify(validatedPlan),
    context_config: JSON.stringify(updatedContextConfig),
    status: 'review',
    updated_at: db.fn.now()
  });

  return validatedPlan;
}

export async function refinePlan(options: RefinePlanOptions): Promise<Plan> {
  const { currentPlan, instruction, worktreePath, repository, githubToken, correlationId } = options;
  const correlatedLogger = correlationId ? logger.withCorrelation(correlationId) : logger;

  if (!Array.isArray(currentPlan)) throw new PlanningFailedError('Current plan must be an array');

  // Load planner generation model from settings (refinement uses the generation model)
  const settings = await loadSettings();
  const generationModel = settings.planner_generation_model || DEFAULT_GENERATION_MODEL;
  correlatedLogger.info({ instruction, taskCount: currentPlan.length, repository, generationModel }, 'Refining plan');

  const userPrompt = `${REFINER_SYSTEM_PROMPT}\n\nCurrent Plan:\n${JSON.stringify(currentPlan, null, 2)}\n\nInstruction:\n"${instruction}"\n\nRemember: Return ONLY the updated JSON array. No markdown, no explanations.`;
  const [repoOwner, repoName] = repository.split('/');
  const issueRef = { number: 0, repoOwner: repoOwner || 'unknown', repoName: repoName || 'unknown' };

  const response = await runLightweightLLMAnalysis({ prompt: userPrompt, model: generationModel, correlationId: correlationId || 'plan-refinement', worktreePath, githubToken, issueRef });

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
