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

// --- Constants ---

const BATCH_TOKEN_RATIO = 0.8; // Use 80% of max tokens for batch
const CHARS_PER_TOKEN_ESTIMATE = 3; // Rough estimate: 3 chars per token
const MAX_FILE_SIZE_BYTES = 100 * 1024; // 100KB max file size

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
  // Estimate output tokens (roughly 120 tokens per file for 3-4 sentence summary JSON)
  const estimatedOutputTokens = batch.length * 120;

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
For each file, provide a summary (3-4 sentences) covering:
1. Primary purpose of the file
2. Key functions, classes, or exports it provides
3. What other parts of the system it interacts with or depends on

Return ONLY valid JSON in this exact format:
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

    // Store path with repo prefix for proper staleness detection
    const storedPath = `${fullName}/${file.path}`;

    await db('file_summaries')
      .insert({
        path: storedPath,
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
