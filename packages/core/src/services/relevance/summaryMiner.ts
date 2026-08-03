/* eslint-disable max-lines -- indexing phases share one run-scoped lifecycle */
import { simpleGit, SimpleGit } from 'simple-git';
import path from 'path';
import fs from 'fs/promises';
import type { Logger } from 'pino';
import logger, { generateCorrelationId } from '../../utils/logger.js';
import { AgentRegistry } from '../../agents/AgentRegistry.js';
import type { Agent } from '../../agents/types.js';
import { loadSummarizationSettings, getSummarizationCooldown } from '../../config/configManager.js';
import {
  processBatches,
  aggregateDirectories
} from './summaryMinerHelpers.js';
import type { ProcessBatchesResult } from './summaryMinerHelpers.js';
import type { AggregateDirectoriesResult } from './summaryMinerDirectories.js';
import {
  clearIndexingCancellation,
  clearIndexingRuntimeStateBestEffort,
  isIndexingCancelled,
  IndexingCancelledError,
  initIndexingProgress,
  ensureIndexingProgress,
  clearIndexingProgress,
  publishIndexingStatus
} from './indexingCancellation.js';
import type { IndexingPhase } from '@propr/shared';
import {
  updateRepositoryStatus,
  getRepositoryIndexingStatus,
  createIndexingRunIdentity,
  recordSkippedIndexingRun,
  type IndexingRunIdentity,
  type RepositoryStatusTransition
} from './summaryMinerQueries.js';
import { scanProcessableGitFiles } from './summaryFileFilter.js';
import { deleteFileSummaries, identifyStaleFiles } from './summaryMinerStaleness.js';

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

export interface IndexingOptions {
  correlationId?: string;
  fullName?: string; // repository full name for status tracking
  branch?: string; // branch to index (defaults to 'HEAD')
  fullReindex?: boolean; // if true, process all files regardless of staleness (but preserve existing summaries as fallback)
  ignoreCooldown?: boolean; // manual/admin override for persisted summarization cooldowns
  runId?: string;
  transitionAt?: string;
}

export type IndexingOutcome =
  | 'indexed'
  | 'skipped_disabled'
  | 'skipped_cooldown'
  | 'skipped_superseded'
  | 'skipped_cancelled';

// --- Constants ---

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
  agentAliasSetting: string;
  fallbackAgent?: Agent;
  fallbackModelOverride?: string;
  fallbackEffectiveModel?: string;
  fallbackAgentAliasSetting?: string;
}

/**
 * Sets up the agent for summarization based on settings
 */
async function resolveAgentAlias(agentAliasSetting?: string): Promise<Omit<AgentSetupResult, 'fallbackAgent' | 'fallbackModelOverride' | 'fallbackEffectiveModel' | 'fallbackAgentAliasSetting'>> {
  const registry = AgentRegistry.getInstance();
  await registry.ensureInitialized();

  // Parse agent_alias which may be in format "agent_alias:model" or just "agent_alias"
  const normalizedAgentAliasSetting = agentAliasSetting?.trim() || '';
  let agentAlias = normalizedAgentAliasSetting;
  let modelOverride: string | undefined;

  if (normalizedAgentAliasSetting && normalizedAgentAliasSetting.includes(':')) {
    const parts = normalizedAgentAliasSetting.split(':');
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

  return { agent, modelOverride, effectiveModel, agentAliasSetting: normalizedAgentAliasSetting || agent.config.alias };
}

async function setupAgent(settings: { agent_alias?: string; fallback_agent_alias?: string }): Promise<AgentSetupResult> {
  const primaryAliasSetting = settings.agent_alias?.trim() || '';
  const fallbackAliasSetting = settings.fallback_agent_alias?.trim() || '';
  const primary = await resolveAgentAlias(primaryAliasSetting);
  if (!fallbackAliasSetting || fallbackAliasSetting === primaryAliasSetting) {
    return primary;
  }

  const fallback = await resolveAgentAlias(fallbackAliasSetting);
  return {
    ...primary,
    fallbackAgent: fallback.agent,
    fallbackModelOverride: fallback.modelOverride,
    fallbackEffectiveModel: fallback.effectiveModel,
    fallbackAgentAliasSetting: fallback.agentAliasSetting
  };
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

interface HeadInfo {
  hash?: string;
  commitMessage?: string;
}

async function resolveHeadInfo(repoPath: string, branch: string, log: Logger): Promise<HeadInfo> {
  try {
    const git: SimpleGit = simpleGit(repoPath);
    const refToResolve = branch === 'HEAD' ? 'origin/HEAD' : `origin/${branch}`;
    const hash = (await git.raw(['-c', 'safe.directory=*', 'rev-parse', refToResolve])).trim();
    const logResult = await git.raw(['-c', 'safe.directory=*', 'log', '-1', '--format=%s', refToResolve]);
    const commitMessage = logResult.trim() || undefined;
    return { hash, commitMessage };
  } catch (error) {
    log.warn({ error: (error as Error).message, branch }, 'Failed to resolve branch hash or commit message');
    return {};
  }
}

async function safePublishIndexingStatus(
  fullName: string,
  branch: string,
  status: IndexingPhase,
  transition?: { transitionAt: string; runId: string }
): Promise<void> {
  try {
    await publishIndexingStatus(fullName, branch, status, transition);
  } catch {
    // best-effort
  }
}

async function safePublishAppliedIndexingStatus(
  fullName: string,
  branch: string,
  status: IndexingPhase,
  transition: RepositoryStatusTransition
): Promise<void> {
  if (!transition.applied) return;
  await safePublishIndexingStatus(fullName, branch, status, transition);
}

async function throwIfIndexingCancelled(
  fullName: string,
  branch: string,
  indexingRun: IndexingRunIdentity
): Promise<void> {
  if (await isIndexingCancelled(fullName, branch, indexingRun.runId)) {
    throw new IndexingCancelledError(fullName);
  }
}

async function closeSkippedIndexingRun(
  fullName: string,
  branch: string,
  indexingRun: IndexingRunIdentity | undefined
): Promise<void> {
  if (!indexingRun) return;
  // Older rows can predate run ownership. Preserve their durable failure just
  // as we preserve a failed row owned by another modern run.
  const existingStatus = await getRepositoryIndexingStatus(fullName, branch);
  const currentTransition = existingStatus === 'failed'
    ? { ...indexingRun, applied: false }
    : await updateRepositoryStatus(fullName, 'idle', branch, indexingRun);
  const terminalTransition = currentTransition.applied
    ? currentTransition
    : await recordSkippedIndexingRun(fullName, branch, indexingRun);
  await safePublishAppliedIndexingStatus(fullName, branch, 'idle', terminalTransition);
}

interface IndexingCompletionOptions {
  repoPath: string;
  fullName: string;
  branch: string;
  currentHeadHash?: string;
  currentHeadCommitMessage?: string;
  iconPath: string | null;
  batchResult: { filesProcessed: number; failedBatches: number; totalBatches: number };
  dirFailedBatches: number;
  log: Logger;
  indexingRun: IndexingRunIdentity;
}

async function handleNoFilesToProcess(options: {
  fullName: string;
  branch: string;
  currentHeadHash?: string;
  currentHeadCommitMessage?: string;
  iconPath: string | null;
  agent: Agent;
  modelOverride: string | undefined;
  agentAliasSetting: string;
  resolveSummarizationConfig: () => Promise<AgentSetupResult & { customPrompt?: string }>;
  log: Logger;
  indexingRun: IndexingRunIdentity;
}): Promise<void> {
  const { fullName, branch, currentHeadHash, currentHeadCommitMessage, iconPath, agent, modelOverride, agentAliasSetting, resolveSummarizationConfig, log, indexingRun } = options;
  log.info('No files need processing, all file summaries up to date');
  await ensureIndexingProgress(fullName, branch, indexingRun);
  const dirResult = await aggregateDirectories({
    fullName, agent, log, modelOverride, agentAliasSetting, resolveSummarizationConfig,
    branch, runId: indexingRun.runId
  });
  await throwIfIndexingCancelled(fullName, branch, indexingRun);

  if (dirResult.failedBatches > 0) {
    const transition = await updateRepositoryStatus(fullName, 'failed', branch, {
      ...indexingRun
    });
    await safePublishAppliedIndexingStatus(fullName, branch, 'failed', transition);
    await clearIndexingCancellation(fullName, branch, indexingRun.runId);
    await clearIndexingProgress(fullName, branch, indexingRun.runId);
    log.warn({ fullName, branch, ...dirResult }, 'Directory aggregation completed with failures - will retry on next scan');
    return;
  }

  const transition = await updateRepositoryStatus(fullName, 'completed', branch, {
    ...indexingRun,
    commitInfo: { hash: currentHeadHash, message: currentHeadCommitMessage, iconPath }
  });
  await safePublishAppliedIndexingStatus(fullName, branch, 'completed', transition);
  await clearIndexingCancellation(fullName, branch, indexingRun.runId);
  await clearIndexingProgress(fullName, branch, indexingRun.runId);
}

async function finalizeIndexing(options: IndexingCompletionOptions): Promise<void> {
  const { repoPath, fullName, branch, currentHeadHash, currentHeadCommitMessage, iconPath, batchResult, dirFailedBatches, log, indexingRun } = options;
  await throwIfIndexingCancelled(fullName, branch, indexingRun);
  if (batchResult.failedBatches > 0 || dirFailedBatches > 0) {
    const transition = await updateRepositoryStatus(fullName, 'failed', branch, {
      ...indexingRun
    });
    await safePublishAppliedIndexingStatus(fullName, branch, 'failed', transition);
    log.warn(
      { repoPath, fullName, branch, ...batchResult, dirFailedBatches },
      'Repository indexing completed with failures - will retry on next scan'
    );
    return;
  }

  const transition = await updateRepositoryStatus(fullName, 'completed', branch, {
    ...indexingRun,
    commitInfo: { hash: currentHeadHash, message: currentHeadCommitMessage, iconPath }
  });
  await safePublishAppliedIndexingStatus(fullName, branch, 'completed', transition);
  log.info({ repoPath, fullName, branch, headHash: currentHeadHash, iconPath, ...batchResult }, 'Repository indexing completed successfully');
}

// --- Main Export ---

/**
 * Indexes a repository by generating AI summaries for all tracked files.
 * This is the main entry point for the semantic indexing worker.
 *
 * @param repoPath - Path to the git repository
 * @param options - Indexing options
 */
// eslint-disable-next-line complexity -- every exit must preserve the accepted run identity
export async function indexRepo(repoPath: string, options: IndexingOptions = {}): Promise<IndexingOutcome> {
  const correlationId = options.correlationId || generateCorrelationId();
  const correlatedLogger: Logger = logger.withCorrelation(correlationId);

  const fullName = options.fullName || path.basename(repoPath);
  const branch = options.branch || 'HEAD';
  let indexingRun: IndexingRunIdentity | undefined = options.runId && options.transitionAt
    ? { runId: options.runId, transitionAt: options.transitionAt }
    : undefined;

  const { hash: currentHeadHash, commitMessage: currentHeadCommitMessage } = await resolveHeadInfo(repoPath, branch, correlatedLogger);

  try {
    // Phase A: Setup & Staleness Check
    correlatedLogger.info({ repoPath, fullName, branch, headHash: currentHeadHash }, 'Starting repository indexing');

    // Check if summarization is enabled before considering runtime cooldowns.
    const settings = await loadSummarizationSettings();
    if (!settings.enabled) {
      correlatedLogger.info('Summarization is disabled, skipping indexing');
      await closeSkippedIndexingRun(fullName, branch, indexingRun);
      return 'skipped_disabled';
    }

    const cooldown = options.ignoreCooldown ? null : await getSummarizationCooldown(fullName, branch);
    if (cooldown) {
      correlatedLogger.warn({ fullName, branch, until: cooldown.until, reason: cooldown.reason }, 'Skipping repository indexing during summarization cooldown');
      // Close the optimistic queued activity. If another run (including a
      // failed one) owns the durable repository row, retain that current status
      // and append this cancellation to transition history instead.
      await closeSkippedIndexingRun(fullName, branch, indexingRun);
      await clearIndexingCancellation(fullName, branch, indexingRun?.runId);
      await clearIndexingProgress(fullName, branch, indexingRun?.runId);
      return 'skipped_cooldown';
    }

    // Discover repository icon early, so we can include it in status updates.
    const iconPath = await discoverRepoIcon(repoPath, correlatedLogger);

    // Get agent from registry
    const agentConfig = await setupAgent(settings);
    const { agent, modelOverride, effectiveModel, agentAliasSetting } = agentConfig;
    const resolveSummarizationConfig = async () => {
      const latestSettings = await loadSummarizationSettings();
      if (!latestSettings.enabled) {
        throw new Error('Summarization was disabled while indexing was in progress');
      }
      const latestAgentConfig = await setupAgent(latestSettings);
      return { ...latestAgentConfig, customPrompt: latestSettings.custom_prompt };
    };

    correlatedLogger.info(
      { agentAlias: agent.config.alias, model: effectiveModel, fallbackAgentAlias: settings.fallback_agent_alias || undefined },
      'Using agent for summarization'
    );

    // 3. Producers normally establish durable ownership when BullMQ accepts the
    // job. Direct/legacy callers establish it here; accepted queued runs merely
    // verify that cancellation or a replacement did not win first.
    const queuedRun = indexingRun;
    const requestedRun = queuedRun ?? createIndexingRunIdentity();
    const startTransition = await updateRepositoryStatus(fullName, 'indexing', branch, {
      ...requestedRun,
      startNewRun: queuedRun === undefined
    });
    indexingRun = { runId: startTransition.runId, transitionAt: startTransition.transitionAt };
    if (!startTransition.applied) {
      correlatedLogger.warn({ fullName, branch, runId: indexingRun.runId },
        'Skipping superseded indexing job');
      await clearIndexingRuntimeStateBestEffort(fullName, branch, indexingRun.runId);
      return 'skipped_superseded';
    }
    await safePublishIndexingStatus(fullName, branch, 'indexing', indexingRun);

    // 4. Scan files using git ls-files --stage
    const gitFiles = await scanProcessableGitFiles(repoPath, correlatedLogger);
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
      await handleNoFilesToProcess({
        fullName,
        branch,
        currentHeadHash,
        currentHeadCommitMessage,
        iconPath,
        agent,
        modelOverride,
        agentAliasSetting,
        resolveSummarizationConfig,
        log: correlatedLogger,
        indexingRun
      });
      return 'indexed';
    }

    let batchResult: ProcessBatchesResult = {
      successfulBatches: 0,
      filesProcessed: 0,
      filesFailed: 0,
      failedBatches: 0,
      totalBatches: 0,
      fallbackUsed: false,
      stopProcessing: false
    };

    if (filesToProcess.length > 0) {
      correlatedLogger.info({ count: filesToProcess.length }, 'Files need processing');

      // Initialize progress tracking
      await initIndexingProgress(fullName, filesToProcess.length, branch, indexingRun);

      // Phase B: Batch Summarization
      batchResult = await processBatches({
        repoPath,
        fullName,
        files: filesToProcess,
        agent,
        log: correlatedLogger,
        modelOverride,
        agentAliasSetting,
        fallbackAgent: agentConfig.fallbackAgent,
        fallbackModelOverride: agentConfig.fallbackModelOverride,
        fallbackEffectiveModel: agentConfig.fallbackEffectiveModel,
        fallbackAgentAliasSetting: agentConfig.fallbackAgentAliasSetting,
        customPrompt: settings.custom_prompt,
        resolveSummarizationConfig,
        branch,
        runId: indexingRun.runId
      });
    }

    // Phase C: Directory Aggregation (if files were processed or deleted)
    let dirFailedBatches = 0;
    if (!batchResult.stopProcessing && (batchResult.filesProcessed > 0 || filesToDelete.length > 0)) {
      await ensureIndexingProgress(fullName, branch, indexingRun);
      const dirResult = await aggregateDirectories({
        fullName,
        agent,
        log: correlatedLogger,
        modelOverride,
        agentAliasSetting,
        fallbackAgent: agentConfig.fallbackAgent,
        fallbackModelOverride: agentConfig.fallbackModelOverride,
        fallbackEffectiveModel: agentConfig.fallbackEffectiveModel,
        fallbackAgentAliasSetting: agentConfig.fallbackAgentAliasSetting,
        resolveSummarizationConfig,
        branch,
        runId: indexingRun.runId
      });
      dirFailedBatches = dirResult.failedBatches;
      applyDirectoryFallbackResult(batchResult, dirResult);
    }

    // Phase D: Cleanup - Mark status based on results
    await finalizeIndexing({
      repoPath,
      fullName,
      branch,
      currentHeadHash,
      currentHeadCommitMessage,
      iconPath,
      batchResult,
      dirFailedBatches,
      log: correlatedLogger,
      indexingRun
    });

    // Clear cancellation flag and progress on successful completion
    await clearIndexingCancellation(fullName, branch, indexingRun.runId);
    await clearIndexingProgress(fullName, branch, indexingRun.runId);
    return 'indexed';

  } catch (error) {
    return handleIndexingError({
      error,
      repoPath,
      options,
      correlatedLogger,
      indexingRun
    });
  }
}

function applyDirectoryFallbackResult(batchResult: ProcessBatchesResult, dirResult: AggregateDirectoriesResult): void {
  if (!dirResult.fallbackUsed || batchResult.fallbackUsed) return;
  batchResult.fallbackUsed = true;
  batchResult.fallbackPrimaryAgentAlias = dirResult.fallbackPrimaryAgentAlias;
  batchResult.fallbackAgentAlias = dirResult.fallbackAgentAlias;
}

async function handleIndexingError(input: {
  error: unknown;
  repoPath: string;
  options: IndexingOptions;
  correlatedLogger: Logger;
  indexingRun?: IndexingRunIdentity;
}): Promise<IndexingOutcome> {
  const { error, repoPath, options, correlatedLogger, indexingRun } = input;
  const repoName = options.fullName || path.basename(repoPath);
  const errorBranch = options.branch || 'HEAD';

  // Handle user-initiated cancellation
  if (error instanceof IndexingCancelledError) {
    correlatedLogger.info({ repoPath, fullName: repoName, branch: errorBranch }, 'Repository indexing was cancelled by user');
    // Reset DB status to idle so REST queries reflect the stopped state
    const transition = await updateRepositoryStatus(repoName, 'idle', errorBranch, {
      ...(indexingRun ?? {})
    });
    // Publish idle now that the worker has fully stopped — this is the authoritative
    // terminal event so clients won't see stale progress updates afterward.
    await safePublishAppliedIndexingStatus(repoName, errorBranch, 'idle', transition);
    await clearIndexingCancellation(repoName, errorBranch, indexingRun?.runId);
    await clearIndexingProgress(repoName, errorBranch, indexingRun?.runId);
    return 'skipped_cancelled';
  }

  await clearIndexingCancellation(repoName, errorBranch, indexingRun?.runId);
  await clearIndexingProgress(repoName, errorBranch, indexingRun?.runId);

  const err = error as Error;
  correlatedLogger.error(
    { error: err.message, stack: err.stack, repoPath, fullName: repoName, branch: errorBranch },
    'Repository indexing failed'
  );

  // Set status to failed
  try {
    const transition = await updateRepositoryStatus(repoName, 'failed', errorBranch, {
      ...(indexingRun ?? {})
    });
    await safePublishAppliedIndexingStatus(repoName, errorBranch, 'failed', transition);
  } catch (statusError) {
    correlatedLogger.error(
      { error: (statusError as Error).message },
      'Failed to update repository status to failed'
    );
  }

  throw error;
}

// --- Utility Exports ---
export { updateRepositoryStatus };
export { getFileSummary, getDirectorySummary, getRepositorySummaries, clearRepositorySummaries } from './summaryMinerQueries.js';
