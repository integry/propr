import path from 'path';
import crypto from 'crypto';
import type { Logger } from 'pino';
import { Agent } from '../../agents/types.js';
import { db } from '../../db/connection.js';
import { logSummarizationCall } from './summaryMinerMetrics.js';
import { startDirectoryPhase, updateDirectoryProgress, publishProgress } from './indexingCancellation.js';
import { persistLlmLog, createLlmLogFromAnalysis } from '../../utils/llmLogger.js';
import { MODEL_LIMITS } from '../../config/modelLimits.js';

// --- Constants ---

const CHARS_PER_TOKEN_ESTIMATE = 3; // Rough estimate: 3 chars per token
const BATCH_TOKEN_RATIO = 0.5; // Use 50% of max tokens for directory batches (smaller than file batches since prompts are shorter)
const MAX_DIRS_PER_BATCH = 20; // Cap directories per batch to keep responses manageable

// --- Types ---

interface DirectoryInfo {
  dirPath: string;
  childFiles: Array<{ path: string; summary: string }>;
  childDirs: Array<{ path: string; summary: string }>;
  newHash: string;
}

export interface AggregateDirectoriesOptions {
  fullName: string;
  agent: Agent;
  log: Logger;
  modelOverride?: string;
  branch?: string;
}

// --- Phase C: Directory Aggregation ---

/**
 * Aggregates file summaries into directory summaries (bottom-up)
 * Now batches multiple directories per API call for efficiency
 */
export async function aggregateDirectories(
  options: AggregateDirectoriesOptions
): Promise<void> {
  const { fullName, agent, log, modelOverride, branch = 'HEAD' } = options;
  // Get all file summaries for the specific branch
  const fileSummaries = await db('file_summaries')
    .where('path', 'like', `${fullName}/%`)
    .andWhere({ branch })
    .select('path', 'summary', 'commit_hash');

  if (fileSummaries.length === 0) {
    log.debug('No file summaries to aggregate');
    return;
  }

  // Extract unique directories and group by depth (deepest first for bottom-up processing)
  const directories = new Set(extractDirectories(fileSummaries.map(f => f.path)));
  const dirsByDepth = groupDirectoriesByDepth(Array.from(directories));

  // Get depths sorted deepest first
  const depths = Array.from(dirsByDepth.keys()).sort((a, b) => b - a);

  const totalDirs = Array.from(directories).length;
  log.info({ directoryCount: totalDirs, depthLevels: depths.length }, 'Aggregating directory summaries (batched)');

  // Start directory phase tracking
  await startDirectoryPhase(fullName, totalDirs);

  // Cache for directory summaries (populated as we process bottom-up)
  const dirSummaryCache = new Map<string, string>();

  // Calculate token budget
  const modelId = modelOverride || agent.config.defaultModel || 'default';
  const maxTokens = MODEL_LIMITS[modelId] || MODEL_LIMITS['default'];
  const maxBatchTokens = Math.floor(maxTokens * BATCH_TOKEN_RATIO);

  let totalBatches = 0;
  let dirsProcessed = 0;

  // Process each depth level (deepest first so children are available for parents)
  for (const depth of depths) {
    const dirsAtDepth = dirsByDepth.get(depth) || [];

    // Identify which directories need updating at this depth
    const dirsToProcess: DirectoryInfo[] = [];

    for (const dirPath of dirsAtDepth) {
      const dirInfo = await checkDirectoryNeedsUpdate(dirPath, fileSummaries, dirSummaryCache, branch);
      if (dirInfo) {
        dirsToProcess.push(dirInfo);
      } else {
        // Directory is up-to-date, load its summary into cache for parent use
        const existing = await db('directory_summaries').where({ path: dirPath, branch }).first();
        if (existing) {
          dirSummaryCache.set(dirPath, existing.summary);
        }
        dirsProcessed++;
        await updateDirectoryProgress(fullName);
        await publishProgress(fullName, branch);
      }
    }

    if (dirsToProcess.length === 0) {
      continue;
    }

    // Batch the directories at this depth level
    const batches = createDirectoryBatches(dirsToProcess, maxBatchTokens);
    totalBatches += batches.length;

    for (const batch of batches) {
      const results = await processDirectoryBatch({
        directories: batch,
        agent,
        log,
        modelOverride,
        fullName
      });

      // Save results and update cache
      for (const result of results) {
        const dirInfo = result.summary ? batch.find(d => d.dirPath === result.dirPath) : null;
        if (dirInfo && result.summary) {
          await saveDirectorySummary(result.dirPath, result.summary, dirInfo.newHash, branch);
          dirSummaryCache.set(result.dirPath, result.summary);
        }
        dirsProcessed++;
      }
      await updateDirectoryProgress(fullName);
      await publishProgress(fullName, branch);
    }
  }

  // Clean up stale directory summaries
  const existingDirs = await db('directory_summaries')
    .where('path', 'like', `${fullName}/%`)
    .andWhere({ branch })
    .select('path');

  const dirsToDelete = existingDirs
    .map((d: { path: string }) => d.path)
    .filter((p: string) => !directories.has(p));

  if (dirsToDelete.length > 0) {
    const CHUNK_SIZE = 500;
    for (let i = 0; i < dirsToDelete.length; i += CHUNK_SIZE) {
      const chunk = dirsToDelete.slice(i, i + CHUNK_SIZE);
      await db('directory_summaries')
        .whereIn('path', chunk)
        .andWhere({ branch })
        .delete();
    }
    log.info({ count: dirsToDelete.length }, 'Deleted stale directory summaries');
  }

  log.info({ directoryCount: totalDirs, batchCount: totalBatches, dirsProcessed }, 'Directory aggregation complete (batched)');
}

/**
 * Groups directories by their depth level
 */
function groupDirectoriesByDepth(directories: string[]): Map<number, string[]> {
  const byDepth = new Map<number, string[]>();

  for (const dir of directories) {
    const depth = dir.split('/').length;
    const existing = byDepth.get(depth) || [];
    existing.push(dir);
    byDepth.set(depth, existing);
  }

  return byDepth;
}

/**
 * Checks if a directory needs updating and returns its info if so
 */
async function checkDirectoryNeedsUpdate(
  dirPath: string,
  fileSummaries: Array<{ path: string; summary: string; commit_hash: string }>,
  dirSummaryCache: Map<string, string>,
  branch: string
): Promise<DirectoryInfo | null> {
  // Get immediate children (files)
  const childFiles = fileSummaries.filter(f => {
    const dir = path.dirname(f.path);
    return dir === dirPath;
  });

  // Get immediate subdirectory summaries from cache or DB
  const immediateSubdirPaths = await db('directory_summaries')
    .where('path', 'like', `${dirPath}/%`)
    .whereRaw(`path NOT LIKE ?`, [`${dirPath}/%/%`])
    .andWhere({ branch })
    .select('path', 'summary', 'hash');

  // Also check cache for newly processed subdirs
  const childDirs: Array<{ path: string; summary: string }> = [];
  for (const subdir of immediateSubdirPaths) {
    const cachedSummary = dirSummaryCache.get(subdir.path);
    childDirs.push({
      path: subdir.path,
      summary: cachedSummary || subdir.summary
    });
  }

  if (childFiles.length === 0 && childDirs.length === 0) {
    return null;
  }

  // Calculate hash of children state
  const childrenData = [
    ...childFiles.map(f => `${f.path}:${f.commit_hash}`),
    ...immediateSubdirPaths.map(d => `${d.path}:${d.hash}`)
  ].sort().join('|');

  const newHash = crypto.createHash('sha256').update(childrenData).digest('hex').substring(0, 16);

  // Check if directory summary needs updating
  const existingDirSummary = await db('directory_summaries')
    .where({ path: dirPath, branch })
    .first();

  if (existingDirSummary && existingDirSummary.hash === newHash) {
    // No changes needed
    return null;
  }

  return {
    dirPath,
    childFiles: childFiles.map(f => ({ path: f.path, summary: f.summary })),
    childDirs,
    newHash
  };
}

/**
 * Creates batches of directories respecting token limits
 */
function createDirectoryBatches(directories: DirectoryInfo[], maxBatchTokens: number): DirectoryInfo[][] {
  const batches: DirectoryInfo[][] = [];
  let currentBatch: DirectoryInfo[] = [];
  let currentTokens = 0;

  for (const dir of directories) {
    const promptText = buildSingleDirectoryPromptText(dir);
    const estimatedTokens = Math.ceil(promptText.length / CHARS_PER_TOKEN_ESTIMATE);

    // If this single directory exceeds budget, put it in its own batch
    if (estimatedTokens > maxBatchTokens) {
      if (currentBatch.length > 0) {
        batches.push(currentBatch);
        currentBatch = [];
        currentTokens = 0;
      }
      batches.push([dir]);
      continue;
    }

    // If adding this directory exceeds budget or batch size, start new batch
    if ((currentTokens + estimatedTokens > maxBatchTokens || currentBatch.length >= MAX_DIRS_PER_BATCH) && currentBatch.length > 0) {
      batches.push(currentBatch);
      currentBatch = [];
      currentTokens = 0;
    }

    currentBatch.push(dir);
    currentTokens += estimatedTokens;
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
}

/**
 * Builds the prompt text for a single directory (used for token estimation)
 */
function buildSingleDirectoryPromptText(dir: DirectoryInfo): string {
  const filesSection = dir.childFiles.length > 0
    ? `Files:\n${dir.childFiles.map(f => `- ${path.basename(f.path)}: ${f.summary}`).join('\n')}`
    : '';

  const dirsSection = dir.childDirs.length > 0
    ? `Subdirectories:\n${dir.childDirs.map(d => `- ${path.basename(d.path)}/: ${d.summary}`).join('\n')}`
    : '';

  return `Directory: "${dir.dirPath}"\n${filesSection}\n${dirsSection}`;
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

interface ProcessDirectoryBatchOptions {
  directories: DirectoryInfo[];
  agent: Agent;
  log: Logger;
  modelOverride?: string;
  fullName: string;
}

interface DirectoryResult {
  dirPath: string;
  summary: string | null;
}

/**
 * Processes a batch of directories in a single LLM call
 */
async function processDirectoryBatch(options: ProcessDirectoryBatchOptions): Promise<DirectoryResult[]> {
  const { directories, agent, log, modelOverride, fullName } = options;

  if (directories.length === 0) {
    return [];
  }

  const prompt = buildBatchDirectoryPrompt(directories);
  const startTime = Date.now();

  // Estimate tokens
  const estimatedInputTokens = Math.ceil(prompt.length / CHARS_PER_TOKEN_ESTIMATE);
  const estimatedOutputTokens = directories.length * 150; // ~150 tokens per directory summary

  const modelUsed = modelOverride || agent.config.defaultModel || 'unknown';

  let success = false;
  let errorMessage: string | undefined;
  let results: DirectoryResult[] = [];

  try {
    const analysisResult = await agent.analyze(prompt, { model: modelOverride });
    const response = analysisResult.response;
    results = parseBatchDirectoryResponse(response, directories.map(d => d.dirPath));
    success = results.some(r => r.summary !== null);
    log.debug({ batchSize: directories.length, successCount: results.filter(r => r.summary).length }, 'Processed directory batch');
  } catch (error) {
    errorMessage = (error as Error).message;
    log.warn(
      { error: errorMessage, batchSize: directories.length },
      'Failed to process directory batch'
    );
    // Return empty results for all directories
    results = directories.map(d => ({ dirPath: d.dirPath, summary: null }));
  }

  const durationMs = Date.now() - startTime;

  // Log the summarization call metrics (single call for entire batch)
  await logSummarizationCall({
    timestamp: new Date().toISOString(),
    callType: 'directory_aggregation',
    model: modelUsed,
    agentAlias: agent.config.alias,
    repository: fullName,
    estimatedInputTokens,
    estimatedOutputTokens,
    estimatedTotalTokens: estimatedInputTokens + estimatedOutputTokens,
    fileCount: directories.length, // reuse fileCount for directory count
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
    metadata: { directoryCount: directories.length, phase: 'directory_aggregation' },
    workRef: {
      workType: 'repository',
      workRepository: fullName,
    },
  });
  await persistLlmLog(logEntry);

  return results;
}

/**
 * Builds a batched prompt for multiple directory summaries
 */
function buildBatchDirectoryPrompt(directories: DirectoryInfo[]): string {
  const directorySections = directories.map(dir => {
    const filesSection = dir.childFiles.length > 0
      ? `  Files:\n${dir.childFiles.map(f => `    - ${path.basename(f.path)}: ${f.summary}`).join('\n')}`
      : '';

    const dirsSection = dir.childDirs.length > 0
      ? `  Subdirectories:\n${dir.childDirs.map(d => `    - ${path.basename(d.path)}/: ${d.summary}`).join('\n')}`
      : '';

    return `--- DIRECTORY: ${dir.dirPath} ---
${filesSection}
${dirsSection}
--- END DIRECTORY ---`;
  }).join('\n\n');

  return `You are a code expert. Analyze the following directories and provide a summary for each.
For each directory, provide a brief (2-4 sentences) summary of what it contains and its role in the codebase.

Return ONLY valid JSON in this exact format:
{
  "summaries": [
    { "path": "full/directory/path", "summary": "This directory contains... It provides... It is responsible for..." }
  ]
}

Important:
- Include ALL directories listed below in your response
- Each summary should be 2-4 sentences with specific details
- Focus on the directory's purpose and how it fits into the system
- Return valid JSON only, no markdown or other formatting

DIRECTORIES:
${directorySections}`;
}

/**
 * Parses the batched directory summary response
 */
function parseBatchDirectoryResponse(response: string, expectedPaths: string[]): DirectoryResult[] {
  const results: DirectoryResult[] = expectedPaths.map(p => ({ dirPath: p, summary: null }));

  try {
    // Try to extract JSON from the response
    const jsonMatch = response.match(/\{[\s\S]*"summaries"[\s\S]*\}/);
    if (!jsonMatch) {
      return results;
    }

    const parsed = JSON.parse(jsonMatch[0]) as { summaries: Array<{ path: string; summary: string }> };

    if (!parsed.summaries || !Array.isArray(parsed.summaries)) {
      return results;
    }

    // Map summaries back to expected paths
    const summaryMap = new Map<string, string>();
    for (const s of parsed.summaries) {
      if (typeof s.path === 'string' && typeof s.summary === 'string' && s.summary.trim().length > 0) {
        summaryMap.set(s.path.trim(), s.summary.trim());
      }
    }

    // Update results with found summaries
    for (const result of results) {
      const summary = summaryMap.get(result.dirPath);
      if (summary) {
        result.summary = summary;
      }
    }
  } catch {
    // Parse failed, return null summaries
  }

  return results;
}

/**
 * Saves a directory summary to the database
 */
async function saveDirectorySummary(dirPath: string, summary: string, hash: string, branch: string): Promise<void> {
  await db('directory_summaries')
    .insert({
      path: dirPath,
      branch,
      summary,
      hash,
      last_updated_at: db.fn.now()
    })
    .onConflict(['path', 'branch'])
    .merge({
      summary,
      hash,
      last_updated_at: db.fn.now()
    });
}
