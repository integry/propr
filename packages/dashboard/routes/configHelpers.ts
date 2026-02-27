import { RedisClientType } from 'redis';
import * as configManager from '@propr/core';
import { indexingQueue, generateCorrelationId, ensureRepoCloned, getRepoUrl, getAuthenticatedOctokit, updateRepositoryStatus, requestIndexingCancellation, fetchLatestChanges } from '@propr/core';
import type { IndexingJobData } from '@propr/core';

interface AgentConfig {
  id: string;
  type: string;
  alias: string;
  enabled: boolean;
  dockerImage: string;
  configPath: string;
  supportedModels: string[];
}

/**
 * Execute an operation with a Redis-based distributed lock.
 * This ensures only one config update can happen at a time for a given lock key.
 */
export async function withConfigLock(
  redisClient: RedisClientType,
  lockKey: string,
  operation: () => Promise<{ status: number; body: Record<string, unknown> }>
): Promise<{ status: number; body: Record<string, unknown> }> {
  const lockValue = `${Date.now()}-${Math.random()}`;
  const lockTimeout = 30;

  try {
    const acquired = await redisClient.set(lockKey, lockValue, {
      NX: true,
      EX: lockTimeout
    });

    if (!acquired) {
      return { status: 409, body: { error: 'Configuration is being updated. Please try again.' } };
    }

    try {
      return await operation();
    } finally {
      const currentLockValue = await redisClient.get(lockKey);
      if (currentLockValue === lockValue) {
        await redisClient.del(lockKey);
      }
    }
  } catch (error) {
    console.error(`Error in config operation with lock ${lockKey}:`, error);
    try {
      const currentLockValue = await redisClient.get(lockKey);
      if (currentLockValue === lockValue) {
        await redisClient.del(lockKey);
      }
    } catch (unlockError) {
      console.error('Error releasing lock:', unlockError);
    }
    return { status: 500, body: { error: 'Failed to update configuration' } };
  }
}

/**
 * Queue resummarization jobs for all monitored repositories.
 * Returns the number of repositories that were queued.
 */
export async function queueResummarizationForAllRepos(): Promise<number> {
  const monitoredRepos = await configManager.loadMonitoredRepos();
  const octokit = await getAuthenticatedOctokit();
  const { token } = await octokit.auth({ type: "installation" }) as { token: string };

  let repositoriesQueued = 0;

  for (const repoFullName of monitoredRepos) {
    const queued = await queueResummarizationForRepo(repoFullName, token);
    if (queued) {
      repositoriesQueued++;
    }
  }

  return repositoriesQueued;
}

/**
 * Queue a resummarization job for a single repository.
 * Returns true if successfully queued, false if already queued or failed.
 */
async function queueResummarizationForRepo(repoFullName: string, token: string): Promise<boolean> {
  const [owner, name] = repoFullName.split('/');

  // Check if job already queued
  const existingJobs = await indexingQueue.getJobs(['waiting', 'active', 'delayed']);
  const alreadyQueued = existingJobs.some((j: { data: IndexingJobData }) => j.data.repository === repoFullName);
  if (alreadyQueued) {
    return false;
  }

  // Ensure repo is cloned
  const repoUrl = getRepoUrl({ repoOwner: owner, repoName: name });
  let repoPath: string;
  try {
    repoPath = await ensureRepoCloned({ repoUrl, owner, repoName: name, authToken: token });
  } catch {
    console.error(`Failed to clone repository ${repoFullName} for resummarization`);
    return false;
  }

  // Fetch latest changes before queuing to ensure we have the most up-to-date code
  const fetchResult = await fetchLatestChanges({
    owner,
    repoName: name,
    authToken: token
  });

  if (!fetchResult.success) {
    // Log warning but continue - we'll index with existing local state
    console.warn(`Failed to fetch latest changes for ${repoFullName}: ${fetchResult.error}`);
  }

  // Queue the indexing job with fullReindex to apply new prompt
  const correlationId = generateCorrelationId();
  await indexingQueue.add(
    'indexRepository',
    {
      repository: repoFullName,
      repoPath,
      correlationId,
      priority: 'normal',
      fullReindex: true
    },
    {
      jobId: `index-${repoFullName.replace('/', '-')}-prompt-change-${Date.now()}`,
      priority: 2 // Lower priority than manual triggers
    }
  );

  return true;
}

const ALIAS_REGEX = /^[a-z0-9-]+$/;
const VALID_AGENT_TYPES = ['claude', 'codex', 'gemini'];

/**
 * Validate an array of agent configurations.
 * Returns null if valid, or an error message string if invalid.
 */
export function validateAgentsConfig(agents: AgentConfig[]): string | null {
  if (!Array.isArray(agents)) {
    return 'agents must be an array';
  }

  const seenAliases = new Set<string>();

  for (const agent of agents) {
    const error = validateSingleAgent(agent, seenAliases);
    if (error) return error;
    seenAliases.add(agent.alias);
  }

  return null;
}

function validateSingleAgent(agent: AgentConfig, seenAliases: Set<string>): string | null {
  if (!agent.id || typeof agent.id !== 'string') {
    return `Agent missing required 'id' field`;
  }
  if (!agent.type || !VALID_AGENT_TYPES.includes(agent.type)) {
    return `Agent '${agent.id}' has invalid type. Must be one of: ${VALID_AGENT_TYPES.join(', ')}`;
  }
  if (!agent.alias || typeof agent.alias !== 'string') {
    return `Agent '${agent.id}' missing required 'alias' field`;
  }
  if (!ALIAS_REGEX.test(agent.alias)) {
    return `Agent '${agent.id}' has invalid alias '${agent.alias}'. Must match pattern ^[a-z0-9-]+$`;
  }
  if (typeof agent.enabled !== 'boolean') {
    return `Agent '${agent.id}' missing required 'enabled' field`;
  }
  if (!agent.dockerImage || typeof agent.dockerImage !== 'string') {
    return `Agent '${agent.id}' missing required 'dockerImage' field`;
  }
  if (!agent.configPath || typeof agent.configPath !== 'string') {
    return `Agent '${agent.id}' missing required 'configPath' field`;
  }
  if (!Array.isArray(agent.supportedModels)) {
    return `Agent '${agent.id}' missing required 'supportedModels' field`;
  }
  if (seenAliases.has(agent.alias)) {
    return `Duplicate agent alias '${agent.alias}' found`;
  }
  return null;
}

export interface QueueIndexingResult {
  success: boolean;
  error?: string;
  jobId?: string;
  correlationId?: string;
}

// Redis key for storing the scheduled reindex timestamp
const DELAYED_REINDEX_KEY = 'config:summarization:delayed-reindex';
// Delay before automatic reindex after prompt change (10 minutes in milliseconds)
const REINDEX_DELAY_MS = 10 * 60 * 1000;

/**
 * Schedule a delayed reindex for all repositories.
 * If a reindex is already scheduled, it will be replaced with a new one.
 * Returns true if scheduled successfully.
 */
export async function scheduleDelayedReindex(redisClient: RedisClientType): Promise<boolean> {
  try {
    const scheduledTime = Date.now() + REINDEX_DELAY_MS;
    // Store the scheduled time in Redis with TTL slightly longer than delay
    await redisClient.set(DELAYED_REINDEX_KEY, scheduledTime.toString(), {
      EX: Math.ceil(REINDEX_DELAY_MS / 1000) + 60 // TTL = delay + 1 minute buffer
    });
    console.log(`Scheduled delayed reindex for ${new Date(scheduledTime).toISOString()}`);
    return true;
  } catch (error) {
    console.error('Error scheduling delayed reindex:', error);
    return false;
  }
}

/**
 * Cancel any scheduled delayed reindex.
 */
export async function cancelDelayedReindex(redisClient: RedisClientType): Promise<void> {
  try {
    await redisClient.del(DELAYED_REINDEX_KEY);
    console.log('Cancelled scheduled delayed reindex');
  } catch (error) {
    console.error('Error cancelling delayed reindex:', error);
  }
}

/**
 * Check if there's a scheduled delayed reindex and execute it if the time has passed.
 * This should be called periodically by a background job.
 */
export async function checkAndExecuteDelayedReindex(redisClient: RedisClientType): Promise<boolean> {
  try {
    const scheduledTimeStr = await redisClient.get(DELAYED_REINDEX_KEY);
    if (!scheduledTimeStr) {
      return false;
    }

    const scheduledTime = parseInt(scheduledTimeStr, 10);
    if (Date.now() >= scheduledTime) {
      // Time to execute the reindex
      await redisClient.del(DELAYED_REINDEX_KEY);
      const count = await queueResummarizationForAllRepos();
      console.log(`Executed delayed reindex for ${count} repositories`);
      return true;
    }

    return false;
  } catch (error) {
    console.error('Error checking/executing delayed reindex:', error);
    return false;
  }
}

/**
 * Queue an indexing job for a single repository.
 * Validates settings, checks for existing jobs, and clones if needed.
 */
export async function queueIndexingJob(repository: string, fullReindex: boolean, baseBranch?: string): Promise<QueueIndexingResult> {
  // Check if summarization is enabled
  const settings = await configManager.loadSummarizationSettings();
  if (!settings.enabled) {
    return { success: false, error: 'Summarization is not enabled. Enable it in settings first.' };
  }
  if (!settings.agent_alias) {
    return { success: false, error: 'No agent configured for summarization. Configure one in settings first.' };
  }

  // Check if job already queued
  const existingJobs = await indexingQueue.getJobs(['waiting', 'active', 'delayed']);
  const alreadyQueued = existingJobs.some((j: { data: IndexingJobData }) => j.data.repository === repository);
  if (alreadyQueued) {
    return { success: false, error: 'Indexing job already queued for this repository' };
  }

  // Clone and queue
  const [owner, name] = repository.split('/');
  const octokit = await getAuthenticatedOctokit();
  const { token } = await octokit.auth({ type: "installation" }) as { token: string };
  const repoUrl = getRepoUrl({ repoOwner: owner, repoName: name });

  let repoPath: string;
  try {
    repoPath = await ensureRepoCloned({ repoUrl, owner, repoName: name, authToken: token, baseBranch });
  } catch (cloneError) {
    return { success: false, error: `Failed to clone repository: ${(cloneError as Error).message}` };
  }

  // Fetch latest changes before queuing to ensure we have the most up-to-date code
  const fetchResult = await fetchLatestChanges({
    owner,
    repoName: name,
    authToken: token,
    branch: baseBranch
  });

  if (!fetchResult.success) {
    // Log warning but continue - we'll index with existing local state
    console.warn(`Failed to fetch latest changes for ${repository}: ${fetchResult.error}`);
  }

  const correlationId = generateCorrelationId();
  const job = await indexingQueue.add(
    'indexRepository',
    { repository, repoPath, correlationId, priority: 'high', fullReindex, baseBranch },
    { jobId: `index-${repository.replace('/', '-')}-${Date.now()}`, priority: 1 }
  );

  return { success: true, jobId: job.id, correlationId };
}

/**
 * Stop an indexing job for a repository and reset its status to idle.
 * For active jobs, sets a cancellation flag in Redis that the worker checks.
 * For waiting/delayed jobs, removes them from the queue directly.
 */
export async function stopIndexingJob(repository: string, branch?: string): Promise<{ success: boolean; message?: string }> {
  try {
    const jobs = await indexingQueue.getJobs(['active', 'waiting', 'delayed']);
    // Find job matching both repository and branch (if specified)
    const job = jobs.find((j: { data: IndexingJobData }) => {
      if (j.data.repository !== repository) return false;
      // If branch is specified, match it; otherwise match any job for this repo
      if (branch) {
        return j.data.baseBranch === branch;
      }
      return true;
    });

    if (job) {
      const state = await job.getState();
      if (state === 'active') {
        // Active jobs are locked by the worker. Set a cancellation flag in Redis
        // that the worker will check and stop processing gracefully.
        await requestIndexingCancellation(repository);
      } else {
        // Waiting/delayed jobs can be removed directly
        await job.remove();
      }
    }

    // Always force the status back to idle in the DB, even if no job was found
    // (to handle stuck states). Use branch if provided, otherwise default to 'HEAD'.
    await updateRepositoryStatus(repository, 'idle', branch || 'HEAD');

    return { success: true };
  } catch (error) {
    console.error('Error stopping indexing job:', error);
    return { success: false, message: (error as Error).message };
  }
}
