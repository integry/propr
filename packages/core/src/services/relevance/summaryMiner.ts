import { simpleGit, SimpleGit } from 'simple-git';
import path from 'path';
import fs from 'fs/promises';
import type { Logger } from 'pino';
import logger, { generateCorrelationId } from '../../utils/logger.js';
import { AgentRegistry } from '../../agents/AgentRegistry.js';
import type { Agent } from '../../agents/types.js';
import { db } from '../../db/connection.js';
import { loadSummarizationSettings } from '../../config/configManager.js';
import {
  processBatches,
  aggregateDirectories
} from './summaryMinerHelpers.js';
import { clearIndexingCancellation, IndexingCancelledError, initIndexingProgress, clearIndexingProgress, publishIndexingStatus } from './indexingCancellation.js';
import { updateRepositoryStatus } from './summaryMinerQueries.js';

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
  branch?: string; // branch to index (defaults to 'HEAD')
  fullReindex?: boolean; // if true, process all files regardless of staleness (but preserve existing summaries as fallback)
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

/**
 * Common icon file paths to check for in the repository.
 * Includes both root-level and subdirectory locations.
 * Listed in order of priority - first match wins.
 */
const COMMON_ICON_FILES = [
  'public/apple-touch-icon.png',
  'apple-touch-icon.png',
  'public/favicon.svg',
  'favicon.svg',
  'public/favicon.png',
  'public/icon.png',
  'public/logo.png',
  'favicon.png',
  'app/icon.png',
  'src/app/icon.png',
  'public/favicon.ico',
  'favicon.ico',
  'app/favicon.ico',
  'static/favicon.ico',
  'src-tauri/icons/icon.png',
  'assets/icon.png',
  'src/assets/icon.png',
  'logo.png',
  'logo.svg',
  'icon.png',
  'icon.svg',
  'logo.jpg',
  'logo.jpeg',
  'icon.jpg',
  'icon.jpeg',
  'app-icon.png',
  'app-icon.svg',
  'brand.png',
  'brand.svg'
];

// --- Helper Functions ---

interface AgentSetupResult {
  agent: Agent;
  modelOverride: string | undefined;
  effectiveModel: string | undefined;
}

/**
 * Sets up the agent for summarization based on settings
 */
async function setupAgent(settings: { agent_alias?: string }): Promise<AgentSetupResult> {
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

  const effectiveModel = modelOverride || agent.config.defaultModel;

  return { agent, modelOverride, effectiveModel };
}

/**
 * Discovers an icon file in the repository by checking common icon file locations.
 * Checks both root-level and subdirectory paths (e.g., public/, app/, assets/).
 * Returns the relative path to the first matching icon file, or null if none found.
 */
async function discoverRepoIcon(repoPath: string, log: Logger): Promise<string | null> {
  for (const iconFile of COMMON_ICON_FILES) {
    const iconPath = path.join(repoPath, iconFile);
    try {
      await fs.access(iconPath);
      log.info({ iconPath: iconFile }, 'Discovered repository icon');
      return iconFile;
    } catch {
      // File doesn't exist, continue to next
    }
  }
  log.debug('No repository icon found in common locations');
  return null;
}

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
  const branch = options.branch || 'HEAD';

  // Get the hash and commit message of the configured branch for tracking indexed state
  // (same repo can be tracked multiple times with different branches)
  let currentHeadHash: string | undefined;
  let currentHeadCommitMessage: string | undefined;
  try {
    const git: SimpleGit = simpleGit(repoPath);
    // Use origin refs to get the remote branch state, not the local checkout state.
    // For 'HEAD', use origin/HEAD (the remote's default branch), not local HEAD
    // (which is whatever branch happens to be checked out locally).
    const refToResolve = branch === 'HEAD' ? 'origin/HEAD' : `origin/${branch}`;
    currentHeadHash = await git.revparse([refToResolve]);
    // Get the commit message for the HEAD commit
    const logResult = await git.log({ maxCount: 1, from: refToResolve });
    if (logResult.latest) {
      currentHeadCommitMessage = logResult.latest.message;
    }
  } catch (hashError) {
    correlatedLogger.warn({ error: (hashError as Error).message, branch }, 'Failed to resolve branch hash or commit message');
  }

  try {
    // Phase A: Setup & Staleness Check
    correlatedLogger.info({ repoPath, fullName, branch, headHash: currentHeadHash }, 'Starting repository indexing');

    // 0. Discover repository icon (early, so we can include it in status updates)
    const iconPath = await discoverRepoIcon(repoPath, correlatedLogger);

    // 1. Check if summarization is enabled
    const settings = await loadSummarizationSettings();
    if (!settings.enabled) {
      correlatedLogger.info('Summarization is disabled, skipping indexing');
      return;
    }

    // 2. Get agent from registry
    const { agent, modelOverride, effectiveModel } = await setupAgent(settings);

    correlatedLogger.info(
      { agentAlias: agent.config.alias, model: effectiveModel },
      'Using agent for summarization'
    );

    // 3. Update repository status to 'indexing'
    await updateRepositoryStatus(fullName, 'indexing', branch);

    // 4. Scan files using git ls-files --stage
    const gitFiles = await scanGitFiles(repoPath, correlatedLogger);
    correlatedLogger.info({ fileCount: gitFiles.length }, 'Scanned git files');

    // 5. Filter and identify staleness
    const { filesToProcess, filesToDelete } = await identifyStaleFiles(
      fullName,
      gitFiles,
      correlatedLogger,
      { branch, fullReindex: options.fullReindex }
    );

    // 6. Delete removed files from DB
    if (filesToDelete.length > 0) {
      await deleteFileSummaries(filesToDelete, branch);
      correlatedLogger.info({ count: filesToDelete.length }, 'Deleted summaries for removed files');
    }

    if (filesToProcess.length === 0 && filesToDelete.length === 0) {
      correlatedLogger.info('No files need processing, all summaries up to date');
      await updateRepositoryStatus(fullName, 'completed', branch, { hash: currentHeadHash, message: currentHeadCommitMessage, iconPath });
      await publishIndexingStatus(fullName, branch, 'completed');
      return;
    }

    let batchResult = { filesProcessed: 0, failedBatches: 0, totalBatches: 0 };

    if (filesToProcess.length > 0) {
      correlatedLogger.info({ count: filesToProcess.length }, 'Files need processing');

      // Initialize progress tracking
      await initIndexingProgress(fullName, filesToProcess.length, branch);

      // Phase B: Batch Summarization
      batchResult = await processBatches({
        repoPath,
        fullName,
        files: filesToProcess,
        agent,
        log: correlatedLogger,
        modelOverride,
        customPrompt: settings.custom_prompt,
        branch
      });
    }

    // Phase C: Directory Aggregation (if files were processed or deleted)
    if (batchResult.filesProcessed > 0 || filesToDelete.length > 0) {
      await aggregateDirectories({ fullName, agent, log: correlatedLogger, modelOverride, branch });
    }

    // Phase D: Cleanup - Mark status based on results
    if (batchResult.failedBatches > 0) {
      // Some batches failed - mark as failed so it will be retried
      await updateRepositoryStatus(fullName, 'failed', branch);
      await publishIndexingStatus(fullName, branch, 'failed');
      correlatedLogger.warn(
        { repoPath, fullName, branch, ...batchResult },
        'Repository indexing completed with failures - will retry on next scan'
      );
    } else {
      await updateRepositoryStatus(fullName, 'completed', branch, { hash: currentHeadHash, message: currentHeadCommitMessage, iconPath });
      await publishIndexingStatus(fullName, branch, 'completed');
      correlatedLogger.info({ repoPath, fullName, branch, headHash: currentHeadHash, iconPath, ...batchResult }, 'Repository indexing completed successfully');
    }

    // Clear cancellation flag and progress on successful completion
    await clearIndexingCancellation(fullName);
    await clearIndexingProgress(fullName, branch);

  } catch (error) {
    await handleIndexingError(error, repoPath, options, correlatedLogger);
  }
}

async function handleIndexingError(
  error: unknown,
  repoPath: string,
  options: IndexingOptions,
  correlatedLogger: Logger
): Promise<void> {
  const repoName = options.fullName || path.basename(repoPath);
  const errorBranch = options.branch || 'HEAD';

  // Always clear the cancellation flag and progress
  await clearIndexingCancellation(repoName);
  await clearIndexingProgress(repoName, errorBranch);

  // Handle user-initiated cancellation
  if (error instanceof IndexingCancelledError) {
    correlatedLogger.info({ repoPath, fullName: repoName, branch: errorBranch }, 'Repository indexing was cancelled by user');
    // Status already set to 'idle' by stopIndexingJob, just return without throwing
    return;
  }

  const err = error as Error;
  correlatedLogger.error(
    { error: err.message, stack: err.stack, repoPath, fullName: repoName, branch: errorBranch },
    'Repository indexing failed'
  );

  // Set status to failed
  try {
    await updateRepositoryStatus(repoName, 'failed', errorBranch);
    await publishIndexingStatus(repoName, errorBranch, 'failed');
  } catch (statusError) {
    correlatedLogger.error(
      { error: (statusError as Error).message },
      'Failed to update repository status to failed'
    );
  }

  throw error;
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

interface IdentifyStaleFilesOptions {
  branch: string;
  fullReindex?: boolean;
}

/**
 * Identifies files that need processing (new or changed) and files to delete.
 * If fullReindex is true, all files are marked for processing regardless of staleness.
 */
async function identifyStaleFiles(
  fullName: string,
  gitFiles: GitFileInfo[],
  log: Logger,
  options: IdentifyStaleFilesOptions
): Promise<{
  filesToProcess: GitFileInfo[];
  filesToDelete: string[];
}> {
  const { branch, fullReindex } = options;
  // Fetch existing summaries from DB (paths are stored as fullName/relativePath)
  const existingSummaries = await db('file_summaries')
    .where('path', 'like', `${fullName}/%`)
    .andWhere({ branch })
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

  // If fullReindex, process all files (existing summaries will be overwritten)
  if (fullReindex) {
    log.info({ fullReindex: true, fileCount: gitFiles.length }, 'Full reindex requested - processing all files');
    filesToProcess.push(...gitFiles);
  } else {
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
  }

  // Find deleted files (in DB but not in git) - always clean these up
  for (const dbPath of dbHashMap.keys()) {
    if (!gitFileFullPathSet.has(dbPath)) {
      filesToDelete.push(dbPath);
    }
  }

  log.debug({
    fullReindex: !!fullReindex,
    existingInDb: dbHashMap.size,
    newFiles: filesToProcess.filter(f => !dbHashMap.has(`${fullName}/${f.path}`)).length,
    changedFiles: filesToProcess.filter(f => dbHashMap.has(`${fullName}/${f.path}`)).length,
    deletedFiles: filesToDelete.length,
    unchangedFiles: fullReindex ? 0 : (gitFiles.length - filesToProcess.length)
  }, 'Staleness check complete');

  return { filesToProcess, filesToDelete };
}

/**
 * Deletes file summaries from the database
 */
async function deleteFileSummaries(paths: string[], branch: string): Promise<void> {
  if (paths.length === 0) return;

  const CHUNK_SIZE = 500;
  for (let i = 0; i < paths.length; i += CHUNK_SIZE) {
    const chunk = paths.slice(i, i + CHUNK_SIZE);
    await db('file_summaries')
      .whereIn('path', chunk)
      .andWhere({ branch })
      .delete();
  }
}

// --- Utility Exports ---
export { updateRepositoryStatus };
export { getFileSummary, getDirectorySummary, getRepositorySummaries, clearRepositorySummaries } from './summaryMinerQueries.js';
