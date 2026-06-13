import path from 'path';
import crypto from 'crypto';

import type { Logger } from 'pino';
import { Agent } from '../../agents/types.js';
import { db } from '../../db/connection.js';
import { startDirectoryPhase, updateDirectoryProgress, publishProgress, isIndexingCancelled } from './indexingCancellation.js';
import { MODEL_LIMITS } from '../../config/modelLimits.js';
import type { IndexingProgress } from './indexingCancellation.js';
import type { SummarizationAgentConfig } from './summaryMinerHelpers.js';
import {
  type DirectoryInfo, type DirectoryResult,
  groupDirectoriesByDepth, extractDirectories, createDirectoryBatches,
} from './summaryMinerDirectoryHelpers.js';
import { processDirectoryBatch } from './summaryMinerDirectoryBatch.js';

const CHARS_PER_TOKEN_ESTIMATE = 3;
const BATCH_TOKEN_RATIO = 0.5;
const MAX_DIRS_PER_BATCH = 20;
const DIRECTORY_PROGRESS_PERCENT_STEP = 5;

export interface AggregateDirectoriesResult {
  totalBatches: number;
  failedBatches: number;
  dirsProcessed: number;
  fallbackUsed: boolean;
  stopProcessing: boolean;
  fallbackPrimaryAgentAlias?: string;
  fallbackAgentAlias?: string;
}

export interface AggregateDirectoriesOptions {
  fullName: string;
  agent: Agent;
  log: Logger;
  modelOverride?: string;
  resolveSummarizationConfig?: () => Promise<SummarizationAgentConfig>;
  branch?: string;
}

interface DirectoryAggregationState {
  totalBatches: number;
  failedBatches: number;
  dirsProcessed: number;
  fallbackUsed: boolean;
  stopProcessing: boolean;
  fallbackPrimaryAgentAlias?: string;
  fallbackAgentAlias?: string;
}

interface ProcessDepthOptions {
  dirsAtDepth: string[];
  fileSummaries: Array<{ path: string; summary: string; commit_hash: string }>;
  dirSummaryCache: Map<string, string>;
  branch: string;
  fullName: string;
  maxBatchTokens: number;
  getCurrentConfig: () => Promise<SummarizationAgentConfig>;
  initialConfig: SummarizationAgentConfig;
  log: Logger;
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
    return { totalBatches: 0, failedBatches: 0, dirsProcessed: 0, fallbackUsed: false, stopProcessing: false };
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

  const state: DirectoryAggregationState = { totalBatches: 0, failedBatches: 0, dirsProcessed: 0, fallbackUsed: false, stopProcessing: false };
  const initialConfig: SummarizationAgentConfig = { agent, modelOverride, effectiveModel: modelId, agentAliasSetting: agent.config.alias };
  const getCurrentConfig = resolveSummarizationConfig ?? (async () => initialConfig);

  for (const depth of depths) {
    const depthResult = await processDirectoryDepth({
      dirsAtDepth: dirsByDepth.get(depth) || [],
      fileSummaries,
      dirSummaryCache,
      branch,
      fullName,
      maxBatchTokens,
      getCurrentConfig,
      initialConfig,
      log
    });
    state.totalBatches += depthResult.totalBatches;
    state.failedBatches += depthResult.failedBatches;
    state.dirsProcessed += depthResult.dirsProcessed;
    if (depthResult.fallbackUsed) {
      state.fallbackUsed = true;
      state.fallbackPrimaryAgentAlias ??= depthResult.fallbackPrimaryAgentAlias;
      state.fallbackAgentAlias ??= depthResult.fallbackAgentAlias;
    }
    state.stopProcessing ||= depthResult.stopProcessing;
    if (state.stopProcessing) break;
  }

  if (!state.stopProcessing) {
    await deleteStaleDirectorySummaries(fullName, branch, directories, log);
  }
  log.info({
    directoryCount: totalDirs,
    batchCount: state.totalBatches,
    failedBatches: state.failedBatches,
    dirsProcessed: state.dirsProcessed
  }, 'Directory aggregation complete (batched)');

  return state;
}

async function processDirectoryDepth(options: ProcessDepthOptions): Promise<DirectoryAggregationState> {
  const { dirsAtDepth, fileSummaries, dirSummaryCache, branch, fullName, maxBatchTokens } = options;
  const state: DirectoryAggregationState = { totalBatches: 0, failedBatches: 0, dirsProcessed: 0, fallbackUsed: false, stopProcessing: false };
  const dirsToProcess: DirectoryInfo[] = [];

  for (const dirPath of dirsAtDepth) {
    const dirInfo = await checkDirectoryNeedsUpdate(dirPath, fileSummaries, dirSummaryCache, branch);
    if (dirInfo) {
      dirsToProcess.push(dirInfo);
    } else {
      state.dirsProcessed += await handleSkippedDirectory(dirPath, branch, dirSummaryCache, fullName);
    }
  }

  const batches = createDirectoryBatches(dirsToProcess, maxBatchTokens, MAX_DIRS_PER_BATCH, CHARS_PER_TOKEN_ESTIMATE);
  state.totalBatches = batches.length;

  for (const batch of batches) {
    const batchResult = await processDirectoryAggregationBatch(batch, options);
    state.failedBatches += batchResult.failedBatches;
    state.dirsProcessed += batchResult.dirsProcessed;
    if (batchResult.fallbackUsed) {
      state.fallbackUsed = true;
      state.fallbackPrimaryAgentAlias ??= batchResult.fallbackPrimaryAgentAlias;
      state.fallbackAgentAlias ??= batchResult.fallbackAgentAlias;
    }
    state.stopProcessing ||= batchResult.stopProcessing;
    if (state.stopProcessing) break;
  }

  return state;
}

async function processDirectoryAggregationBatch(batch: DirectoryInfo[], options: ProcessDepthOptions): Promise<DirectoryAggregationState> {
  const { getCurrentConfig, initialConfig, log, fullName, branch, dirSummaryCache } = options;
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
  const failedBatches = results.some(r => r.summary) ? 0 : 1;

  for (const result of results) {
    await saveBatchResult(result, batch, branch, dirSummaryCache);
    await tryPublishDirectoryProgress(fullName, branch);
  }

  return {
    totalBatches: 0,
    failedBatches,
    dirsProcessed: results.length,
    fallbackUsed: results.fallbackUsed,
    stopProcessing: results.stopProcessing,
    fallbackPrimaryAgentAlias: results.primaryAgentAlias,
    fallbackAgentAlias: results.fallbackAgentAlias
  };
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

async function saveDirectorySummary(dirPath: string, summary: string, hash: string, branch: string): Promise<void> {
  await db('directory_summaries')
    .insert({ path: dirPath, branch, summary, hash, last_updated_at: db.fn.now() })
    .onConflict(['path', 'branch'])
    .merge({ summary, hash, last_updated_at: db.fn.now() });
}
