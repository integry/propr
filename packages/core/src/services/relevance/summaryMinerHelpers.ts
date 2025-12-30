import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { Logger } from 'pino';
import logger from '../../utils/logger.js';
import { Agent } from '../../agents/types.js';
import { db } from '../../db/connection.js';
import { MODEL_LIMITS } from '../../config/modelLimits.js';
import type { GitFileInfo } from './summaryMiner.js';
import { Redis } from 'ioredis';

// --- Types ---

interface BatchFile {
  path: string;
  content: string;
  blobHash: string;
}

interface SummaryResult {
  path: string;
  summary: string;
}

/**
 * Metrics for a single summarization LLM call
 */
export interface SummarizationCallMetrics {
  timestamp: string;
  callType: 'batch_summarization' | 'directory_aggregation';
  model: string;
  agentAlias: string;
  repository?: string;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedTotalTokens: number;
  fileCount?: number;
  directoryPath?: string;
  success: boolean;
  durationMs: number;
  error?: string;
}

/**
 * Aggregated summarization metrics
 */
export interface SummarizationMetricsSummary {
  totalCalls: number;
  successfulCalls: number;
  failedCalls: number;
  totalEstimatedInputTokens: number;
  totalEstimatedOutputTokens: number;
  totalDurationMs: number;
  byModel: Record<string, {
    calls: number;
    inputTokens: number;
    outputTokens: number;
  }>;
}

// --- Constants ---

const BATCH_TOKEN_RATIO = 0.8; // Use 80% of max tokens for batch
const CHARS_PER_TOKEN_ESTIMATE = 3; // Rough estimate: 3 chars per token
const MAX_FILE_SIZE_BYTES = 100 * 1024; // 100KB max file size

const REDIS_HOST: string = process.env.REDIS_HOST ?? '127.0.0.1';
const REDIS_PORT: number = parseInt(process.env.REDIS_PORT ?? '6379', 10);

// --- Summarization Metrics Logging ---

/**
 * Logs a summarization LLM call to both the logger and Redis for tracking
 */
async function logSummarizationCall(metrics: SummarizationCallMetrics, log: Logger): Promise<void> {
  // Log to pino logger
  log.info({
    summarizationCall: true,
    callType: metrics.callType,
    model: metrics.model,
    agentAlias: metrics.agentAlias,
    repository: metrics.repository,
    estimatedInputTokens: metrics.estimatedInputTokens,
    estimatedOutputTokens: metrics.estimatedOutputTokens,
    estimatedTotalTokens: metrics.estimatedTotalTokens,
    fileCount: metrics.fileCount,
    directoryPath: metrics.directoryPath,
    success: metrics.success,
    durationMs: metrics.durationMs,
    error: metrics.error
  }, `Summarization LLM call: ${metrics.callType}`);

  // Store in Redis for aggregation
  let redis: InstanceType<typeof Redis> | null = null;
  try {
    redis = new Redis({
      host: REDIS_HOST,
      port: REDIS_PORT,
      maxRetriesPerRequest: null,
      enableReadyCheck: false
    });

    const dateKey = metrics.timestamp.split('T')[0];

    // Store individual call record (keep last 1000)
    await redis.lpush('summarization:calls:history', JSON.stringify(metrics));
    await redis.ltrim('summarization:calls:history', 0, 999);

    // Update aggregated metrics
    const successKey = metrics.success ? 'successful' : 'failed';
    await redis.incr('summarization:metrics:total:calls');
    await redis.incr(`summarization:metrics:total:${successKey}`);
    await redis.incr(`summarization:metrics:daily:${dateKey}:calls`);
    await redis.incr(`summarization:metrics:daily:${dateKey}:${successKey}`);

    // Track token usage
    const currentInputTokens = parseInt(await redis.get('summarization:metrics:total:inputTokens') ?? '0');
    await redis.set('summarization:metrics:total:inputTokens', currentInputTokens + metrics.estimatedInputTokens);

    const currentOutputTokens = parseInt(await redis.get('summarization:metrics:total:outputTokens') ?? '0');
    await redis.set('summarization:metrics:total:outputTokens', currentOutputTokens + metrics.estimatedOutputTokens);

    // Track by model
    await redis.incr(`summarization:metrics:model:${metrics.model}:calls`);
    const modelInputTokens = parseInt(await redis.get(`summarization:metrics:model:${metrics.model}:inputTokens`) ?? '0');
    await redis.set(`summarization:metrics:model:${metrics.model}:inputTokens`, modelInputTokens + metrics.estimatedInputTokens);
    const modelOutputTokens = parseInt(await redis.get(`summarization:metrics:model:${metrics.model}:outputTokens`) ?? '0');
    await redis.set(`summarization:metrics:model:${metrics.model}:outputTokens`, modelOutputTokens + metrics.estimatedOutputTokens);

    // Track total duration
    const currentDuration = parseInt(await redis.get('summarization:metrics:total:durationMs') ?? '0');
    await redis.set('summarization:metrics:total:durationMs', currentDuration + metrics.durationMs);

    // Track models used
    await redis.sadd('summarization:metrics:models:used', metrics.model);

    log.debug({ model: metrics.model, tokens: metrics.estimatedTotalTokens }, 'Summarization metrics stored in Redis');
  } catch (error) {
    // Don't fail the summarization if metrics logging fails
    log.warn({ error: (error as Error).message }, 'Failed to store summarization metrics in Redis');
  } finally {
    if (redis) {
      await redis.quit();
    }
  }
}

/**
 * Retrieves summarization metrics summary from Redis
 */
export async function getSummarizationMetricsSummary(): Promise<SummarizationMetricsSummary> {
  const redis = new Redis({
    host: REDIS_HOST,
    port: REDIS_PORT,
    maxRetriesPerRequest: null,
    enableReadyCheck: false
  });

  try {
    const totalCalls = parseInt(await redis.get('summarization:metrics:total:calls') ?? '0');
    const successfulCalls = parseInt(await redis.get('summarization:metrics:total:successful') ?? '0');
    const failedCalls = parseInt(await redis.get('summarization:metrics:total:failed') ?? '0');
    const totalEstimatedInputTokens = parseInt(await redis.get('summarization:metrics:total:inputTokens') ?? '0');
    const totalEstimatedOutputTokens = parseInt(await redis.get('summarization:metrics:total:outputTokens') ?? '0');
    const totalDurationMs = parseInt(await redis.get('summarization:metrics:total:durationMs') ?? '0');

    // Get model breakdown
    const modelsUsed = await redis.smembers('summarization:metrics:models:used');
    const byModel: Record<string, { calls: number; inputTokens: number; outputTokens: number }> = {};

    for (const model of modelsUsed) {
      const calls = parseInt(await redis.get(`summarization:metrics:model:${model}:calls`) ?? '0');
      const inputTokens = parseInt(await redis.get(`summarization:metrics:model:${model}:inputTokens`) ?? '0');
      const outputTokens = parseInt(await redis.get(`summarization:metrics:model:${model}:outputTokens`) ?? '0');
      byModel[model] = { calls, inputTokens, outputTokens };
    }

    return {
      totalCalls,
      successfulCalls,
      failedCalls,
      totalEstimatedInputTokens,
      totalEstimatedOutputTokens,
      totalDurationMs,
      byModel
    };
  } finally {
    await redis.quit();
  }
}

/**
 * Retrieves recent summarization call history from Redis
 */
export async function getSummarizationCallHistory(limit: number = 100): Promise<SummarizationCallMetrics[]> {
  const redis = new Redis({
    host: REDIS_HOST,
    port: REDIS_PORT,
    maxRetriesPerRequest: null,
    enableReadyCheck: false
  });

  try {
    const history = await redis.lrange('summarization:calls:history', 0, limit - 1);
    return history.map(entry => {
      try {
        return JSON.parse(entry) as SummarizationCallMetrics;
      } catch {
        return null;
      }
    }).filter((entry): entry is SummarizationCallMetrics => entry !== null);
  } finally {
    await redis.quit();
  }
}

// --- Phase B: Batch Summarization ---

export interface ProcessBatchesOptions {
  repoPath: string;
  fullName: string;
  files: GitFileInfo[];
  agent: Agent;
  log: Logger;
  modelOverride?: string; // Optional model override for token budgeting and logging
}

/**
 * Processes files in batches, respecting token limits
 */
export async function processBatches(options: ProcessBatchesOptions): Promise<void> {
  const { repoPath, fullName, files, agent, log, modelOverride } = options;
  // Calculate budget based on model limits (use override if provided)
  const modelId = modelOverride || agent.config.defaultModel || 'default';
  const maxTokens = MODEL_LIMITS[modelId] || MODEL_LIMITS['default'];
  const maxBatchTokens = Math.floor(maxTokens * BATCH_TOKEN_RATIO);

  log.info({ maxBatchTokens, model: modelId }, 'Calculated batch token budget');

  let currentBatch: BatchFile[] = [];
  let currentTokens = 0;
  let batchNumber = 0;

  for (const file of files) {
    const filePath = path.join(repoPath, file.path);

    // Read file content
    let content: string;
    try {
      const stats = fs.statSync(filePath);
      if (stats.size > MAX_FILE_SIZE_BYTES) {
        log.debug({ path: file.path, size: stats.size }, 'Skipping large file');
        continue;
      }
      content = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      log.debug({ path: file.path, error: (error as Error).message }, 'Failed to read file');
      continue;
    }

    const estimatedTokens = Math.ceil(content.length / CHARS_PER_TOKEN_ESTIMATE);

    // If adding this file would exceed budget, process current batch first
    if (currentTokens + estimatedTokens > maxBatchTokens && currentBatch.length > 0) {
      batchNumber++;
      log.info({ batchNumber, fileCount: currentBatch.length, tokens: currentTokens }, 'Processing batch');

      await processSingleBatch({ fullName, batch: currentBatch, agent, log, modelUsed: modelId });

      currentBatch = [];
      currentTokens = 0;
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
    batchNumber++;
    log.info({ batchNumber, fileCount: currentBatch.length, tokens: currentTokens }, 'Processing final batch');
    await processSingleBatch({ fullName, batch: currentBatch, agent, log, modelUsed: modelId });
  }

  log.info({ totalBatches: batchNumber }, 'Batch processing complete');
}

interface ProcessSingleBatchOptions {
  fullName: string;
  batch: BatchFile[];
  agent: Agent;
  log: Logger;
  modelUsed: string;
}

/**
 * Processes a single batch of files through the LLM
 */
async function processSingleBatch(options: ProcessSingleBatchOptions): Promise<void> {
  const { fullName, batch, agent, log, modelUsed } = options;
  const prompt = buildBatchPrompt(batch);
  const startTime = Date.now();

  // Estimate input tokens (prompt + file contents)
  const estimatedInputTokens = Math.ceil(prompt.length / CHARS_PER_TOKEN_ESTIMATE);
  // Estimate output tokens (roughly 50 tokens per file for summary JSON)
  const estimatedOutputTokens = batch.length * 50;

  let success = false;
  let errorMessage: string | undefined;

  try {
    const response = await agent.analyze(prompt);
    const summaries = parseBatchResponse(response);

    // Save summaries to DB with the actual model used
    await saveBatchSummaries(fullName, batch, summaries, modelUsed);

    success = true;
    log.debug({ savedCount: summaries.length }, 'Saved batch summaries');
  } catch (error) {
    errorMessage = (error as Error).message;
    log.error(
      { error: errorMessage, fileCount: batch.length },
      'Failed to process batch'
    );
    // Continue with next batch instead of failing entirely
  }

  const durationMs = Date.now() - startTime;

  // Log the summarization call metrics
  await logSummarizationCall({
    timestamp: new Date().toISOString(),
    callType: 'batch_summarization',
    model: modelUsed,
    agentAlias: agent.config.alias,
    repository: fullName,
    estimatedInputTokens,
    estimatedOutputTokens,
    estimatedTotalTokens: estimatedInputTokens + estimatedOutputTokens,
    fileCount: batch.length,
    success,
    durationMs,
    error: errorMessage
  }, log);
}

/**
 * Builds the prompt for batch summarization
 */
function buildBatchPrompt(batch: BatchFile[]): string {
  const filesContent = batch.map(f =>
    `--- START ${f.path} ---\n${f.content}\n--- END ${f.path} ---`
  ).join('\n\n');

  return `You are a code expert. Analyze the following source code files.
For each file, provide a concise (1-3 sentences) summary of its purpose and main functionality.

Return ONLY valid JSON in this exact format:
{
  "summaries": [
    { "path": "relative/path/to/file", "summary": "This file handles..." }
  ]
}

Important:
- Include ALL files listed below in your response
- Each summary should be brief but informative
- Focus on what the file does, not implementation details
- Return valid JSON only, no markdown or other formatting

FILES:
${filesContent}`;
}

/**
 * Parses the LLM response into individual summaries
 */
function parseBatchResponse(response: string): SummaryResult[] {
  try {
    // Try to extract JSON from the response
    const jsonMatch = response.match(/\{[\s\S]*"summaries"[\s\S]*\}/);
    if (!jsonMatch) {
      logger.warn('No JSON found in batch response');
      return [];
    }

    const parsed = JSON.parse(jsonMatch[0]) as { summaries: SummaryResult[] };

    if (!parsed.summaries || !Array.isArray(parsed.summaries)) {
      logger.warn('Invalid summaries format in response');
      return [];
    }

    // Validate and filter results
    return parsed.summaries
      .filter(s =>
        typeof s.path === 'string' &&
        typeof s.summary === 'string' &&
        s.path.trim().length > 0 &&
        s.summary.trim().length > 0
      )
      .map(s => ({
        path: s.path.trim(),
        summary: s.summary.trim()
      }));
  } catch (error) {
    logger.warn({ error: (error as Error).message }, 'Failed to parse batch response');
    return [];
  }
}

/**
 * Saves batch summaries to the database
 */
async function saveBatchSummaries(
  fullName: string,
  batch: BatchFile[],
  summaries: SummaryResult[],
  modelUsed: string
): Promise<void> {
  const summaryMap = new Map(summaries.map(s => [s.path, s.summary]));

  for (const file of batch) {
    const summary = summaryMap.get(file.path);
    if (!summary) {
      // LLM didn't return summary for this file, skip
      continue;
    }

    await db('file_summaries')
      .insert({
        path: file.path,
        summary,
        commit_hash: file.blobHash,
        model_used: modelUsed,
        last_updated_at: db.fn.now()
      })
      .onConflict('path')
      .merge({
        summary,
        commit_hash: file.blobHash,
        model_used: modelUsed,
        last_updated_at: db.fn.now()
      });
  }
}

// --- Phase C: Directory Aggregation ---

/**
 * Aggregates file summaries into directory summaries (bottom-up)
 */
export async function aggregateDirectories(
  fullName: string,
  agent: Agent,
  log: Logger
): Promise<void> {
  // Get all file summaries
  const fileSummaries = await db('file_summaries').select('path', 'summary', 'commit_hash');

  if (fileSummaries.length === 0) {
    log.debug('No file summaries to aggregate');
    return;
  }

  // Extract unique directories and sort by depth (deepest first)
  const directories = extractDirectories(fileSummaries.map(f => f.path));
  const sortedDirs = directories.sort((a, b) => {
    const depthA = a.split('/').length;
    const depthB = b.split('/').length;
    return depthB - depthA; // Deepest first
  });

  log.info({ directoryCount: sortedDirs.length }, 'Aggregating directory summaries');

  // Cache for directory summaries to avoid repeated DB lookups
  const dirSummaryCache = new Map<string, string>();

  for (const dir of sortedDirs) {
    await aggregateSingleDirectory({ dirPath: dir, fileSummaries, dirSummaryCache, agent, log });
  }

  log.info({ directoryCount: sortedDirs.length }, 'Directory aggregation complete');
}

/**
 * Extracts unique directory paths from file paths
 */
function extractDirectories(filePaths: string[]): string[] {
  const dirs = new Set<string>();

  for (const filePath of filePaths) {
    const parts = filePath.split('/');
    let currentPath = '';

    for (let i = 0; i < parts.length - 1; i++) {
      currentPath = currentPath ? `${currentPath}/${parts[i]}` : parts[i];
      dirs.add(currentPath);
    }
  }

  return Array.from(dirs);
}

interface AggregateDirOptions {
  dirPath: string;
  fileSummaries: Array<{ path: string; summary: string; commit_hash: string }>;
  dirSummaryCache: Map<string, string>;
  agent: Agent;
  log: Logger;
}

/**
 * Aggregates a single directory's children summaries
 */
async function aggregateSingleDirectory(options: AggregateDirOptions): Promise<void> {
  const { dirPath, fileSummaries, dirSummaryCache, agent, log } = options;
  // Get immediate children (files and subdirs)
  const childFiles = fileSummaries.filter(f => {
    const dir = path.dirname(f.path);
    return dir === dirPath;
  });

  // Get immediate subdirectory summaries
  const immediateSubdirs = await db('directory_summaries')
    .where('path', 'like', `${dirPath}/%`)
    .whereRaw(`path NOT LIKE ?`, [`${dirPath}/%/%`])
    .select('path', 'summary', 'hash');

  if (childFiles.length === 0 && immediateSubdirs.length === 0) {
    return;
  }

  // Calculate hash of children state
  const childrenData = [
    ...childFiles.map(f => `${f.path}:${f.commit_hash}`),
    ...immediateSubdirs.map(d => `${d.path}:${d.hash}`)
  ].sort().join('|');

  const newHash = crypto.createHash('sha256').update(childrenData).digest('hex').substring(0, 16);

  // Check if directory summary needs updating
  const existingDirSummary = await db('directory_summaries')
    .where({ path: dirPath })
    .first();

  if (existingDirSummary && existingDirSummary.hash === newHash) {
    // No changes, use cached summary
    dirSummaryCache.set(dirPath, existingDirSummary.summary);
    return;
  }

  // Build prompt for directory summarization
  const prompt = buildDirectorySummaryPrompt(dirPath, childFiles, immediateSubdirs);
  const startTime = Date.now();

  // Estimate input tokens (prompt content)
  const estimatedInputTokens = Math.ceil(prompt.length / CHARS_PER_TOKEN_ESTIMATE);
  // Estimate output tokens (directory summary is typically 100-200 tokens)
  const estimatedOutputTokens = 150;

  // Get the model being used (from agent config)
  const modelUsed = agent.config.defaultModel || 'unknown';

  let success = false;
  let errorMessage: string | undefined;

  try {
    const response = await agent.analyze(prompt);
    const summary = parseDirectorySummaryResponse(response);

    if (summary) {
      // Save to DB
      await db('directory_summaries')
        .insert({
          path: dirPath,
          summary,
          hash: newHash,
          last_updated_at: db.fn.now()
        })
        .onConflict('path')
        .merge({
          summary,
          hash: newHash,
          last_updated_at: db.fn.now()
        });

      dirSummaryCache.set(dirPath, summary);
      success = true;
      log.debug({ path: dirPath }, 'Updated directory summary');
    }
  } catch (error) {
    errorMessage = (error as Error).message;
    log.warn(
      { error: errorMessage, path: dirPath },
      'Failed to generate directory summary'
    );
  }

  const durationMs = Date.now() - startTime;

  // Log the summarization call metrics
  await logSummarizationCall({
    timestamp: new Date().toISOString(),
    callType: 'directory_aggregation',
    model: modelUsed,
    agentAlias: agent.config.alias,
    estimatedInputTokens,
    estimatedOutputTokens,
    estimatedTotalTokens: estimatedInputTokens + estimatedOutputTokens,
    directoryPath: dirPath,
    success,
    durationMs,
    error: errorMessage
  }, log);
}

/**
 * Builds prompt for directory summary generation
 */
function buildDirectorySummaryPrompt(
  dirPath: string,
  childFiles: Array<{ path: string; summary: string }>,
  childDirs: Array<{ path: string; summary: string }>
): string {
  const filesSection = childFiles.length > 0
    ? `Files:\n${childFiles.map(f => `- ${path.basename(f.path)}: ${f.summary}`).join('\n')}`
    : '';

  const dirsSection = childDirs.length > 0
    ? `Subdirectories:\n${childDirs.map(d => `- ${path.basename(d.path)}/: ${d.summary}`).join('\n')}`
    : '';

  return `Summarize the purpose of the directory "${dirPath}" based on its contents.

${filesSection}

${dirsSection}

Provide a brief (2-4 sentences) summary of what this directory contains and its role in the codebase.
Return ONLY the summary text, no JSON or other formatting.`;
}

/**
 * Parses the directory summary response
 */
function parseDirectorySummaryResponse(response: string): string | null {
  const trimmed = response.trim();

  // Remove any JSON wrapping if present
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      return parsed.summary || null;
    } catch {
      // Not JSON, use as-is
    }
  }

  return trimmed.length > 0 ? trimmed : null;
}
