import fs from 'fs';
import path from 'path';
import type { Logger } from 'pino';
import { Agent } from '../../agents/types.js';
import { MODEL_LIMITS } from '../../config/modelLimits.js';
import type { GitFileInfo } from './summaryFileFilter.js';
import { getSummarizationMetricsSummary, getSummarizationCallHistory } from './summaryMinerMetrics.js';
import type { SummarizationCallMetrics, SummarizationMetricsSummary } from './summaryMinerMetrics.js';
import { aggregateDirectories } from './summaryMinerDirectories.js';
import { isIndexingCancelled, IndexingCancelledError, updateIndexingProgress, publishProgress } from './indexingCancellation.js';
import { isProcessableFile } from './summaryFileFilter.js';
import { processSingleBatch, type BatchFile } from './summaryMinerBatch.js';

// Re-export metrics types and functions for backwards compatibility
export { getSummarizationMetricsSummary, getSummarizationCallHistory };
export type { SummarizationCallMetrics, SummarizationMetricsSummary };

// Re-export directory aggregation for backwards compatibility
export { aggregateDirectories };
export { DEFAULT_INSTRUCTIONS } from './summaryMinerBatch.js';

// --- Types ---

export interface SummarizationAgentConfig {
  agent: Agent;
  modelOverride?: string;
  effectiveModel?: string;
  customPrompt?: string;
  agentAliasSetting?: string;
  fallbackAgent?: Agent;
  fallbackModelOverride?: string;
  fallbackEffectiveModel?: string;
  fallbackAgentAliasSetting?: string;
}

// --- Constants ---

const BATCH_TOKEN_RATIO = 0.8; // Upper bound based on model context size
const DEFAULT_MAX_BATCH_TOKENS = 100_000; // Keep prompts well below context limits so agents reliably return JSON
const DEFAULT_MAX_BATCH_FILES = 20; // Keep JSON responses reliable for repos with many small files
const CHARS_PER_TOKEN_ESTIMATE = 3; // Rough estimate: 3 chars per token

// --- Phase B: Batch Summarization ---

export interface ProcessBatchesOptions {
  repoPath: string;
  fullName: string;
  files: GitFileInfo[];
  agent: Agent;
  log: Logger;
  modelOverride?: string; // Optional model override for token budgeting and logging
  agentAliasSetting?: string;
  customPrompt?: string; // Optional custom prompt to override default instructions
  fallbackAgent?: Agent;
  fallbackModelOverride?: string;
  fallbackEffectiveModel?: string;
  fallbackAgentAliasSetting?: string;
  resolveSummarizationConfig?: () => Promise<SummarizationAgentConfig>;
  branch?: string; // Branch being indexed (defaults to 'HEAD')
}

export interface ProcessBatchesResult {
  totalBatches: number;
  successfulBatches: number;
  failedBatches: number;
  filesProcessed: number;
  filesFailed: number;
  fallbackUsed: boolean;
  stopProcessing: boolean;
  fallbackPrimaryAgentAlias?: string;
  fallbackAgentAlias?: string;
}

/**
 * Processes files in batches, respecting token limits
 * Returns stats about success/failure for proper status tracking
 */
// eslint-disable-next-line complexity
export async function processBatches(options: ProcessBatchesOptions): Promise<ProcessBatchesResult> {
  const {
    repoPath, fullName, files, agent, log, modelOverride, agentAliasSetting, customPrompt, resolveSummarizationConfig, branch = 'HEAD',
    fallbackAgent, fallbackModelOverride, fallbackEffectiveModel, fallbackAgentAliasSetting
  } = options;
  // Calculate budget based on model limits (use override if provided)
  const modelId = modelOverride || agent.config.defaultModel || 'default';
  const maxTokens = MODEL_LIMITS[modelId] || MODEL_LIMITS['default'];
  const maxBatchTokensCap = parseInt(process.env.SUMMARIZATION_MAX_BATCH_TOKENS || String(DEFAULT_MAX_BATCH_TOKENS), 10);
  const maxBatchTokens = Math.min(Math.floor(maxTokens * BATCH_TOKEN_RATIO), maxBatchTokensCap);
  const maxBatchFiles = parseInt(process.env.SUMMARIZATION_MAX_BATCH_FILES || String(DEFAULT_MAX_BATCH_FILES), 10);

  log.info({ maxBatchTokens, maxBatchTokensCap, maxBatchFiles, model: modelId }, 'Calculated batch budget');

  let currentBatch: BatchFile[] = [];
  let currentTokens = 0;
  let batchNumber = 0;
  let successfulBatches = 0;
  let failedBatches = 0;
  let filesProcessed = 0;
  let filesFailed = 0;
  let fallbackUsed = false;
  let stopProcessing = false;
  let fallbackPrimaryAgentAlias: string | undefined;
  let fallbackAgentAlias: string | undefined;

  const initialConfig: SummarizationAgentConfig = {
    agent,
    modelOverride,
    customPrompt,
    effectiveModel: modelId,
    agentAliasSetting: agentAliasSetting || agent.config.alias,
    fallbackAgent,
    fallbackModelOverride,
    fallbackEffectiveModel,
    fallbackAgentAliasSetting
  };
  const getCurrentConfig = resolveSummarizationConfig ?? (async () => initialConfig);

  for (const file of files) {
    // Check for cancellation before processing each file
    if (await isIndexingCancelled(fullName, branch)) {
      log.info({ repository: fullName }, 'Indexing cancelled by user');
      throw new IndexingCancelledError(fullName);
    }

    const filePath = path.join(repoPath, file.path);

    // Read file content
    let content: string;
    try {
      const stats = fs.statSync(filePath);
      if (!isProcessableFile(repoPath, file.path)) {
        log.debug({ path: file.path, size: stats.size }, 'Skipping non-summarizable file');
        continue;
      }
      content = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      log.debug({ path: file.path, error: (error as Error).message }, 'Failed to read file');
      continue;
    }

    const estimatedTokens = Math.ceil(content.length / CHARS_PER_TOKEN_ESTIMATE);

    // If adding this file would exceed batch limits, process current batch first
    if ((currentTokens + estimatedTokens > maxBatchTokens || currentBatch.length >= maxBatchFiles) && currentBatch.length > 0) {
      batchNumber++;
      log.info({ batchNumber, fileCount: currentBatch.length, tokens: currentTokens }, 'Processing batch');

      const currentConfig = await getCurrentConfig();
      logBatchAgentIfChanged(log, initialConfig, currentConfig);
      const currentModelId = currentConfig.effectiveModel || currentConfig.modelOverride || currentConfig.agent.config.defaultModel || 'default';
      const batchResult = await processSingleBatch({
        fullName,
        batch: currentBatch,
        agent: currentConfig.agent,
        log,
        modelUsed: currentModelId,
        customPrompt: currentConfig.customPrompt,
        primaryAgentAliasSetting: currentConfig.agentAliasSetting || currentConfig.agent.config.alias,
        fallbackAgent: currentConfig.fallbackAgent,
        fallbackModelOverride: currentConfig.fallbackModelOverride,
        fallbackModelUsed: currentConfig.fallbackEffectiveModel || currentConfig.fallbackModelOverride || currentConfig.fallbackAgent?.config.defaultModel,
        fallbackAgentAliasSetting: currentConfig.fallbackAgentAliasSetting,
        branch
      });
      const batchFileCount = currentBatch.length;
      const batchInputTokens = currentTokens;
      const batchOutputTokens = batchFileCount * 120; // ~120 tokens per file summary

      if (batchResult.fallbackUsed) {
        fallbackUsed = true;
        fallbackPrimaryAgentAlias ??= batchResult.primaryAgentAlias;
        fallbackAgentAlias ??= batchResult.fallbackAgentAlias;
      }
      stopProcessing ||= batchResult.stopProcessing;

      if (batchResult.success) {
        successfulBatches++;
        filesProcessed += batchFileCount;
      } else {
        failedBatches++;
        filesFailed += batchFileCount;
      }

      // Update progress tracking and publish in one step (avoids extra Redis read)
      const updatedProgress = await updateIndexingProgress(fullName, {
        filesProcessed: batchFileCount,
        batchCompleted: true,
        inputTokens: batchInputTokens,
        outputTokens: batchOutputTokens,
      }, branch);
      await publishBatchProgressIfActive(fullName, branch, updatedProgress);

      currentBatch = [];
      currentTokens = 0;
      if (stopProcessing) {
        return {
          totalBatches: batchNumber,
          successfulBatches,
          failedBatches,
          filesProcessed,
          filesFailed,
          fallbackUsed,
          stopProcessing,
          fallbackPrimaryAgentAlias,
          fallbackAgentAlias
        };
      }
    }

    // Add file to batch
    currentBatch.push({
      path: file.path,
      content,
      blobHash: file.blobHash
    });
    currentTokens += estimatedTokens;
  }

  // Process remaining batch
  if (currentBatch.length > 0) {
    // Check for cancellation before final batch
    if (await isIndexingCancelled(fullName, branch)) {
      log.info({ repository: fullName }, 'Indexing cancelled by user');
      throw new IndexingCancelledError(fullName);
    }

    batchNumber++;
    log.info({ batchNumber, fileCount: currentBatch.length, tokens: currentTokens }, 'Processing final batch');
    const currentConfig = await getCurrentConfig();
    logBatchAgentIfChanged(log, initialConfig, currentConfig);
    const currentModelId = currentConfig.effectiveModel || currentConfig.modelOverride || currentConfig.agent.config.defaultModel || 'default';
    const batchResult = await processSingleBatch({
      fullName,
      batch: currentBatch,
      agent: currentConfig.agent,
      log,
      modelUsed: currentModelId,
      customPrompt: currentConfig.customPrompt,
      primaryAgentAliasSetting: currentConfig.agentAliasSetting || currentConfig.agent.config.alias,
      fallbackAgent: currentConfig.fallbackAgent,
      fallbackModelOverride: currentConfig.fallbackModelOverride,
      fallbackModelUsed: currentConfig.fallbackEffectiveModel || currentConfig.fallbackModelOverride || currentConfig.fallbackAgent?.config.defaultModel,
      fallbackAgentAliasSetting: currentConfig.fallbackAgentAliasSetting,
      branch
    });
    const batchFileCount = currentBatch.length;
    const batchInputTokens = currentTokens;
    const batchOutputTokens = batchFileCount * 120; // ~120 tokens per file summary

    if (batchResult.fallbackUsed) {
      fallbackUsed = true;
      fallbackPrimaryAgentAlias ??= batchResult.primaryAgentAlias;
      fallbackAgentAlias ??= batchResult.fallbackAgentAlias;
    }
    stopProcessing ||= batchResult.stopProcessing;

    if (batchResult.success) {
      successfulBatches++;
      filesProcessed += batchFileCount;
    } else {
      failedBatches++;
      filesFailed += batchFileCount;
    }

    // Update progress tracking and publish in one step (avoids extra Redis read)
    const updatedProgress = await updateIndexingProgress(fullName, {
      filesProcessed: batchFileCount,
      batchCompleted: true,
      inputTokens: batchInputTokens,
      outputTokens: batchOutputTokens,
    }, branch);
    await publishBatchProgressIfActive(fullName, branch, updatedProgress);
  }

  log.info({ totalBatches: batchNumber, successfulBatches, failedBatches, filesProcessed, filesFailed }, 'Batch processing complete');

  return {
    totalBatches: batchNumber,
    successfulBatches,
    failedBatches,
    filesProcessed,
    filesFailed,
    fallbackUsed,
    stopProcessing,
    fallbackPrimaryAgentAlias,
    fallbackAgentAlias
  };
}

function logBatchAgentIfChanged(
  log: Logger,
  initialConfig: SummarizationAgentConfig,
  currentConfig: SummarizationAgentConfig
): void {
  const initialModel = initialConfig.effectiveModel || initialConfig.modelOverride || initialConfig.agent.config.defaultModel || 'default';
  const currentModel = currentConfig.effectiveModel || currentConfig.modelOverride || currentConfig.agent.config.defaultModel || 'default';
  if (initialConfig.agent.config.alias === currentConfig.agent.config.alias && initialModel === currentModel) {
    return;
  }

  log.info({
    previousAgentAlias: initialConfig.agent.config.alias,
    previousModel: initialModel,
    currentAgentAlias: currentConfig.agent.config.alias,
    currentModel
  }, 'Using updated summarization agent config for batch');
}

async function publishBatchProgressIfActive(
  repository: string,
  branch: string,
  progress: Awaited<ReturnType<typeof updateIndexingProgress>>
): Promise<void> {
  if (!progress || await isIndexingCancelled(repository, branch)) {
    return;
  }

  try { await publishProgress(repository, branch, progress); } catch { /* best-effort */ }
}
