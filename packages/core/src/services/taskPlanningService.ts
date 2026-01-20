import { db } from '../db/connection.js';
import { generateContext } from './contextService.js';
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

/**
 * Merge multiple plan items into a single comprehensive task.
 * Used when granularity is 'single' but the LLM returned multiple tasks.
 */
function mergePlanItemsIntoOne(plan: Plan, correlatedLogger: MinimalLogger): Plan {
  if (plan.length <= 1) return plan;

  correlatedLogger.info({ originalTaskCount: plan.length }, 'Merging multiple tasks into single task (granularity enforcement)');

  // Create a merged title that captures all tasks
  const mergedTitle = plan.length <= 3
    ? plan.map(item => item.title).join(' & ')
    : `${plan[0].title} (and ${plan.length - 1} more changes)`;

  // Merge bodies with clear separation
  const mergedBody = plan.map((item, index) => {
    return `## Part ${index + 1}: ${item.title}\n\n${item.body}`;
  }).join('\n\n---\n\n');

  // Merge implementations with clear file/section separation
  const mergedImplementation = plan.map((item, index) => {
    return `// ========== Part ${index + 1}: ${item.title} ==========\n\n${item.implementation}`;
  }).join('\n\n');

  const mergedItem: PlanItem = {
    title: mergedTitle,
    body: mergedBody,
    implementation: mergedImplementation
  };

  return [mergedItem];
}

/**
 * Enforce granularity constraints on the generated plan.
 * - For 'single': Merge multiple tasks into one if needed
 * - For 'balanced': Log warning if outside 2-4 range
 * - For 'granular': Log warning if less than expected
 */
function enforceGranularityConstraints(
  plan: Plan,
  granularity: Granularity,
  correlatedLogger: MinimalLogger
): Plan {
  switch (granularity) {
    case 'single':
      if (plan.length > 1) {
        correlatedLogger.warn(
          { taskCount: plan.length, expected: 1 },
          'LLM returned multiple tasks for single granularity - merging into one'
        );
        return mergePlanItemsIntoOne(plan, correlatedLogger);
      }
      return plan;

    case 'balanced':
      if (plan.length < 2 || plan.length > 4) {
        correlatedLogger.info(
          { taskCount: plan.length, expectedRange: '2-4' },
          'Plan task count outside balanced range (informational)'
        );
      }
      return plan;

    case 'granular':
      if (plan.length < 5) {
        correlatedLogger.info(
          { taskCount: plan.length, expectedMinimum: 5 },
          'Plan has fewer tasks than expected for granular mode (informational)'
        );
      }
      return plan;

    default:
      return plan;
  }
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

export type { Granularity, TaskDraftConfig } from './planningHelpers.js';

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
}

async function callLLMForPlan(opts: CallLLMOptions): Promise<Plan> {
  const { draftId, context, prompt, granularity, worktreePath, githubToken, repository, correlationId, fileSummaries, images } = opts;
  const correlatedLogger = correlationId ? logger.withCorrelation(correlationId) : logger;
  await updateTrace(draftId, 'llm', 'pending');

  // Build prompt with images embedded as base64
  const userPrompt = buildFullContext({ userRequest: prompt, repomixContext: context, granularity, fileSummaries, images });
  correlatedLogger.info({ hasImages: !!(images && images.length > 0), imageCount: images?.length || 0 }, 'Calling LLM for plan generation');

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

  // Enforce granularity constraints (e.g., merge multiple tasks into one for 'single' mode)
  plan = enforceGranularityConstraints(plan, granularity, correlatedLogger);

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

  // Parse attachments from draft (stored as JSON string in SQLite)
  let attachments: Attachment[] = [];
  if (typeof draft.attachments === 'string') {
    try { attachments = JSON.parse(draft.attachments); } catch { attachments = []; }
  } else if (Array.isArray(draft.attachments)) {
    attachments = draft.attachments;
  }

  // Load and convert image attachments to base64
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
      correlatedLogger.debug({ imageName: img.originalName, size: imageData.length }, 'Loaded image attachment as base64');
    } catch (error) {
      correlatedLogger.warn({ imagePath: img.storedPath, error: (error as Error).message }, 'Failed to load image attachment');
    }
  }

  correlatedLogger.info({ attachmentCount: attachments.length, imageCount: base64Images.length }, 'Loaded attachments from draft');

  const config = parseContextConfig(draft.context_config as TaskDraftConfig | null);
  await checkoutBaseBranch(worktreePath, config.baseBranch, correlatedLogger);

  const relevantFilePaths = await findFilesForPlan({ draftId, worktreePath, draft, manualFiles: config.manualFiles, autoFiles: config.autoFiles, correlationId });

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

  // Calculate reduced token limit for repomix context
  const repomixTokenLimit = Math.max(
    5000, // Minimum budget for context
    config.tokenLimit - summaryTokenCost - RESERVED_OVERHEAD_TOKENS
  );

  correlatedLogger.info({
    totalLimit: config.tokenLimit,
    summaryCost: summaryTokenCost,
    repomixLimit: repomixTokenLimit,
    candidateSummaryCount: candidateSummaries.length
  }, 'Calculated token budgets for summaries');

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

  const plan = await callLLMForPlan({
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
  });

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
