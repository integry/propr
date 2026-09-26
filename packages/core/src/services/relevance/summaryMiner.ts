import { simpleGit, SimpleGit } from 'simple-git';
import path from 'path';
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
import { clearIndexingCancellation, IndexingCancelledError, initIndexingProgress, ensureIndexingProgress, clearIndexingProgress, publishIndexingStatus } from './indexingCancellation.js';
import type { IndexingPhase } from '@propr/shared';
import { updateRepositoryStatus, getRepositoryIndexingStatus } from './summaryMinerQueries.js';
import { filterProcessableGitFiles, scanGitFiles } from './summaryFileFilter.js';
import { discoverRepositoryIcon } from './repositoryIconDiscovery.js';
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
}

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

async function safePublishIndexingStatus(fullName: string, branch: string, status: IndexingPhase): Promise<void> {
  try {
    await publishIndexingStatus(fullName, branch, status);
  } catch {
    // best-effort
  }
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
}): Promise<void> {
  const { fullName, branch, currentHeadHash, currentHeadCommitMessage, iconPath, agent, modelOverride, agentAliasSetting, resolveSummarizationConfig, log } = options;
  log.info('No files need processing, all file summaries up to date');
  await ensureIndexingProgress(fullName, branch);
  const dirResult = await aggregateDirectories({ fullName, agent, log, modelOverride, agentAliasSetting, resolveSummarizationConfig, branch });
  await clearIndexingCancellation(fullName, branch);
  await clearIndexingProgress(fullName, branch);

  if (dirResult.failedBatches > 0) {
    await updateRepositoryStatus(fullName, 'failed', branch);
    await safePublishIndexingStatus(fullName, branch, 'failed');
    log.warn({ fullName, branch, ...dirResult }, 'Directory aggregation completed with failures - will retry on next scan');
    return;
  }

  await updateRepositoryStatus(fullName, 'completed', branch, { hash: currentHeadHash, message: currentHeadCommitMessage, iconPath });
  await safePublishIndexingStatus(fullName, branch, 'completed');
}

async function finalizeIndexing(options: IndexingCompletionOptions): Promise<void> {
  const { repoPath, fullName, branch, currentHeadHash, currentHeadCommitMessage, iconPath, batchResult, dirFailedBatches, log } = options;
  if (batchResult.failedBatches > 0 || dirFailedBatches > 0) {
    await updateRepositoryStatus(fullName, 'failed', branch);
    await safePublishIndexingStatus(fullName, branch, 'failed');
    log.warn(
      { repoPath, fullName, branch, ...batchResult, dirFailedBatches },
      'Repository indexing completed with failures - will retry on next scan'
    );
    return;
  }

  await updateRepositoryStatus(fullName, 'completed', branch, { hash: currentHeadHash, message: currentHeadCommitMessage, iconPath });
  await safePublishIndexingStatus(fullName, branch, 'completed');
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
export async function indexRepo(repoPath: string, options: IndexingOptions = {}): Promise<void> {
  const correlationId = options.correlationId || generateCorrelationId();
  const correlatedLogger: Logger = logger.withCorrelation(correlationId);

  const fullName = options.fullName || path.basename(repoPath);
  const branch = options.branch || 'HEAD';

  const { hash: currentHeadHash, commitMessage: currentHeadCommitMessage } = await resolveHeadInfo(repoPath, branch, correlatedLogger);

  try {
    // Phase A: Setup & Staleness Check
    correlatedLogger.info({ repoPath, fullName, branch, headHash: currentHeadHash }, 'Starting repository indexing');

    // Check if summarization is enabled before considering runtime cooldowns.
    const settings = await loadSummarizationSettings();
    if (!settings.enabled) {
      correlatedLogger.info('Summarization is disabled, skipping indexing');
      return;
    }

    const cooldown = options.ignoreCooldown ? null : await getSummarizationCooldown(fullName, branch);
    if (cooldown) {
      correlatedLogger.warn({ fullName, branch, until: cooldown.until, reason: cooldown.reason }, 'Skipping repository indexing during summarization cooldown');
      // Preserve an existing failed state: the cooldown skip repairs nothing, so
      // clearing a previously failed repository to idle would hide a real problem.
      const existingStatus = await getRepositoryIndexingStatus(fullName, branch);
      const cooldownStatus = existingStatus === 'failed' ? 'failed' : 'idle';
      if (existingStatus !== 'failed') {
        await updateRepositoryStatus(fullName, 'idle', branch);
      }
      await safePublishIndexingStatus(fullName, branch, cooldownStatus);
      await clearIndexingCancellation(fullName, branch);
      await clearIndexingProgress(fullName, branch);
      return;
    }

    // Reuse this single tracked-file scan for icon discovery and summarization.
    // A failed scan is not evidence that a previously discovered icon was removed.
    const trackedFiles = await scanGitFiles(repoPath, correlatedLogger, { throwOnError: true });
    const iconPath = discoverRepositoryIcon(trackedFiles, correlatedLogger);

    // Persist icon discovery (including an explicit null) at the start of the run.
    // Later failures update only the status and therefore retain this metadata.
    await updateRepositoryStatus(fullName, 'indexing', branch, { iconPath });

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

    // Filter the tracked files for content summarization without invoking Git again.
    const gitFiles = filterProcessableGitFiles(repoPath, trackedFiles);
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
        log: correlatedLogger
      });
      return;
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
      await initIndexingProgress(fullName, filesToProcess.length, branch);

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
        branch
      });
    }

    // Phase C: Directory Aggregation (if files were processed or deleted)
    let dirFailedBatches = 0;
    if (!batchResult.stopProcessing && (batchResult.filesProcessed > 0 || filesToDelete.length > 0)) {
      await ensureIndexingProgress(fullName, branch);
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
        branch
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
      log: correlatedLogger
    });

    // Clear cancellation flag and progress on successful completion
    await clearIndexingCancellation(fullName, branch);
    await clearIndexingProgress(fullName, branch);

  } catch (error) {
    await handleIndexingError(error, repoPath, options, correlatedLogger);
  }
}

function applyDirectoryFallbackResult(batchResult: ProcessBatchesResult, dirResult: AggregateDirectoriesResult): void {
  if (!dirResult.fallbackUsed || batchResult.fallbackUsed) return;
  batchResult.fallbackUsed = true;
  batchResult.fallbackPrimaryAgentAlias = dirResult.fallbackPrimaryAgentAlias;
  batchResult.fallbackAgentAlias = dirResult.fallbackAgentAlias;
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
  await clearIndexingCancellation(repoName, errorBranch);
  await clearIndexingProgress(repoName, errorBranch);

  // Handle user-initiated cancellation
  if (error instanceof IndexingCancelledError) {
    correlatedLogger.info({ repoPath, fullName: repoName, branch: errorBranch }, 'Repository indexing was cancelled by user');
    // Reset DB status to idle so REST queries reflect the stopped state
    await updateRepositoryStatus(repoName, 'idle', errorBranch);
    // Publish idle now that the worker has fully stopped — this is the authoritative
    // terminal event so clients won't see stale progress updates afterward.
    await safePublishIndexingStatus(repoName, errorBranch, 'idle');
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
    await safePublishIndexingStatus(repoName, errorBranch, 'failed');
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
