import fs from 'fs';
import path from 'path';
import type { Logger } from 'pino';
import logger from '../../utils/logger.js';
import { Agent } from '../../agents/types.js';
import { db } from '../../db/connection.js';
import { MODEL_LIMITS } from '../../config/modelLimits.js';
import type { GitFileInfo } from './summaryMiner.js';
import {
  logSummarizationCall,
  getSummarizationMetricsSummary,
  getSummarizationCallHistory
} from './summaryMinerMetrics.js';
import type { SummarizationCallMetrics, SummarizationMetricsSummary } from './summaryMinerMetrics.js';
import { aggregateDirectories } from './summaryMinerDirectories.js';
import { isIndexingCancelled, IndexingCancelledError, updateIndexingProgress, publishProgress } from './indexingCancellation.js';
import { persistLlmLog, createLlmLogFromAnalysis } from '../../utils/llmLogger.js';

// Re-export metrics types and functions for backwards compatibility
export { getSummarizationMetricsSummary, getSummarizationCallHistory };
export type { SummarizationCallMetrics, SummarizationMetricsSummary };

// Re-export directory aggregation for backwards compatibility
export { aggregateDirectories };

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

interface SaveBatchSummariesOptions {
  fullName: string;
  batch: BatchFile[];
  summaries: SummaryResult[];
  modelUsed: string;
  branch: string;
}

// --- Constants ---

const BATCH_TOKEN_RATIO = 0.8; // Upper bound based on model context size
const DEFAULT_MAX_BATCH_TOKENS = 100_000; // Keep prompts well below context limits so agents reliably return JSON
const CHARS_PER_TOKEN_ESTIMATE = 3; // Rough estimate: 3 chars per token
const MAX_FILE_SIZE_BYTES = 100 * 1024; // 100KB max file size

// Default instructions for the summarization prompt (exported for UI display)
export const DEFAULT_INSTRUCTIONS = `You are a code expert. Analyze the following source code files.
For each file, provide a summary (3-4 sentences) covering:
1. Primary purpose of the file
2. Key functions, classes, or exports it provides
3. What other parts of the system it interacts with or depends on`;

// Strict JSON format rules that must always be appended to preserve parsing
const JSON_FORMAT_RULES = `Return ONLY valid JSON in this exact format:
{
  "summaries": [
    { "path": "relative/path/to/file", "summary": "This file handles... It provides... It interacts with..." }
  ]
}

Important:
- Include ALL files listed below in your response
- Each summary should be 3-4 sentences with specific details
- Mention key function/class names when relevant
- Focus on what the file does and how it connects to the system
- Return valid JSON only, no markdown or other formatting`;

// --- Phase B: Batch Summarization ---

export interface ProcessBatchesOptions {
  repoPath: string;
  fullName: string;
  files: GitFileInfo[];
  agent: Agent;
  log: Logger;
  modelOverride?: string; // Optional model override for token budgeting and logging
  customPrompt?: string; // Optional custom prompt to override default instructions
  branch?: string; // Branch being indexed (defaults to 'HEAD')
}

export interface ProcessBatchesResult {
  totalBatches: number;
  successfulBatches: number;
  failedBatches: number;
  filesProcessed: number;
  filesFailed: number;
}

/**
 * Processes files in batches, respecting token limits
 * Returns stats about success/failure for proper status tracking
 */
export async function processBatches(options: ProcessBatchesOptions): Promise<ProcessBatchesResult> {
  const { repoPath, fullName, files, agent, log, modelOverride, customPrompt, branch = 'HEAD' } = options;
  // Calculate budget based on model limits (use override if provided)
  const modelId = modelOverride || agent.config.defaultModel || 'default';
  const maxTokens = MODEL_LIMITS[modelId] || MODEL_LIMITS['default'];
  const maxBatchTokensCap = parseInt(process.env.SUMMARIZATION_MAX_BATCH_TOKENS || String(DEFAULT_MAX_BATCH_TOKENS), 10);
  const maxBatchTokens = Math.min(Math.floor(maxTokens * BATCH_TOKEN_RATIO), maxBatchTokensCap);

  log.info({ maxBatchTokens, maxBatchTokensCap, model: modelId }, 'Calculated batch token budget');

  let currentBatch: BatchFile[] = [];
  let currentTokens = 0;
  let batchNumber = 0;
  let successfulBatches = 0;
  let failedBatches = 0;
  let filesProcessed = 0;
  let filesFailed = 0;

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

      const success = await processSingleBatch({ fullName, batch: currentBatch, agent, log, modelUsed: modelId, customPrompt, branch });
      const batchFileCount = currentBatch.length;
      const batchInputTokens = currentTokens;
      const batchOutputTokens = batchFileCount * 120; // ~120 tokens per file summary

      if (success) {
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
    const success = await processSingleBatch({ fullName, batch: currentBatch, agent, log, modelUsed: modelId, customPrompt, branch });
    const batchFileCount = currentBatch.length;
    const batchInputTokens = currentTokens;
    const batchOutputTokens = batchFileCount * 120; // ~120 tokens per file summary

    if (success) {
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
    filesFailed
  };
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

interface ProcessSingleBatchOptions {
  fullName: string;
  batch: BatchFile[];
  agent: Agent;
  log: Logger;
  modelUsed: string;
  customPrompt?: string;
  branch: string;
}

/**
 * Processes a single batch of files through the LLM
 * Returns true if successful, false if failed
 */
async function processSingleBatch(options: ProcessSingleBatchOptions): Promise<boolean> {
  const { fullName, batch, agent, log, modelUsed, customPrompt, branch } = options;
  const prompt = buildBatchPrompt(batch, customPrompt);
  const startTime = Date.now();

  // Estimate input tokens (prompt + file contents)
  const estimatedInputTokens = Math.ceil(prompt.length / CHARS_PER_TOKEN_ESTIMATE);
  // Estimate output tokens (roughly 120 tokens per file for 3-4 sentence summary JSON)
  const estimatedOutputTokens = batch.length * 120;

  let success = false;
  let errorMessage: string | undefined;

  try {
    const analysisResult = await agent.analyze(prompt, { model: modelUsed, responseFormat: 'json' });
    const response = analysisResult.response;
    const summaries = parseBatchResponse(response);

    if (summaries.length === 0) {
      throw new Error(`No valid summaries parsed for batch of ${batch.length} files`);
    }

    // Save summaries to DB with the actual model used
    await saveBatchSummaries({ fullName, batch, summaries, modelUsed, branch });

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

  // Persist to llm_logs table
  const logEntry = createLlmLogFromAnalysis({
    executionType: 'summarization',
    modelUsed,
    executionTimeMs: durationMs,
    success,
    tokenUsage: {
      input_tokens: estimatedInputTokens,
      output_tokens: estimatedOutputTokens,
    },
    error: errorMessage,
    repository: fullName,
    agentAlias: agent.config.alias,
    workRef: {
      workType: 'repository',
      workRepository: fullName,
    },
  });
  await persistLlmLog(logEntry);

  return success;
}

/**
 * Builds the prompt for batch summarization
 */
function buildBatchPrompt(batch: BatchFile[], customPrompt?: string): string {
  const filesContent = batch.map(f =>
    `--- START ${f.path} ---\n${f.content}\n--- END ${f.path} ---`
  ).join('\n\n');

  // Use custom prompt if provided and non-empty, otherwise use default instructions
  const instructions = customPrompt && customPrompt.trim().length > 0
    ? customPrompt
    : DEFAULT_INSTRUCTIONS;

  return `${instructions}

${JSON_FORMAT_RULES}

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
async function saveBatchSummaries(options: SaveBatchSummariesOptions): Promise<void> {
  const { fullName, batch, summaries, modelUsed, branch } = options;
  const summaryMap = new Map(summaries.map(s => [s.path, s.summary]));

  for (const file of batch) {
    const summary = summaryMap.get(file.path);
    if (!summary) {
      // LLM didn't return summary for this file, skip
      continue;
    }

    // Store path with repo prefix for proper staleness detection
    const storedPath = `${fullName}/${file.path}`;

    await db('file_summaries')
      .insert({
        path: storedPath,
        branch,
        summary,
        commit_hash: file.blobHash,
        model_used: modelUsed,
        last_updated_at: db.fn.now()
      })
      .onConflict(['path', 'branch'])
      .merge({
        summary,
        commit_hash: file.blobHash,
        model_used: modelUsed,
        last_updated_at: db.fn.now()
      });
  }
}
