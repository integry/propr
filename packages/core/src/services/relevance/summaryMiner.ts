import { simpleGit, SimpleGit } from 'simple-git';
import path from 'path';
import type { Logger } from 'pino';
import logger, { generateCorrelationId } from '../../utils/logger.js';
import { AgentRegistry } from '../../agents/AgentRegistry.js';
import { db } from '../../db/connection.js';
import { loadSummarizationSettings } from '../../config/configManager.js';
import {
  processBatches,
  aggregateDirectories
} from './summaryMinerHelpers.js';

// Re-export metrics functions and types for external access
export {
  getSummarizationMetricsSummary,
  getSummarizationCallHistory
} from './summaryMinerHelpers.js';
export type {
  SummarizationCallMetrics,
  SummarizationMetricsSummary
} from './summaryMinerHelpers.js';

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

// --- Constants ---

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

    // Parse agent_alias which may be in format "agent_alias:model" or just "agent_alias"
    let agentAlias = settings.agent_alias;
    let modelOverride: string | undefined;

    if (settings.agent_alias && settings.agent_alias.includes(':')) {
      const parts = settings.agent_alias.split(':');
      agentAlias = parts[0];
      modelOverride = parts.slice(1).join(':'); // Handle model IDs that might contain colons
    }

    const agent = agentAlias
      ? registry.getAgentByAlias(agentAlias)
      : registry.getDefaultAgent();

    if (!agent) {
      throw new Error(`No agent found for summarization (alias: ${agentAlias || 'default'})`);
    }

    // Determine which model to use for budgeting and logging
    const effectiveModel = modelOverride || agent.config.defaultModel;

    correlatedLogger.info(
      { agentAlias: agent.config.alias, model: effectiveModel },
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
      await deleteFileSummaries(filesToDelete);
      correlatedLogger.info({ count: filesToDelete.length }, 'Deleted summaries for removed files');
    }

    if (filesToProcess.length === 0) {
      correlatedLogger.info('No files need processing, all summaries up to date');
      await updateRepositoryStatus(fullName, 'completed');
      return;
    }

    correlatedLogger.info({ count: filesToProcess.length }, 'Files need processing');

    // Phase B: Batch Summarization
    await processBatches({
      repoPath,
      fullName,
      files: filesToProcess,
      agent,
      log: correlatedLogger,
      modelOverride
    });

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
  // Fetch existing summaries from DB (paths are stored as fullName/relativePath)
  const existingSummaries = await db('file_summaries')
    .where('path', 'like', `${fullName}/%`)
    .select('path', 'commit_hash');

  // Map from full stored path to hash
  const dbHashMap = new Map<string, string>();
  for (const summary of existingSummaries) {
    dbHashMap.set(summary.path, summary.commit_hash);
  }

  // Create set of full paths from git files for deletion check
  const gitFileFullPathSet = new Set(gitFiles.map(f => `${fullName}/${f.path}`));
  const filesToProcess: GitFileInfo[] = [];
  const filesToDelete: string[] = [];

  // Find new and changed files
  for (const file of gitFiles) {
    const fullPath = `${fullName}/${file.path}`;
    const dbHash = dbHashMap.get(fullPath);

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
    if (!gitFileFullPathSet.has(dbPath)) {
      filesToDelete.push(dbPath);
    }
  }

  log.debug({
    existingInDb: dbHashMap.size,
    newFiles: filesToProcess.filter(f => !dbHashMap.has(`${fullName}/${f.path}`)).length,
    changedFiles: filesToProcess.filter(f => dbHashMap.has(`${fullName}/${f.path}`)).length,
    deletedFiles: filesToDelete.length,
    unchangedFiles: gitFiles.length - filesToProcess.length
  }, 'Staleness check complete');

  return { filesToProcess, filesToDelete };
}

/**
 * Deletes file summaries from the database
 */
async function deleteFileSummaries(paths: string[]): Promise<void> {
  if (paths.length === 0) return;

  await db('file_summaries')
    .whereIn('path', paths)
    .delete();
}

// --- Phase D: Repository Status Updates ---

/**
 * Updates the repository indexing status
 */
export async function updateRepositoryStatus(
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
