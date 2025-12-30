import { simpleGit, SimpleGit } from 'simple-git';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { Logger } from 'pino';
import logger, { generateCorrelationId } from '../../utils/logger.js';
import { AgentRegistry } from '../../agents/AgentRegistry.js';
import { Agent } from '../../agents/types.js';
import { db } from '../../db/connection.js';
import { loadSummarizationSettings } from '../../config/configManager.js';
import { MODEL_LIMITS } from '../../config/modelLimits.js';

// --- Types ---

export interface FileSummary {
  path: string;
  summary: string;
  commit_hash: string;
  model_used: string | null;
  last_updated_at: Date;
}

export interface DirectorySummary {
  path: string;
  summary: string;
  hash: string;
  last_updated_at: Date;
}

export interface GitFileInfo {
  path: string;
  blobHash: string;
}

export interface IndexingOptions {
  correlationId?: string;
  fullName?: string; // repository full name for status tracking
}

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
const SUMMARIZABLE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.pyx', '.pyi',
  '.java', '.kt', '.scala',
  '.go',
  '.rs',
  '.c', '.cpp', '.cc', '.h', '.hpp',
  '.cs',
  '.rb',
  '.php',
  '.swift',
  '.vue', '.svelte',
  '.sql',
  '.sh', '.bash', '.zsh',
  '.yaml', '.yml',
  '.json',
  '.md', '.mdx',
  '.html', '.css', '.scss', '.less'
]);

const EXCLUDED_PATHS = [
  'node_modules/',
  'vendor/',
  'dist/',
  'build/',
  '.git/',
  '__pycache__/',
  '.next/',
  '.nuxt/',
  'coverage/',
  '.cache/',
  'target/',
  'bin/',
  'obj/'
];

const MAX_FILE_SIZE_BYTES = 100 * 1024; // 100KB max file size

// --- Main Export ---

/**
 * Indexes a repository by generating AI summaries for all tracked files.
 * This is the main entry point for the semantic indexing worker.
 *
 * @param repoPath - Path to the git repository
 * @param options - Indexing options
 */
export async function indexRepo(repoPath: string, options: IndexingOptions = {}): Promise<void> {
  const correlationId = options.correlationId || generateCorrelationId();
  const correlatedLogger: Logger = logger.withCorrelation(correlationId);

  const fullName = options.fullName || path.basename(repoPath);

  try {
    // Phase A: Setup & Staleness Check
    correlatedLogger.info({ repoPath, fullName }, 'Starting repository indexing');

    // 1. Check if summarization is enabled
    const settings = await loadSummarizationSettings();
    if (!settings.enabled) {
      correlatedLogger.info('Summarization is disabled, skipping indexing');
      return;
    }

    // 2. Get agent from registry
    const registry = AgentRegistry.getInstance();
    await registry.ensureInitialized();

    const agent = settings.agent_alias
      ? registry.getAgentByAlias(settings.agent_alias)
      : registry.getDefaultAgent();

    if (!agent) {
      throw new Error(`No agent found for summarization (alias: ${settings.agent_alias || 'default'})`);
    }

    correlatedLogger.info(
      { agentAlias: agent.config.alias, model: agent.config.defaultModel },
      'Using agent for summarization'
    );

    // 3. Update repository status to 'indexing'
    await updateRepositoryStatus(fullName, 'indexing');

    // 4. Scan files using git ls-files --stage
    const gitFiles = await scanGitFiles(repoPath, correlatedLogger);
    correlatedLogger.info({ fileCount: gitFiles.length }, 'Scanned git files');

    // 5. Filter and identify staleness
    const { filesToProcess, filesToDelete } = await identifyStaleFiles(
      fullName,
      gitFiles,
      correlatedLogger
    );

    // 6. Delete removed files from DB
    if (filesToDelete.length > 0) {
      await deleteFileSummaries(fullName, filesToDelete);
      correlatedLogger.info({ count: filesToDelete.length }, 'Deleted summaries for removed files');
    }

    if (filesToProcess.length === 0) {
      correlatedLogger.info('No files need processing, all summaries up to date');
      await updateRepositoryStatus(fullName, 'completed');
      return;
    }

    correlatedLogger.info({ count: filesToProcess.length }, 'Files need processing');

    // Phase B: Batch Summarization
    await processBatches(
      repoPath,
      fullName,
      filesToProcess,
      agent,
      correlatedLogger
    );

    // Phase C: Directory Aggregation
    await aggregateDirectories(fullName, agent, correlatedLogger);

    // Phase D: Cleanup - Mark as completed
    await updateRepositoryStatus(fullName, 'completed');
    correlatedLogger.info({ repoPath, fullName }, 'Repository indexing completed successfully');

  } catch (error) {
    const err = error as Error;
    correlatedLogger.error(
      { error: err.message, stack: err.stack, repoPath, fullName },
      'Repository indexing failed'
    );

    // Set status to failed
    try {
      await updateRepositoryStatus(options.fullName || path.basename(repoPath), 'failed');
    } catch (statusError) {
      correlatedLogger.error(
        { error: (statusError as Error).message },
        'Failed to update repository status to failed'
      );
    }

    throw error;
  }
}

// --- Phase A: Setup & Staleness Check ---

/**
 * Scans all tracked files in the repository using git ls-files --stage
 */
async function scanGitFiles(
  repoPath: string,
  log: Logger
): Promise<GitFileInfo[]> {
  const git: SimpleGit = simpleGit(repoPath);

  try {
    // git ls-files --stage returns: mode hash stage path
    const output = await git.raw(['ls-files', '--stage']);

    if (!output.trim()) {
      return [];
    }

    const files: GitFileInfo[] = [];

    for (const line of output.split('\n')) {
      if (!line.trim()) continue;

      // Format: "100644 <blob-hash> 0\t<path>"
      const match = line.match(/^\d+\s+([a-f0-9]+)\s+\d+\t(.+)$/);
      if (!match) continue;

      const [, blobHash, filePath] = match;

      // Filter by extension and excluded paths
      if (!shouldProcessFile(filePath)) {
        continue;
      }

      files.push({
        path: filePath,
        blobHash
      });
    }

    return files;
  } catch (error) {
    log.error({ error: (error as Error).message }, 'Failed to scan git files');
    return [];
  }
}

/**
 * Determines if a file should be processed based on extension and path
 */
function shouldProcessFile(filePath: string): boolean {
  // Check excluded paths
  for (const excluded of EXCLUDED_PATHS) {
    if (filePath.includes(excluded)) {
      return false;
    }
  }

  // Check extension
  const ext = path.extname(filePath).toLowerCase();
  return SUMMARIZABLE_EXTENSIONS.has(ext);
}

/**
 * Identifies files that need processing (new or changed) and files to delete
 */
async function identifyStaleFiles(
  fullName: string,
  gitFiles: GitFileInfo[],
  log: Logger
): Promise<{
  filesToProcess: GitFileInfo[];
  filesToDelete: string[];
}> {
  // Fetch existing summaries from DB
  const existingSummaries = await db('file_summaries')
    .where('path', 'like', `${fullName}/%`)
    .orWhere('path', 'not like', '%/%') // Root-level files
    .select('path', 'commit_hash');

  const dbHashMap = new Map<string, string>();
  for (const summary of existingSummaries) {
    dbHashMap.set(summary.path, summary.commit_hash);
  }

  const gitFileSet = new Set(gitFiles.map(f => f.path));
  const filesToProcess: GitFileInfo[] = [];
  const filesToDelete: string[] = [];

  // Find new and changed files
  for (const file of gitFiles) {
    const dbHash = dbHashMap.get(file.path);

    if (!dbHash) {
      // New file
      filesToProcess.push(file);
    } else if (dbHash !== file.blobHash) {
      // Changed file
      filesToProcess.push(file);
    }
    // else: unchanged, skip
  }

  // Find deleted files (in DB but not in git)
  for (const dbPath of dbHashMap.keys()) {
    if (!gitFileSet.has(dbPath)) {
      filesToDelete.push(dbPath);
    }
  }

  log.debug({
    newFiles: filesToProcess.filter(f => !dbHashMap.has(f.path)).length,
    changedFiles: filesToProcess.filter(f => dbHashMap.has(f.path)).length,
    deletedFiles: filesToDelete.length
  }, 'Staleness check complete');

  return { filesToProcess, filesToDelete };
}

/**
 * Deletes file summaries from the database
 */
async function deleteFileSummaries(fullName: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return;

  await db('file_summaries')
    .whereIn('path', paths)
    .delete();
}

// --- Phase B: Batch Summarization ---

/**
 * Processes files in batches, respecting token limits
 */
async function processBatches(
  repoPath: string,
  fullName: string,
  files: GitFileInfo[],
  agent: Agent,
  log: Logger
): Promise<void> {
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
    const summaries = parseBatchResponse(response, batch.map(f => f.path));

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
function parseBatchResponse(response: string, expectedPaths: string[]): SummaryResult[] {
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
async function aggregateDirectories(
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
    await aggregateSingleDirectory(dir, fileSummaries, dirSummaryCache, agent, log);
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
async function aggregateSingleDirectory(
  dirPath: string,
  fileSummaries: Array<{ path: string; summary: string; commit_hash: string }>,
  dirSummaryCache: Map<string, string>,
  agent: Agent,
  log: Logger
): Promise<void> {
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

// --- Phase D: Repository Status Updates ---

/**
 * Updates the repository indexing status
 */
async function updateRepositoryStatus(
  fullName: string,
  status: 'idle' | 'indexing' | 'completed' | 'failed'
): Promise<void> {
  const updateData: Record<string, unknown> = {
    indexing_status: status,
    updated_at: db.fn.now()
  };

  if (status === 'completed') {
    updateData.last_indexed_at = db.fn.now();
  }

  await db('repositories')
    .insert({
      full_name: fullName,
      indexing_status: status,
      created_at: db.fn.now(),
      updated_at: db.fn.now(),
      ...(status === 'completed' ? { last_indexed_at: db.fn.now() } : {})
    })
    .onConflict('full_name')
    .merge(updateData);
}

// --- Utility Exports ---

/**
 * Gets the summary for a specific file
 */
export async function getFileSummary(filePath: string): Promise<FileSummary | null> {
  const result = await db('file_summaries').where({ path: filePath }).first();
  return result || null;
}

/**
 * Gets the summary for a specific directory
 */
export async function getDirectorySummary(dirPath: string): Promise<DirectorySummary | null> {
  const result = await db('directory_summaries').where({ path: dirPath }).first();
  return result || null;
}

/**
 * Gets all file summaries for a repository
 */
export async function getRepositorySummaries(fullName: string): Promise<FileSummary[]> {
  return db('file_summaries')
    .where('path', 'like', `${fullName}/%`)
    .orWhere('path', 'not like', '%/%')
    .orderBy('path');
}

/**
 * Clears all summaries for a repository (for re-indexing)
 */
export async function clearRepositorySummaries(fullName: string): Promise<void> {
  await db('file_summaries')
    .where('path', 'like', `${fullName}/%`)
    .orWhere('path', 'not like', '%/%')
    .delete();

  await db('directory_summaries')
    .where('path', 'like', `${fullName}/%`)
    .orWhere('path', 'not like', '%/%')
    .delete();

  await updateRepositoryStatus(fullName, 'idle');
}
