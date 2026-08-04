import { RedisClientType } from 'redis';
import * as configManager from '@propr/core';
import {
  getIndexingQueue, generateCorrelationId, ensureRepoCloned, getRepoUrl, getAuthenticatedOctokit,
  updateRepositoryStatus, createIndexingRunIdentity, createIndexingQueueDeduplicationId,
  createIndexingQueueJobId, INDEXING_FAILED_JOB_RETENTION,
  INDEXING_JOB_ACCEPTANCE_DELAY_MS,
  fetchLatestChanges, publishIndexingStatus, db, logger
} from '@propr/core';
import type { IndexingJobData, RepositoryStatusTransition } from '@propr/core';
import { getEnabledResummarizationTargets } from './indexingRouteHelpers.js';
import { publishIndexingRunBestEffort } from './indexingStatusPublication.js';
export { stopIndexingJob } from './indexingStop.js';
export type { IndexingStopTransition, StopIndexingResult } from './indexingStop.js';

export interface QueueIndexingResult {
  success: boolean;
  error?: string;
  jobId?: string;
  correlationId?: string;
  baseBranch?: string;
}

interface QueueResummarizationForRepoOptions {
  repoFullName: string;
  token: string;
  baseBranch?: string;
  ignoreCooldown?: boolean;
  queue?: Awaited<ReturnType<typeof getIndexingQueue>>;
  queuedRepoBranches?: Set<string>;
  deps: QueueResummarizationDeps;
}

export interface QueueResummarizationResult {
  queued: number;
  skippedCooldown: number;
  skippedAlreadyQueued: number;
  failedClone: number;
}

type QueueResummarizationForRepoResult = 'queued' | 'skippedCooldown' | 'skippedAlreadyQueued' | 'failedClone';

interface QueueResummarizationDeps {
  loadMonitoredReposRaw: typeof configManager.loadMonitoredReposRaw;
  getIndexingQueue: typeof getIndexingQueue;
  getAuthenticatedOctokit: typeof getAuthenticatedOctokit;
  getSummarizationCooldown: typeof configManager.getSummarizationCooldown;
  ensureRepoCloned: typeof ensureRepoCloned;
  fetchLatestChanges: typeof fetchLatestChanges;
  getRepoUrl: typeof getRepoUrl;
  createIndexingRunIdentity: typeof createIndexingRunIdentity;
  updateRepositoryStatus: typeof updateRepositoryStatus;
  publishIndexingStatus: typeof publishIndexingStatus;
}

interface QueueResummarizationOptions {
  ignoreCooldown?: boolean;
  deps?: Partial<QueueResummarizationDeps>;
}

function getQueueResummarizationDeps(overrides: Partial<QueueResummarizationDeps> = {}): QueueResummarizationDeps {
  return {
    loadMonitoredReposRaw: configManager.loadMonitoredReposRaw,
    getIndexingQueue,
    getAuthenticatedOctokit,
    getSummarizationCooldown: configManager.getSummarizationCooldown,
    ensureRepoCloned,
    fetchLatestChanges,
    getRepoUrl,
    createIndexingRunIdentity,
    updateRepositoryStatus,
    publishIndexingStatus,
    ...overrides
  };
}

export async function queueResummarizationForAllRepos(options: QueueResummarizationOptions = {}): Promise<QueueResummarizationResult> {
  const deps = getQueueResummarizationDeps(options.deps);
  const monitoredRepos = getEnabledResummarizationTargets(await deps.loadMonitoredReposRaw());
  const queue = await deps.getIndexingQueue();
  const existingJobs = await queue.getJobs(['waiting', 'active', 'delayed', 'prioritized']);
  const queuedRepoBranches = new Set(
    existingJobs.map((job: { data: IndexingJobData }) =>
      getRepoBranchKey(job.data.repository, job.data.baseBranch)
    )
  );
  const octokit = await deps.getAuthenticatedOctokit();
  const { token } = await octokit.auth({ type: 'installation' }) as { token: string };
  const result: QueueResummarizationResult = {
    queued: 0,
    skippedCooldown: 0,
    skippedAlreadyQueued: 0,
    failedClone: 0
  };

  for (const repoConfig of monitoredRepos) {
    const repoResult = await queueResummarizationForRepo({
      repoFullName: repoConfig.name,
      token,
      baseBranch: repoConfig.baseBranch,
      ignoreCooldown: options.ignoreCooldown,
      queue,
      queuedRepoBranches,
      deps
    });
    result[repoResult]++;
  }
  return result;
}

async function queueResummarizationForRepo({
  repoFullName,
  token,
  baseBranch,
  ignoreCooldown = false,
  queue: queueArg,
  queuedRepoBranches,
  deps
}: QueueResummarizationForRepoOptions): Promise<QueueResummarizationForRepoResult> {
  const queue = queueArg ?? await deps.getIndexingQueue();
  const [owner, name] = repoFullName.split('/');
  const effectiveBranch = configManager.normalizeSummarizationBranch(baseBranch);
  const repoBranchKey = getRepoBranchKey(repoFullName, baseBranch);
  const alreadyQueued = queuedRepoBranches
    ? queuedRepoBranches.has(repoBranchKey)
    : (await queue.getJobs(['waiting', 'active', 'delayed', 'prioritized'])).some((j: { data: IndexingJobData }) =>
      getRepoBranchKey(j.data.repository, j.data.baseBranch) === repoBranchKey
    );
  if (alreadyQueued) {
    return 'skippedAlreadyQueued';
  }
  const cooldown = ignoreCooldown ? null : await deps.getSummarizationCooldown(repoFullName, effectiveBranch);
  if (cooldown) {
    logger.warn({ repository: repoFullName, branch: effectiveBranch, until: cooldown.until },
      'Skipping resummarization during cooldown');
    return 'skippedCooldown';
  }

  const repoUrl = deps.getRepoUrl({ repoOwner: owner, repoName: name });
  let repoPath: string;
  try {
    repoPath = await deps.ensureRepoCloned({ repoUrl, owner, repoName: name, authToken: token, baseBranch });
  } catch {
    logger.error({ repository: repoFullName }, 'Failed to clone repository for resummarization');
    return 'failedClone';
  }

  const fetchResult = await deps.fetchLatestChanges({
    owner,
    repoName: name,
    authToken: token,
    branch: baseBranch
  });

  if (!fetchResult.success) {
    logger.warn({ repository: repoFullName, error: fetchResult.error },
      'Failed to fetch latest changes before resummarization');
  }

  const correlationId = generateCorrelationId();
  const requestedRun = deps.createIndexingRunIdentity();
  const deduplicationId = createIndexingQueueDeduplicationId(repoFullName, effectiveBranch);
  const jobId = createIndexingQueueJobId(repoFullName, effectiveBranch, requestedRun.runId);
  const job = await queue.add(
    'indexRepository',
    {
      repository: repoFullName,
      repoPath,
      correlationId,
      priority: 'normal',
      fullReindex: true,
      // Persist the normalized branch so cooldown/dedup/status checks (which all
      // normalize to HEAD) stay consistent with the stored job payload.
      baseBranch: effectiveBranch,
      ignoreCooldown,
      ...requestedRun
    },
    {
      jobId,
      deduplication: { id: deduplicationId },
      priority: 2,
      delay: INDEXING_JOB_ACCEPTANCE_DELAY_MS,
      removeOnComplete: true,
      removeOnFail: INDEXING_FAILED_JOB_RETENTION
    }
  );
  // BullMQ returns the existing job's ID when its atomic deduplication key wins.
  // The returned run-scoped ID remains decisive even if that job is removed
  // immediately after Queue.add() completes.
  if (job.id !== jobId) return 'skippedAlreadyQueued';
  let acceptedRun: RepositoryStatusTransition;
  try {
    acceptedRun = await deps.updateRepositoryStatus(repoFullName, 'indexing', effectiveBranch, {
      ...requestedRun,
      startNewRun: true
    });
  } catch (error) {
    if (typeof job.remove === 'function') {
      await job.remove().catch((removeError) => {
        logger.warn({
          repository: repoFullName,
          branch: effectiveBranch,
          runId: requestedRun.runId,
          error: removeError instanceof Error ? removeError.message : String(removeError)
        }, 'Rejected indexing job remains queued behind the durable-acceptance fence');
      });
    }
    throw error;
  }
  if (!acceptedRun.applied) {
    // A concurrent stop can tombstone the delayed run before producer
    // acceptance. Leave any removal race behind the consumer-side fence.
    queuedRepoBranches?.add(repoBranchKey);
    return 'queued';
  }
  if (typeof job.updateData === 'function') {
    try {
      await job.updateData({ ...job.data, ...acceptedRun, durablyAccepted: true });
    } catch (error) {
      logger.debug({ repository: repoFullName, runId: acceptedRun.runId, error },
        'Indexing job left the queue before its accepted identity could be enriched');
    }
  }
  if (typeof job.promote === 'function') {
    await job.promote().catch((error) => {
      logger.warn({ repository: repoFullName, runId: acceptedRun.runId, error },
        'Durably accepted indexing job will wait for its fallback delay');
    });
  }
  await publishIndexingRunBestEffort({
    publisher: deps.publishIndexingStatus, repository: repoFullName,
    branch: effectiveBranch, phase: 'indexing', transition: acceptedRun
  });
  queuedRepoBranches?.add(repoBranchKey);
  return 'queued';
}

function getRepoBranchKey(repository: string, branch?: string): string {
  return `${repository.trim().toLowerCase()}:${configManager.normalizeSummarizationBranch(branch)}`;
}

const DELAYED_REINDEX_KEY = 'config:summarization:delayed-reindex';
const REINDEX_DELAY_MS = 10 * 60 * 1000;

export async function scheduleDelayedReindex(redisClient: RedisClientType): Promise<boolean> {
  try {
    const scheduledTime = Date.now() + REINDEX_DELAY_MS;
    await redisClient.set(DELAYED_REINDEX_KEY, scheduledTime.toString(), { EX: Math.ceil(REINDEX_DELAY_MS / 1000) + 60 });
    console.log(`Scheduled delayed reindex for ${new Date(scheduledTime).toISOString()}`);
    return true;
  } catch (error) {
    logger.error({ error }, 'Error scheduling delayed reindex');
    return false;
  }
}

export async function cancelDelayedReindex(redisClient: RedisClientType): Promise<void> {
  try {
    await redisClient.del(DELAYED_REINDEX_KEY);
    console.log('Cancelled scheduled delayed reindex');
  } catch (error) {
    logger.error({ error }, 'Error cancelling delayed reindex');
  }
}

export async function checkAndExecuteDelayedReindex(redisClient: RedisClientType): Promise<boolean> {
  try {
    const scheduledTimeStr = await redisClient.get(DELAYED_REINDEX_KEY);
    if (!scheduledTimeStr) return false;
    const scheduledTime = parseInt(scheduledTimeStr, 10);
    if (Date.now() >= scheduledTime) {
      await redisClient.del(DELAYED_REINDEX_KEY);
      const result = await queueResummarizationForAllRepos();
      console.log(`Executed delayed reindex for ${result.queued} repositories`);
      return true;
    }
    return false;
  } catch (error) {
    logger.error({ error }, 'Error checking or executing delayed reindex');
    return false;
  }
}

export async function queueIndexingJob(
  repository: string,
  fullReindex: boolean,
  baseBranch?: string,
  options: { ignoreCooldown?: boolean } = {}
): Promise<QueueIndexingResult> {
  const settings = await configManager.loadSummarizationSettings();
  if (!settings.enabled) {
    return { success: false, error: 'Summarization is not enabled. Enable it in settings first.' };
  }
  if (!settings.agent_alias) {
    return { success: false, error: 'No agent configured for summarization. Configure one in settings first.' };
  }

  const queue = await getIndexingQueue();
  const existingJobs = await queue.getJobs(['waiting', 'active', 'delayed', 'prioritized']);
  const effectiveBranch = configManager.normalizeSummarizationBranch(baseBranch);
  const alreadyQueued = existingJobs.some((j: { data: IndexingJobData }) =>
    j.data.repository.toLowerCase() === repository.toLowerCase()
      && configManager.normalizeSummarizationBranch(j.data.baseBranch) === effectiveBranch
  );
  if (alreadyQueued) {
    return { success: false, error: 'Indexing job already queued for this repository and branch' };
  }
  const cooldown = options.ignoreCooldown ? null : await configManager.getSummarizationCooldown(repository, effectiveBranch);
  if (cooldown) {
    return {
      success: false,
      error: `Summarization is in cooldown for this repository and branch until ${cooldown.until}: ${cooldown.reason}`
    };
  }

  // Resume-on-failure: a full reindex requested while the repo is in a 'failed'
  // state should continue the existing index (reuse summaries already produced,
  // only process the missing/changed files) rather than reprocessing every file
  // from scratch. Partial progress from the failed run is preserved, recovery is
  // far cheaper, and it won't re-fail on files that already succeeded.
  let effectiveFullReindex = fullReindex;
  if (fullReindex) {
    const repoRow = await db('repositories')
      .whereRaw('lower(full_name) = ?', [repository.trim().toLowerCase()])
      .where({ branch: effectiveBranch })
      .first() as { indexing_status?: string } | undefined;
    if (repoRow?.indexing_status === 'failed') {
      effectiveFullReindex = false;
      console.log(`Full reindex requested for failed repo ${repository} (${effectiveBranch}); resuming existing index instead of starting over`);
    }
  }

  const [owner, name] = repository.split('/');
  const octokit = await getAuthenticatedOctokit();
  const { token } = await octokit.auth({ type: 'installation' }) as { token: string };
  const repoUrl = getRepoUrl({ repoOwner: owner, repoName: name });
  let repoPath: string;
  try {
    repoPath = await ensureRepoCloned({ repoUrl, owner, repoName: name, authToken: token, baseBranch });
  } catch (cloneError) {
    return { success: false, error: `Failed to clone repository: ${(cloneError as Error).message}` };
  }

  const fetchResult = await fetchLatestChanges({ owner, repoName: name, authToken: token, branch: baseBranch });
  if (!fetchResult.success) {
    logger.warn({ repository, error: fetchResult.error },
      'Failed to fetch latest changes before indexing');
  }

  const correlationId = generateCorrelationId();
  const requestedRun = createIndexingRunIdentity();
  const deduplicationId = createIndexingQueueDeduplicationId(repository, effectiveBranch);
  const jobId = createIndexingQueueJobId(repository, effectiveBranch, requestedRun.runId);
  const job = await queue.add(
    'indexRepository',
    {
      repository, repoPath, correlationId, priority: 'high',
      fullReindex: effectiveFullReindex, baseBranch: effectiveBranch,
      ignoreCooldown: options.ignoreCooldown,
      ...requestedRun
    },
    {
      jobId,
      deduplication: { id: deduplicationId },
      priority: 1,
      delay: INDEXING_JOB_ACCEPTANCE_DELAY_MS,
      removeOnComplete: true,
      removeOnFail: INDEXING_FAILED_JOB_RETENTION
    }
  );
  if (job.id !== jobId) {
    return { success: false, error: 'Indexing job already queued for this repository and branch' };
  }
  let acceptedRun: RepositoryStatusTransition;
  try {
    acceptedRun = await updateRepositoryStatus(repository, 'indexing', effectiveBranch, {
      ...requestedRun,
      startNewRun: true
    });
  } catch (error) {
    await job.remove().catch((removeError) => {
      logger.warn({
        repository,
        branch: effectiveBranch,
        runId: requestedRun.runId,
        error: removeError instanceof Error ? removeError.message : String(removeError)
      }, 'Rejected indexing job remains queued behind the durable-acceptance fence');
    });
    throw error;
  }
  if (!acceptedRun.applied) {
    return {
      success: true,
      jobId: job.id,
      correlationId,
      baseBranch: effectiveBranch
    };
  }
  try {
    await job.updateData({ ...job.data, ...acceptedRun, durablyAccepted: true });
  } catch (error) {
    logger.debug({ repository, runId: acceptedRun.runId, error },
      'Indexing job left the queue before its accepted identity could be enriched');
  }
  if (typeof job.promote === 'function') {
    await job.promote().catch((error) => {
      logger.warn({ repository, runId: acceptedRun.runId, error },
        'Durably accepted indexing job will wait for its fallback delay');
    });
  }
  await publishIndexingRunBestEffort({
    publisher: publishIndexingStatus, repository,
    branch: effectiveBranch, phase: 'indexing', transition: acceptedRun
  });

  // Return the normalized branch so callers report/match the same value that was
  // stored on the job and used to update repository status.
  return {
    success: true,
    jobId: job.id,
    correlationId,
    baseBranch: effectiveBranch
  };
}
