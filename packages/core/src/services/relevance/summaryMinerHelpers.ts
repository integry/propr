import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { Logger } from 'pino';
import logger from '../../utils/logger.js';
import { Agent } from '../../agents/types.js';
import { db } from '../../db/connection.js';
import { MODEL_LIMITS } from '../../config/modelLimits.js';
import type { GitFileInfo } from './summaryMiner.js';

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
}

/**
 * Processes files in batches, respecting token limits
 */
export async function processBatches(options: ProcessBatchesOptions): Promise<void> {
  const { repoPath, fullName, files, agent, log } = options;
  // Calculate budget based on model limits
  const modelId = agent.config.defaultModel || 'default';
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

      await processSingleBatch(fullName, currentBatch, agent, log);

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
    await processSingleBatch(fullName, currentBatch, agent, log);
  }

  log.info({ totalBatches: batchNumber }, 'Batch processing complete');
}

/**
 * Processes a single batch of files through the LLM
 */
async function processSingleBatch(
  fullName: string,
  batch: BatchFile[],
  agent: Agent,
  log: Logger
): Promise<void> {
  const prompt = buildBatchPrompt(batch);

  try {
    const response = await agent.analyze(prompt);
    const summaries = parseBatchResponse(response);

    // Save summaries to DB
    await saveBatchSummaries(fullName, batch, summaries, agent.config.alias);

    log.debug({ savedCount: summaries.length }, 'Saved batch summaries');
  } catch (error) {
    log.error(
      { error: (error as Error).message, fileCount: batch.length },
      'Failed to process batch'
    );
    // Continue with next batch instead of failing entirely
  }
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
      log.debug({ path: dirPath }, 'Updated directory summary');
    }
  } catch (error) {
    log.warn(
      { error: (error as Error).message, path: dirPath },
      'Failed to generate directory summary'
    );
  }
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
