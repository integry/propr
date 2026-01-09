import path from 'path';
import crypto from 'crypto';
import type { Logger } from 'pino';
import { Agent } from '../../agents/types.js';
import { db } from '../../db/connection.js';
import { logSummarizationCall } from './summaryMinerMetrics.js';
import { startDirectoryPhase, updateDirectoryProgress } from './indexingCancellation.js';

// --- Constants ---

const CHARS_PER_TOKEN_ESTIMATE = 3; // Rough estimate: 3 chars per token

// --- Types ---

interface AggregateDirOptions {
  dirPath: string;
  fileSummaries: Array<{ path: string; summary: string; commit_hash: string }>;
  dirSummaryCache: Map<string, string>;
  agent: Agent;
  log: Logger;
  modelOverride?: string;
}

// --- Phase C: Directory Aggregation ---

/**
 * Aggregates file summaries into directory summaries (bottom-up)
 */
export async function aggregateDirectories(
  fullName: string,
  agent: Agent,
  log: Logger,
  modelOverride?: string
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

  // Start directory phase tracking
  await startDirectoryPhase(fullName, sortedDirs.length);

  // Cache for directory summaries to avoid repeated DB lookups
  const dirSummaryCache = new Map<string, string>();

  for (const dir of sortedDirs) {
    await aggregateSingleDirectory({ dirPath: dir, fileSummaries, dirSummaryCache, agent, log, modelOverride });
    // Update progress after each directory
    await updateDirectoryProgress(fullName);
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

/**
 * Aggregates a single directory's children summaries
 */
async function aggregateSingleDirectory(options: AggregateDirOptions): Promise<void> {
  const { dirPath, fileSummaries, dirSummaryCache, agent, log, modelOverride } = options;
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

  // Get the model being used (prefer override, fallback to agent config)
  const modelUsed = modelOverride || agent.config.defaultModel || 'unknown';

  let success = false;
  let errorMessage: string | undefined;

  try {
    const response = await agent.analyze(prompt, undefined, modelOverride);
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
