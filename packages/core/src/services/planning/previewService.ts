/**
 * Context preview generation service.
 * Main entry point for generating context previews.
 */

import { db } from '../../db/connection.js';
import { TIKTOKEN_TO_CLAUDE_RATIO, getEffectiveTokenLimit, DEFAULT_CONTEXT_LEVEL, MAX_CONTEXT_LEVEL } from '../../config/modelLimits.js';
import { selectFilesWithinLimit, generateAdditionalContext } from '../contextService.js';
import logger from '../../utils/logger.js';

import { PlanningFailedError } from './planningErrors.js';
import { updateTrace } from './traceService.js';
import { buildFullContext, buildSmartSelection, getModelDisplayInfo } from './contextBuilders.js';
import { regenerateContext } from './contextRegeneration.js';
import {
  computeContentHash,
  parseDraftAttachments,
  parseExistingContextConfig,
  loadImagesFromAttachments,
  extractContextFromCache,
  getCacheInvalidationReason,
  calculateAttachmentTokens,
  calculateAdditionalContextBudget
} from './previewUtils.js';
import type {
  GenerateContextPreviewOptions,
  PreviewResult,
  TaskDraft,
  ContextCache,
  ContextData,
  ContextRepository,
  SmartFileSelection,
  MinimalLogger,
  AdditionalContextLoadResult
} from './planningTypes.js';

const DEFAULT_OUTPUT_TOKENS = 4000;
const SONNET_MODEL_ID = 'anthropic/claude-sonnet-4-20250514';

interface LoadAdditionalContextOptions {
  contextRepositories: ContextRepository[];
  tokenBudget: number;
  githubToken: string;
  correlationId?: string;
  correlatedLogger: MinimalLogger;
}

/**
 * Load additional context from context repositories.
 */
async function loadAdditionalContextFromRepos(opts: LoadAdditionalContextOptions): Promise<AdditionalContextLoadResult> {
  const { contextRepositories, tokenBudget, githubToken, correlationId, correlatedLogger } = opts;
  const warnings: string[] = [];
  let additionalContext: string | undefined;
  let additionalContextTokens = 0;
  let additionalContextFiles = 0;
  let additionalContextFilesIncluded: Array<{ repository: string; path: string }> = [];

  correlatedLogger.info({
    repositoryCount: contextRepositories.length,
    repositories: contextRepositories.map(r => r.repository),
    budgetTokens: tokenBudget
  }, 'Loading additional context from context repositories for preview');

  try {
    const additionalContextResult = await generateAdditionalContext({
      repositories: contextRepositories,
      tokenBudget,
      authToken: githubToken,
      correlationId
    });

    if (additionalContextResult.repositoriesIncluded.length > 0) {
      additionalContext = additionalContextResult.context;
      additionalContextTokens = additionalContextResult.totalTokens;
      additionalContextFiles = additionalContextResult.totalFiles;
      additionalContextFilesIncluded = additionalContextResult.filesIncluded;
      correlatedLogger.info({
        repositoriesIncluded: additionalContextResult.repositoriesIncluded,
        totalTokens: additionalContextResult.totalTokens,
        totalFiles: additionalContextResult.totalFiles,
        errors: additionalContextResult.errors
      }, 'Loaded additional context for preview');
    }

    for (const err of additionalContextResult.errors) {
      warnings.push(`Failed to load context from ${err.repository}: ${err.error}`);
    }
  } catch (error) {
    correlatedLogger.warn({ error: (error as Error).message }, 'Failed to load additional context repositories');
    warnings.push(`Failed to load context repositories: ${(error as Error).message}`);
  }

  return { additionalContext, additionalContextTokens, additionalContextFiles, additionalContextFilesIncluded, warnings };
}

/**
 * Calculate cost estimate for tokens
 */
async function calculateCostEstimate(
  tokens: number,
  warnings: string[],
  correlatedLogger: MinimalLogger
): Promise<number> {
  try {
    const { getModelPricing } = await import('../pricingService.js');
    const pricing = await getModelPricing(SONNET_MODEL_ID);
    if (pricing) {
      return tokens * pricing.prompt + DEFAULT_OUTPUT_TOKENS * pricing.completion;
    }
    warnings.push('Using fallback pricing - could not fetch current model pricing');
  } catch (err) {
    correlatedLogger.warn({ error: (err as Error).message }, 'Failed to get pricing');
    warnings.push('Using fallback pricing - pricing service error');
  }
  return (tokens / 1_000_000) * 3 + (DEFAULT_OUTPUT_TOKENS / 1_000_000) * 15;
}

interface GetContextDataParams {
  canUseCache: boolean;
  cache: ContextCache | undefined;
  draftId: string;
  baseBranch: string;
  worktreePath: string;
  prompt: string;
  manualFiles: string[];
  draft: TaskDraft;
  contextModel?: string;
  compress: boolean;
  maxTokenLimit: number;
  correlationId?: string;
  correlatedLogger: MinimalLogger;
  contentHash: string;
  cacheHasSufficientLimit: boolean;
}

/**
 * Get context data from cache or regenerate it.
 */
async function getContextData(params: GetContextDataParams): Promise<{ contextData: ContextData; warnings: string[] }> {
  const { canUseCache, cache, draftId, correlatedLogger, contentHash, cacheHasSufficientLimit, maxTokenLimit, ...regenParams } = params;
  const warnings: string[] = [];

  if (canUseCache && cache) {
    correlatedLogger.info({ contentHash }, 'Using cached context (only settings changed)');
    await updateTrace(draftId, 'relevance', 'completed', { source: 'cache' });
    await updateTrace(draftId, 'context', 'completed', { source: 'cache' });
    return { contextData: extractContextFromCache(cache), warnings };
  }

  const reason = getCacheInvalidationReason(cache, contentHash, cacheHasSufficientLimit, maxTokenLimit);
  correlatedLogger.info({ contentHash, hadCache: !!cache, reason }, 'Regenerating context at MAX_CONTEXT_LEVEL');
  const result = await regenerateContext({
    draftId,
    baseBranch: regenParams.baseBranch,
    worktreePath: regenParams.worktreePath,
    prompt: regenParams.prompt,
    manualFiles: regenParams.manualFiles,
    draft: regenParams.draft,
    contextModel: regenParams.contextModel,
    compress: regenParams.compress,
    previewTokenLimit: maxTokenLimit,
    correlationId: regenParams.correlationId,
    correlatedLogger
  });
  const contextData: ContextData = {
    repomixContext: result.repomixContext,
    smartSummaries: result.smartSummaries,
    autoFilePaths: result.autoFilePaths,
    includedFiles: result.includedFiles,
    repomixTokens: result.repomixTokens,
    smartSummaryTokens: result.smartSummaryTokens,
    fileTokenCounts: result.fileTokenCounts,
    fileScores: result.fileScores
  };
  warnings.push(...result.securityWarnings);
  return { contextData, warnings };
}

/**
 * Truncate a prompt to the first 2 sentences for the plan name/summary.
 */
export function truncateToSentences(text: string): string {
  const trimmed = text.trim();
  const maxSentences = 2;
  const sentencePattern = /[^.!?]+[.!?]+/g;
  const sentences: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = sentencePattern.exec(trimmed)) !== null && sentences.length < maxSentences) {
    sentences.push(match[0].trim());
  }

  if (sentences.length > 0) {
    return sentences.join(' ');
  }

  const maxLength = 200;
  if (trimmed.length <= maxLength) {
    return trimmed;
  }

  const truncated = trimmed.substring(0, maxLength);
  const lastSpace = truncated.lastIndexOf(' ');
  return (lastSpace > 0 ? truncated.substring(0, lastSpace) : truncated) + '...';
}

/**
 * Determine if the existing context cache can be reused.
 */
function isCacheValid(cache: ContextCache | undefined, contentHash: string, maxTokenLimit: number): boolean {
  if (!cache) return false;
  if (cache.contentHash !== contentHash) return false;
  if (!cache.fileTokenCounts || !cache.repomixContext) return false;
  if (cache.cachedMaxTokenLimit && cache.cachedMaxTokenLimit < maxTokenLimit) return false;
  return true;
}

/**
 * Generate a context preview for a draft.
 * Main entry point for the preview service.
 */
export async function generateContextPreview(options: GenerateContextPreviewOptions): Promise<PreviewResult> {
  const { draftId, prompt, baseBranch, granularity, contextLevel = DEFAULT_CONTEXT_LEVEL, compress = false, files, worktreePath, correlationId, contextModel, generationModel, contextRepositories, githubToken } = options;
  const targetTokenLimit = getEffectiveTokenLimit(generationModel, contextLevel);
  const maxTokenLimit = getEffectiveTokenLimit(generationModel, MAX_CONTEXT_LEVEL);
  const correlatedLogger = correlationId ? logger.withCorrelation(correlationId) : logger;
  const warnings: string[] = [];

  if (!db) throw new PlanningFailedError('Database not available');
  correlatedLogger.info({ draftId, baseBranch, granularity, contextModel, generationModel, targetTokenLimit, maxTokenLimit }, 'Starting context preview generation');

  const draft = await db<TaskDraft>('task_drafts').where({ draft_id: draftId }).first();
  if (!draft) throw new PlanningFailedError(`Draft not found: ${draftId}`);

  await updateTrace(draftId, 'relevance', 'pending');
  await updateTrace(draftId, 'context', 'pending');

  const attachments = parseDraftAttachments(draft.attachments);
  const existingConfig = parseExistingContextConfig(draft.context_config);
  const manualFiles = [...new Set([...(files || [])])];
  const contentHash = computeContentHash({
    prompt, baseBranch, compress, manualFiles,
    attachmentsJson: JSON.stringify(attachments.map(a => ({ id: a.id, storedPath: a.storedPath })))
  });

  const cache = existingConfig?.contextCache;
  const cacheHasSufficientLimit = !cache?.cachedMaxTokenLimit || cache.cachedMaxTokenLimit >= maxTokenLimit;
  const canUseCache = isCacheValid(cache, contentHash, maxTokenLimit);


  const { base64Images, imageTokens } = await loadImagesFromAttachments(attachments, correlatedLogger);
  const attachmentTokens = calculateAttachmentTokens(attachments, imageTokens);

  const { contextData, warnings: contextWarnings } = await getContextData({
    canUseCache: !!canUseCache, cache, draftId, baseBranch, worktreePath, prompt, manualFiles, draft, contextModel,
    compress, maxTokenLimit, correlationId, correlatedLogger, contentHash, cacheHasSufficientLimit
  });
  warnings.push(...contextWarnings);

  const { repomixContext, smartSummaries, autoFilePaths, includedFiles, smartSummaryTokens, fileTokenCounts, fileScores } = contextData;
  const combinedFiles = [...new Set([...manualFiles, ...autoFilePaths])];

  const reservedOverheadTiktokens = Math.ceil((attachmentTokens + smartSummaryTokens) / TIKTOKEN_TO_CLAUDE_RATIO);
  const fileSelectionLimit = Math.max(0, targetTokenLimit - reservedOverheadTiktokens);

  const simulatedSelection = selectFilesWithinLimit(
    fileTokenCounts, fileSelectionLimit,
    compress ? undefined : (combinedFiles.length > 0 ? combinedFiles : undefined),
    compress ? combinedFiles : undefined
  );

  const simulatedIncludedFiles = simulatedSelection.selectedFiles;
  const simulatedTokens = simulatedSelection.currentTokens;
  const includedFilesSet = new Set(simulatedIncludedFiles);

  correlatedLogger.info({
    cachedFiles: includedFiles.length, cachedTokens: contextData.repomixTokens,
    simulatedFiles: simulatedIncludedFiles.length, simulatedTokens, targetTokenLimit, fileSelectionLimit,
    reservedOverheadTiktokens, strategy: simulatedSelection.strategy
  }, 'Simulated file selection for context level');

  const costEstimate = await calculateCostEstimate(simulatedTokens, warnings, correlatedLogger);
  const smartSelection = buildSmartSelection(manualFiles, autoFilePaths, includedFilesSet, fileScores);

  // Load additional context from context repositories
  let additionalContext: string | undefined;
  let additionalContextTokens = 0;
  let additionalContextFiles = 0;
  let additionalContextFilesIncluded: Array<{ repository: string; path: string }> = [];
  if (contextRepositories?.length && githubToken) {
    const additionalContextBudget = calculateAdditionalContextBudget(targetTokenLimit, simulatedTokens, attachmentTokens, smartSummaryTokens);
    const result = await loadAdditionalContextFromRepos({ contextRepositories, tokenBudget: additionalContextBudget, githubToken, correlationId, correlatedLogger });
    additionalContext = result.additionalContext;
    additionalContextTokens = result.additionalContextTokens;
    additionalContextFiles = result.additionalContextFiles;
    additionalContextFilesIncluded = result.additionalContextFilesIncluded;
    warnings.push(...result.warnings);
  }

  const fullContext = buildFullContext({
    userRequest: prompt, repomixContext, granularity, smartSummaries,
    images: base64Images.length > 0 ? base64Images : undefined,
    additionalContext
  });

  // Store cache metadata including repomixContext and smartSummaries for cache reuse
  const cacheMetadata = {
    contentHash, autoFilePaths, includedFiles,
    repomixContext, smartSummaries,
    repomixTokens: contextData.repomixTokens, smartSummaryTokens, fileTokenCounts, cachedMaxTokenLimit: maxTokenLimit,
    fileScores
  };

  await db('task_drafts').where({ draft_id: draftId }).update({
    initial_prompt: prompt,
    name: truncateToSentences(prompt),
    context_config: JSON.stringify({ baseBranch, granularity, contextLevel, compress, manualFiles, autoFiles: autoFilePaths, contextRepositories, contextCache: cacheMetadata }),
    generated_context: fullContext,
    updated_at: db.fn.now()
  });

  const estimatedActualTokens = Math.ceil(simulatedTokens * TIKTOKEN_TO_CLAUDE_RATIO);
  const additionalContextTokensEstimated = Math.ceil(additionalContextTokens * TIKTOKEN_TO_CLAUDE_RATIO);
  const totalTokens = estimatedActualTokens + attachmentTokens + smartSummaryTokens + additionalContextTokensEstimated;
  const maxTokensEstimated = Math.ceil(targetTokenLimit * TIKTOKEN_TO_CLAUDE_RATIO);
  const { modelName, modelMaxContextTokens } = getModelDisplayInfo(generationModel);

  const contextRepoSelection: SmartFileSelection[] = additionalContextFilesIncluded.map(f => ({
    path: f.path,
    reason: 'Reference context',
    source: 'context-repo' as const,
    repository: f.repository
  }));
  const fullSmartSelection = [...smartSelection, ...contextRepoSelection];

  correlatedLogger.info({ usedCache: canUseCache, tiktokenCount: simulatedTokens, estimatedActualTokens, attachmentTokens, smartSummaryTokens, additionalContextTokens: additionalContextTokensEstimated, additionalContextFiles, totalTokens, maxTokensEstimated, costEstimate, fileCount: simulatedIncludedFiles.length, modelName, modelMaxContextTokens }, 'Context preview completed');

  return {
    success: true,
    stats: { totalTokens, tiktokenCount: simulatedTokens, costEstimate, contextLength: repomixContext.length, fileCount: simulatedIncludedFiles.length, contextRepoFileCount: additionalContextFiles, attachmentTokens, maxTokens: maxTokensEstimated, modelName, modelMaxContextTokens },
    smartSelection: fullSmartSelection,
    warnings
  };
}
