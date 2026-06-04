/**
 * Task planning service - facade module that re-exports from the taskPlanning/ subdirectory.
 * This maintains backwards compatibility with existing imports.
 */

import { db } from '../db/connection.js';
import { loadFileSummaries } from './relevance/contextBuilder.js';
import logger from '../utils/logger.js';
import { PathValidationService } from './pathValidationService.js';
import {
  updateTrace, buildDraftUpdateTraceSnapshot, findFilesForPlan, parseContextConfig, checkoutBaseBranch, truncateToSentences
} from './planning/index.js';
import { getEventPublisher } from '../utils/eventPublisher.js';
import { loadSettings } from '../config/configManager.js';

// Re-export everything from the taskPlanning module
export * from './taskPlanning/index.js';

// Re-export from planning module
export { BranchNotFoundError, PlanningFailedError, buildFullContext } from './planning/index.js';
export type { SmartFileSelection, PreviewStats, PreviewResult, GenerateContextPreviewOptions } from './planning/index.js';
export { generateContextPreview } from './planning/index.js';
export { checkoutBranch } from './planning/index.js';
export type { Granularity, TaskDraftConfig, ContextRepository } from './planning/index.js';

// Import from taskPlanning for internal use
import {
  parseAttachments, loadImageAttachmentsAsBase64, parseDraftContextConfig,
  calculateTokenBudgets, generateContextWithRetry, callLLMForPlan, buildInitialChatHistory,
  type GeneratePlanOptions, type Plan, type TaskDraft
} from './taskPlanning/index.js';

/** Default model for context analysis (fast, cost-effective) */
const DEFAULT_CONTEXT_MODEL = 'haiku';

/** Default model for plan generation (high capability) */
const DEFAULT_GENERATION_MODEL = 'opus';

const MAX_ATTACHMENT_PERCENT = 0.25;
const BUDGET_SAFETY_FACTOR = 0.85;

function calculateMaxImageBytesForPlanning(tokenLimit: number, imageCount: number): number | undefined {
  if (imageCount <= 0) {
    return undefined;
  }
  const attachmentBudgetTokens = Math.floor(tokenLimit * BUDGET_SAFETY_FACTOR * MAX_ATTACHMENT_PERCENT);
  const perImageTokens = Math.max(1, Math.floor(attachmentBudgetTokens / imageCount));
  return Math.floor((perImageTokens * 3) / 1.1);
}

export async function generatePlan(options: GeneratePlanOptions): Promise<Plan> {
  const { draftId, worktreePath, githubToken, correlationId } = options;
  const correlatedLogger = correlationId ? logger.withCorrelation(correlationId) : logger;

  if (!db) throw new Error('Database not available');

  // Load planner models from settings (used as defaults)
  const settings = await loadSettings();
  const contextModel = settings.planner_context_model || DEFAULT_CONTEXT_MODEL;
  const defaultGenerationModel = settings.planner_generation_model || DEFAULT_GENERATION_MODEL;
  correlatedLogger.info({ draftId, contextModel, defaultGenerationModel }, 'Starting plan generation');

  const draft = await db<TaskDraft>('task_drafts').where({ draft_id: draftId }).first();
  if (!draft) throw new Error(`Draft not found: ${draftId}`);
  if (!draft.initial_prompt) throw new Error('Draft has no initial prompt');

  // Parse context_config - generationModel from draft config takes priority over global setting
  const parsedContextConfig = parseDraftContextConfig(draft.context_config, draftId, correlatedLogger);
  const config = parseContextConfig(parsedContextConfig, defaultGenerationModel);
  // Use the effective generation model: draft config > global setting
  const generationModel = config.generationModel || defaultGenerationModel;
  correlatedLogger.info({ draftId, granularity: config.granularity, contextLevel: config.contextLevel, tokenLimit: config.tokenLimit, rawContextLevel: parsedContextConfig?.contextLevel, generationModel, draftGenerationModel: config.generationModel }, 'Parsed context config for plan generation');

  // Parse and load attachments after context config so images can be sized for the selected token budget.
  const attachments = parseAttachments(draft.attachments);
  const imageAttachmentCount = attachments.filter(a => a.type === 'image').length;
  const maxImageBytes = calculateMaxImageBytesForPlanning(config.tokenLimit, imageAttachmentCount);
  const { images: base64Images, totalTokens: imageTokens } = await loadImageAttachmentsAsBase64(attachments, correlatedLogger, { maxImageBytes });
  const textAttachmentTokens = attachments.filter(a => a.type === 'text').reduce((sum, a) => sum + (a.tokenEstimate || 0), 0);
  const attachmentTokens = imageTokens + textAttachmentTokens;
  correlatedLogger.info({ attachmentCount: attachments.length, imageCount: base64Images.length, maxImageBytes, imageTokens, textAttachmentTokens, attachmentTokens }, 'Loaded attachments from draft');

  await checkoutBaseBranch(worktreePath, config.baseBranch, correlatedLogger);

  const relevantFilePaths = await findFilesForPlan({ draftId, worktreePath, draft, manualFiles: config.manualFiles, autoFiles: config.autoFiles, correlationId, contextModel });

  // Calculate estimated duration for context gathering based on file count
  const estimatedContextDuration = Math.min(5000 + (relevantFilePaths.length * 50), 30000);
  const contextStartedAt = new Date().toISOString();

  // Update trace with in_progress status and estimated duration
  await updateTrace(draftId, 'context', 'in_progress', {
    estimatedDuration: estimatedContextDuration,
    startedAt: contextStartedAt,
    fileCount: relevantFilePaths.length
  });
  correlatedLogger.info({ fileCount: relevantFilePaths.length, compress: config.compress, estimatedDurationMs: estimatedContextDuration }, 'Generating context');

  // Load and prepare file summaries
  const allSummaries = await loadFileSummaries();
  const repoPrefix = draft.repository + '/';
  const repoSummaries = allSummaries.filter(s => s.path.startsWith(repoPrefix)).map(s => ({ ...s, path: s.path.slice(repoPrefix.length) }));
  const summaryMap = new Map(repoSummaries.map(s => [s.path, s.summary]));
  const candidateSummaries = relevantFilePaths.map(p => { const summary = summaryMap.get(p); return summary ? { path: p, summary } : null; }).filter((item): item is { path: string; summary: string } => item !== null);
  const fullSummaryText = candidateSummaries.map(s => `FILE ${s.path}: ${s.summary}`).join('\n');

  // Calculate token budgets
  const budgets = calculateTokenBudgets({
    tokenLimit: config.tokenLimit, contextLevel: config.contextLevel, attachmentTokens, fullSummaryText,
    hasContextRepositories: !!(config.contextRepositories && config.contextRepositories.length > 0), correlatedLogger
  });

  // Generate context with retry logic
  const { fullContext, contextResult } = await generateContextWithRetry({
    worktreePath, config, relevantFilePaths, candidateSummaries, budgets, base64Images,
    draft, draftId, githubToken, correlationId, generationModel, contextModel, correlatedLogger
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

  const finalTrace = await updateTrace(draftId, 'llm', 'completed');

  const updatedContextConfig = { ...parsedContextConfig, granularityEnforcement: enforcementMetadata };

  // Build initial chat history with user prompt summary and assistant confirmation
  const chatHistory = buildInitialChatHistory(draft.initial_prompt, validatedPlan.length);
  correlatedLogger.info({ taskCount: validatedPlan.length, messageCount: chatHistory.length }, 'Built initial chat history for refinement');

  // Serialize chat history with error handling
  let chatHistoryJson: string;
  try {
    chatHistoryJson = JSON.stringify(chatHistory);
  } catch (error) {
    correlatedLogger.warn({ error: (error as Error).message }, 'Failed to serialize chat history, using empty array');
    chatHistoryJson = '[]';
  }

  await db('task_drafts').where({ draft_id: draftId }).update({
    plan_json: JSON.stringify(validatedPlan), context_config: JSON.stringify(updatedContextConfig),
    generated_context: fullContext, chat_history: chatHistoryJson, status: 'review',
    name: truncateToSentences(draft.initial_prompt), updated_at: db.fn.now()
  });

  // Emit final completion event so the UI can transition without polling
  const eventPublisher = getEventPublisher();
  const published = await eventPublisher.publishDraftUpdate({
    draftId,
    step: 'complete',
    status: 'completed',
    draftStatus: 'review',
    generationTrace: buildDraftUpdateTraceSnapshot(finalTrace)
  });
  if (!published) {
    correlatedLogger.warn('Failed to publish completion event — client will resync via safety-net poll');
  }

  return validatedPlan;
}
