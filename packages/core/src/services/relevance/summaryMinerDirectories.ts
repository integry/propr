import path from 'path';
import crypto from 'crypto';

import type { Logger } from 'pino';
import { Agent } from '../../agents/types.js';
import { db } from '../../db/connection.js';
import { logSummarizationCall } from './summaryMinerMetrics.js';
import { startDirectoryPhase, updateDirectoryProgress, publishProgress, isIndexingCancelled } from './indexingCancellation.js';
import { persistLlmLog, createLlmLogFromAnalysis } from '../../utils/llmLogger.js';
import { isQuotaExhaustionError, withRetry, type RetryOptions } from '../../utils/retryHandler.js';
import { MODEL_LIMITS } from '../../config/modelLimits.js';
import {
  clearSummarizationPrimaryQuotaFailures,
  recordPrimarySummarizationQuotaFailure,
  recordSummarizationCooldown
} from '../../config/configManager.js';
import type { IndexingProgress } from './indexingCancellation.js';
import type { SummarizationAgentConfig } from './summaryMinerHelpers.js';
import {
  type DirectoryInfo, type DirectoryResult,
  groupDirectoriesByDepth, extractDirectories, createDirectoryBatches,
  buildBatchDirectoryPrompt, parseBatchDirectoryResponse
} from './summaryMinerDirectoryHelpers.js';

const CHARS_PER_TOKEN_ESTIMATE = 3;
const BATCH_TOKEN_RATIO = 0.5;
const MAX_DIRS_PER_BATCH = 20;
const DIRECTORY_PROGRESS_PERCENT_STEP = 5;

// Retry transient agent failures (network blips, rate limits, 5xx) before
// treating a directory batch as failed. Mirrors the file-batch retry policy.
const SUMMARIZATION_RETRY = {
  maxAttempts: 3,
  baseDelay: 2000,
  maxDelay: 15000,
  exponentialBase: 2,
} as const;

const SUMMARIZATION_FALLBACK_RETRY = {
  ...SUMMARIZATION_RETRY,
  maxAttempts: 1
} as const;

export interface AggregateDirectoriesResult {
  totalBatches: number;
  failedBatches: number;
  dirsProcessed: number;
}

export interface AggregateDirectoriesOptions {
  fullName: string;
  agent: Agent;
  log: Logger;
  modelOverride?: string;
  resolveSummarizationConfig?: () => Promise<SummarizationAgentConfig>;
  branch?: string;
}

/** Aggregates file summaries into directory summaries (bottom-up), batching multiple directories per API call. */
export async function aggregateDirectories(options: AggregateDirectoriesOptions): Promise<AggregateDirectoriesResult> {
  const { fullName, agent, log, modelOverride, resolveSummarizationConfig, branch = 'HEAD' } = options;
  const fileSummaries = await db('file_summaries')
    .where('path', 'like', `${fullName}/%`)
    .andWhere({ branch })
    .select('path', 'summary', 'commit_hash');

  if (fileSummaries.length === 0) {
    log.debug('No file summaries to aggregate');
    return { totalBatches: 0, failedBatches: 0, dirsProcessed: 0 };
  }

  const directories = new Set(extractDirectories(fileSummaries.map(f => f.path)));
  const dirsByDepth = groupDirectoriesByDepth(Array.from(directories));
  const depths = Array.from(dirsByDepth.keys()).sort((a, b) => b - a);

  const totalDirs = Array.from(directories).length;
  log.info({ directoryCount: totalDirs, depthLevels: depths.length }, 'Aggregating directory summaries (batched)');
  await startDirectoryPhase(fullName, branch, totalDirs);

  const dirSummaryCache = new Map<string, string>();
  const modelId = modelOverride || agent.config.defaultModel || 'default';
  const maxTokens = MODEL_LIMITS[modelId] || MODEL_LIMITS['default'];
  const maxBatchTokens = Math.floor(maxTokens * BATCH_TOKEN_RATIO);

  let totalBatches = 0;
  let failedBatches = 0;
  let dirsProcessed = 0;
  const initialConfig: SummarizationAgentConfig = { agent, modelOverride, effectiveModel: modelId, agentAliasSetting: agent.config.alias };
  const getCurrentConfig = resolveSummarizationConfig ?? (async () => initialConfig);

  for (const depth of depths) {
    const dirsAtDepth = dirsByDepth.get(depth) || [];
    const dirsToProcess: DirectoryInfo[] = [];

    for (const dirPath of dirsAtDepth) {
      const dirInfo = await checkDirectoryNeedsUpdate(dirPath, fileSummaries, dirSummaryCache, branch);
      if (dirInfo) {
        dirsToProcess.push(dirInfo);
      } else {
        dirsProcessed += await handleSkippedDirectory(dirPath, branch, dirSummaryCache, fullName);
      }
    }

    if (dirsToProcess.length === 0) continue;

    const batches = createDirectoryBatches(dirsToProcess, maxBatchTokens, MAX_DIRS_PER_BATCH, CHARS_PER_TOKEN_ESTIMATE);
    totalBatches += batches.length;

    for (const batch of batches) {
      const currentConfig = await getCurrentConfig();
      logDirectoryBatchAgentIfChanged(log, initialConfig, currentConfig);
      const results = await processDirectoryBatch({
        directories: batch, agent: currentConfig.agent, log,
        modelOverride: currentConfig.modelOverride,
        modelUsed: currentConfig.effectiveModel || currentConfig.modelOverride || currentConfig.agent.config.defaultModel,
        primaryAgentAliasSetting: currentConfig.agentAliasSetting || currentConfig.agent.config.alias,
        fallbackAgent: currentConfig.fallbackAgent,
        fallbackModelOverride: currentConfig.fallbackModelOverride,
        fallbackModelUsed: currentConfig.fallbackEffectiveModel || currentConfig.fallbackModelOverride || currentConfig.fallbackAgent?.config.defaultModel,
        fallbackAgentAliasSetting: currentConfig.fallbackAgentAliasSetting,
        fullName,
        branch
      });

      // A batch that produced no summaries at all failed to aggregate; surface
      // it so indexRepo keeps the repo in 'failed' state and retries the
      // missing directories on the next scan instead of marking it complete.
      if (!results.some(r => r.summary)) {
        failedBatches++;
      }

      for (const result of results) {
        await saveBatchResult(result, batch, branch, dirSummaryCache);
        dirsProcessed++;
        await tryPublishDirectoryProgress(fullName, branch);
      }
    }
  }

  await deleteStaleDirectorySummaries(fullName, branch, directories, log);
  log.info({ directoryCount: totalDirs, batchCount: totalBatches, failedBatches, dirsProcessed }, 'Directory aggregation complete (batched)');

  return { totalBatches, failedBatches, dirsProcessed };
}

function logDirectoryBatchAgentIfChanged(log: Logger, initialConfig: SummarizationAgentConfig, currentConfig: SummarizationAgentConfig): void {
  const initialModel = initialConfig.modelOverride || initialConfig.agent.config.defaultModel || 'default';
  const currentModel = currentConfig.modelOverride || currentConfig.agent.config.defaultModel || 'default';
  if (initialConfig.agent.config.alias === currentConfig.agent.config.alias && initialModel === currentModel) return;

  log.info({
    previousAgentAlias: initialConfig.agent.config.alias, previousModel: initialModel,
    currentAgentAlias: currentConfig.agent.config.alias, currentModel
  }, 'Using updated summarization agent config for directory batch');
}

async function handleSkippedDirectory(dirPath: string, branch: string, dirSummaryCache: Map<string, string>, fullName: string): Promise<number> {
  const existing = await db('directory_summaries').where({ path: dirPath, branch }).first();
  if (existing) dirSummaryCache.set(dirPath, existing.summary);
  await tryPublishDirectoryProgress(fullName, branch);
  return 1;
}

async function saveBatchResult(result: DirectoryResult, batch: DirectoryInfo[], branch: string, dirSummaryCache: Map<string, string>): Promise<void> {
  if (!result.summary) return;
  const dirInfo = batch.find(d => d.dirPath === result.dirPath);
  if (!dirInfo) return;
  await saveDirectorySummary(result.dirPath, result.summary, dirInfo.newHash, branch);
  dirSummaryCache.set(result.dirPath, result.summary);
}

async function tryPublishDirectoryProgress(fullName: string, branch: string): Promise<void> {
  const progress = await updateDirectoryProgress(fullName, branch);
  if (progress && shouldPublishDirectoryProgress(progress) && !await isIndexingCancelled(fullName, branch)) {
    try { await publishProgress(fullName, branch, progress); } catch { /* best-effort */ }
  }
}

function shouldPublishDirectoryProgress(progress: IndexingProgress): boolean {
  if (progress.phase !== 'directories' || progress.totalDirectories <= 0) return false;
  if (progress.processedDirectories === 1 || progress.processedDirectories >= progress.totalDirectories) return true;
  const previousPercentBucket = Math.floor((((progress.processedDirectories - 1) / progress.totalDirectories) * 100) / DIRECTORY_PROGRESS_PERCENT_STEP);
  const currentPercentBucket = Math.floor(((progress.processedDirectories / progress.totalDirectories) * 100) / DIRECTORY_PROGRESS_PERCENT_STEP);
  return currentPercentBucket > previousPercentBucket;
}

async function deleteStaleDirectorySummaries(fullName: string, branch: string, directories: Set<string>, log: Logger): Promise<void> {
  const existingDirs = await db('directory_summaries')
    .where('path', 'like', `${fullName}/%`)
    .andWhere({ branch })
    .select('path');

  const dirsToDelete = existingDirs.map((d: { path: string }) => d.path).filter((p: string) => !directories.has(p));

  if (dirsToDelete.length > 0) {
    const CHUNK_SIZE = 500;
    for (let i = 0; i < dirsToDelete.length; i += CHUNK_SIZE) {
      await db('directory_summaries').whereIn('path', dirsToDelete.slice(i, i + CHUNK_SIZE)).andWhere({ branch }).delete();
    }
    log.info({ count: dirsToDelete.length }, 'Deleted stale directory summaries');
  }
}

async function checkDirectoryNeedsUpdate(
  dirPath: string,
  fileSummaries: Array<{ path: string; summary: string; commit_hash: string }>,
  dirSummaryCache: Map<string, string>,
  branch: string
): Promise<DirectoryInfo | null> {
  const childFiles = fileSummaries.filter(f => path.dirname(f.path) === dirPath);

  const immediateSubdirPaths = await db('directory_summaries')
    .where('path', 'like', `${dirPath}/%`)
    .whereRaw(`path NOT LIKE ?`, [`${dirPath}/%/%`])
    .andWhere({ branch })
    .select('path', 'summary', 'hash');

  const childDirs: Array<{ path: string; summary: string }> = [];
  for (const subdir of immediateSubdirPaths) {
    const cachedSummary = dirSummaryCache.get(subdir.path);
    childDirs.push({ path: subdir.path, summary: cachedSummary || subdir.summary });
  }

  if (childFiles.length === 0 && childDirs.length === 0) return null;

  const childrenData = [
    ...childFiles.map(f => `${f.path}:${f.commit_hash}`),
    ...immediateSubdirPaths.map(d => `${d.path}:${d.hash}`)
  ].sort().join('|');

  const newHash = crypto.createHash('sha256').update(childrenData).digest('hex').substring(0, 16);

  const existingDirSummary = await db('directory_summaries').where({ path: dirPath, branch }).first();
  if (existingDirSummary && existingDirSummary.hash === newHash) return null;

  return {
    dirPath,
    childFiles: childFiles.map(f => ({ path: f.path, summary: f.summary })),
    childDirs,
    newHash
  };
}

interface ProcessDirectoryBatchOptions {
  directories: DirectoryInfo[];
  agent: Agent;
  log: Logger;
  modelOverride?: string;
  modelUsed?: string;
  primaryAgentAliasSetting?: string;
  fallbackAgent?: Agent;
  fallbackModelOverride?: string;
  fallbackModelUsed?: string;
  fallbackAgentAliasSetting?: string;
  fullName: string;
  branch: string;
}

async function processDirectoryBatch(options: ProcessDirectoryBatchOptions): Promise<DirectoryResult[]> {
  const {
    directories, agent, log, modelOverride, modelUsed, primaryAgentAliasSetting,
    fallbackAgent, fallbackModelOverride, fallbackModelUsed, fallbackAgentAliasSetting, fullName, branch
  } = options;
  if (directories.length === 0) return [];

  const prompt = buildBatchDirectoryPrompt(directories);
  const startTime = Date.now();
  const estimatedInputTokens = Math.ceil(prompt.length / CHARS_PER_TOKEN_ESTIMATE);
  const estimatedOutputTokens = directories.length * 150;
  let modelLogged = modelUsed || modelOverride || agent.config.defaultModel || 'unknown';
  let agentUsed = agent;

  let success = false;
  let errorMessage: string | undefined;
  let results: DirectoryResult[] = [];

  try {
    try {
      results = await analyzeDirectoryBatchWithAgent({
        prompt, directories, agent, modelOverride, context: `directory_aggregation:${fullName}`
      });
      await clearSummarizationPrimaryQuotaFailures();
    } catch (primaryError) {
      if (!isQuotaExhaustionError(primaryError) || !fallbackAgent || !fallbackAgentAliasSetting) {
        throw primaryError;
      }

      await recordPrimarySummarizationQuotaFailure({
        primaryAgentAlias: primaryAgentAliasSetting || agent.config.alias,
        fallbackAgentAlias: fallbackAgentAliasSetting
      });
      log.warn({
        error: (primaryError as Error).message,
        primaryAgentAlias: agent.config.alias,
        fallbackAgentAlias: fallbackAgent.config.alias,
        fallbackModel: fallbackModelUsed
      }, 'Primary directory summarization model quota-limited; retrying batch with fallback');

      try {
        results = await analyzeDirectoryBatchWithAgent({
          prompt,
          directories,
          agent: fallbackAgent,
          modelOverride: fallbackModelOverride ?? fallbackModelUsed,
          context: `directory_aggregation_fallback:${fullName}`,
          retryOptions: SUMMARIZATION_FALLBACK_RETRY
        });
        agentUsed = fallbackAgent;
        modelLogged = fallbackModelUsed || fallbackAgent.config.defaultModel || 'unknown';
      } catch (fallbackError) {
        if (isQuotaExhaustionError(fallbackError)) {
          await recordSummarizationCooldown({
            repository: fullName,
            branch,
            primaryAgentAlias: primaryAgentAliasSetting || agent.config.alias,
            fallbackAgentAlias: fallbackAgentAliasSetting,
            reason: 'Primary and fallback directory summarization models are quota-limited.'
          });
        }
        throw fallbackError;
      }
    }
    success = results.some(r => r.summary !== null);
    log.debug({ batchSize: directories.length, successCount: results.filter(r => r.summary).length }, 'Processed directory batch');
  } catch (error) {
    errorMessage = (error as Error).message;
    log.warn({ error: errorMessage, batchSize: directories.length }, 'Failed to process directory batch');
    results = directories.map(d => ({ dirPath: d.dirPath, summary: null }));
  }

  const durationMs = Date.now() - startTime;

  await logSummarizationCall({
    timestamp: new Date().toISOString(), callType: 'directory_aggregation', model: modelLogged,
    agentAlias: agentUsed.config.alias, repository: fullName, estimatedInputTokens, estimatedOutputTokens,
    estimatedTotalTokens: estimatedInputTokens + estimatedOutputTokens,
    fileCount: directories.length, success, durationMs, error: errorMessage
  }, log);

  await persistLlmLog(createLlmLogFromAnalysis({
    executionType: 'summarization', modelUsed: modelLogged, executionTimeMs: durationMs, success,
    tokenUsage: { input_tokens: estimatedInputTokens, output_tokens: estimatedOutputTokens },
    error: errorMessage, repository: fullName, agentAlias: agentUsed.config.alias,
    metadata: { directoryCount: directories.length, phase: 'directory_aggregation' },
    workRef: { workType: 'repository', workRepository: fullName },
  }));

  return results;
}

async function analyzeDirectoryBatchWithAgent(options: {
  prompt: string;
  directories: DirectoryInfo[];
  agent: Agent;
  modelOverride?: string;
  context: string;
  retryOptions?: RetryOptions;
}): Promise<DirectoryResult[]> {
  const { prompt, directories, agent, modelOverride, context, retryOptions = SUMMARIZATION_RETRY } = options;
  return withRetry(
    async () => {
      const analysisResult = await agent.analyze(prompt, { model: modelOverride, responseFormat: 'json' });
      if (!analysisResult.success) {
        throw new Error(analysisResult.error || 'Directory summarization agent analysis failed');
      }
      const parsed = parseBatchDirectoryResponse(analysisResult.response, directories.map(d => d.dirPath));
      if (!parsed.some(r => r.summary !== null)) {
        throw new Error(`No valid directory summaries parsed for batch of ${directories.length} directories`);
      }
      return parsed;
    },
    retryOptions,
    context
  );
}

async function saveDirectorySummary(dirPath: string, summary: string, hash: string, branch: string): Promise<void> {
  await db('directory_summaries')
    .insert({ path: dirPath, branch, summary, hash, last_updated_at: db.fn.now() })
    .onConflict(['path', 'branch'])
    .merge({ summary, hash, last_updated_at: db.fn.now() });
}
