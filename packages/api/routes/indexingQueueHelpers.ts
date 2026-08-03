import { RedisClientType } from 'redis';
import * as configManager from '@propr/core';
import {
  getIndexingQueue, generateCorrelationId, ensureRepoCloned, getRepoUrl, getAuthenticatedOctokit,
  updateRepositoryStatus, createIndexingRunIdentity, createIndexingQueueDeduplicationId,
  createIndexingQueueJobId,
  requestIndexingCancellation, fetchLatestChanges, publishIndexingStatus, db
} from '@propr/core';
import type { IndexingJobData } from '@propr/core';
import { getEnabledResummarizationTargets } from './indexingRouteHelpers.js';
import { publishIndexingRunBestEffort } from './indexingStatusPublication.js';

export interface QueueIndexingResult {
  success: boolean;
  error?: string;
  jobId?: string;
  correlationId?: string;
  baseBranch?: string;
}

export interface StopIndexingResult {
  success: boolean;
  message?: string;
  cancelledActiveRuns: IndexingStopTransition[];
  removedQueuedRuns: IndexingStopTransition[];
}

export interface IndexingStopTransition {
  branch: string;
  transitionAt: string;
  runId: string;
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
  publishIndexingStatus: typeof publishIndexingStatus;
}

interface QueueResummarizationOptions {
  ignoreCooldown?: boolean;
  deps?: Partial<QueueResummarizationDeps>;
}

interface StopIndexingDeps {
  getIndexingQueue: typeof getIndexingQueue;
  requestIndexingCancellation: typeof requestIndexingCancellation;
  updateRepositoryStatus: typeof updateRepositoryStatus;
  publishIndexingStatus: typeof publishIndexingStatus;
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
    console.warn(`Skipping resummarization for ${repoFullName} (${effectiveBranch}) during cooldown until ${cooldown.until}`);
    return 'skippedCooldown';
  }

  const repoUrl = deps.getRepoUrl({ repoOwner: owner, repoName: name });
  let repoPath: string;
  try {
    repoPath = await deps.ensureRepoCloned({ repoUrl, owner, repoName: name, authToken: token, baseBranch });
  } catch {
    console.error(`Failed to clone repository ${repoFullName} for resummarization`);
    return 'failedClone';
  }

  const fetchResult = await deps.fetchLatestChanges({
    owner,
    repoName: name,
    authToken: token,
    branch: baseBranch
  });

  if (!fetchResult.success) {
    console.warn(`Failed to fetch latest changes for ${repoFullName}: ${fetchResult.error}`);
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
      removeOnComplete: true,
      removeOnFail: true
    }
  );
  // BullMQ returns the existing job's ID when its atomic deduplication key wins.
  // The returned run-scoped ID remains decisive even if that job is removed
  // immediately after Queue.add() completes.
  if (job.id !== jobId) return 'skippedAlreadyQueued';
  await publishIndexingRunBestEffort({
    publisher: deps.publishIndexingStatus, repository: repoFullName,
    branch: effectiveBranch, phase: 'indexing', transition: requestedRun
  });
  queuedRepoBranches?.add(repoBranchKey);
  return 'queued';
}

function getRepoBranchKey(repository: string, branch?: string): string {
  return `${repository}:${configManager.normalizeSummarizationBranch(branch)}`;
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
    console.error('Error scheduling delayed reindex:', error);
    return false;
  }
}

export async function cancelDelayedReindex(redisClient: RedisClientType): Promise<void> {
  try {
    await redisClient.del(DELAYED_REINDEX_KEY);
    console.log('Cancelled scheduled delayed reindex');
  } catch (error) {
    console.error('Error cancelling delayed reindex:', error);
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
    console.error('Error checking/executing delayed reindex:', error);
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
    j.data.repository === repository && configManager.normalizeSummarizationBranch(j.data.baseBranch) === effectiveBranch
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
      .where({ full_name: repository, branch: effectiveBranch })
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
  if (!fetchResult.success) console.warn(`Failed to fetch latest changes for ${repository}: ${fetchResult.error}`);

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
      removeOnComplete: true,
      removeOnFail: true
    }
  );
  if (job.id !== jobId) {
    return { success: false, error: 'Indexing job already queued for this repository and branch' };
  }
  await publishIndexingRunBestEffort({
    publisher: publishIndexingStatus, repository,
    branch: effectiveBranch, phase: 'indexing', transition: requestedRun
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

export async function stopIndexingJob(
  repository: string,
  branch?: string,
  overrides: Partial<StopIndexingDeps> = {}
): Promise<StopIndexingResult> {
  const deps: StopIndexingDeps = {
    getIndexingQueue,
    requestIndexingCancellation,
    updateRepositoryStatus,
    publishIndexingStatus,
    ...overrides
  };
  try {
    const queue = await deps.getIndexingQueue();
    const jobs = await queue.getJobs(['active', 'waiting', 'delayed', 'prioritized']);
    const matchingJobs = jobs.filter((j: { data: IndexingJobData }) => {
      if (j.data.repository !== repository) return false;
      if (branch) {
        return configManager.normalizeSummarizationBranch(j.data.baseBranch) === configManager.normalizeSummarizationBranch(branch);
      }
      return true;
    });

    const cancelledActiveRuns: IndexingStopTransition[] = [];
    const removedQueuedRuns: IndexingStopTransition[] = [];

    for (const job of matchingJobs) {
      const jobBranch = configManager.normalizeSummarizationBranch(job.data.baseBranch);
      const runId = job.data.runId;
      const state = await job.getState();
      if (state === 'active') {
        await deps.requestIndexingCancellation(repository, jobBranch, runId);
        const transition = await deps.updateRepositoryStatus(repository, 'idle', jobBranch, {
          ...(runId ? { runId } : {})
        });
        if (!transition.applied) continue;
        await publishIndexingRunBestEffort({
          publisher: deps.publishIndexingStatus, repository,
          branch: jobBranch, phase: 'idle', transition
        });
        cancelledActiveRuns.push({
          branch: jobBranch,
          runId: transition.runId,
          transitionAt: transition.transitionAt
        });
        continue;
      }

      await job.remove();
      const transition = await deps.updateRepositoryStatus(repository, 'idle', jobBranch, {
        ...(runId ? { runId } : {})
      });
      if (!transition.applied) continue;
      await publishIndexingRunBestEffort({
        publisher: deps.publishIndexingStatus, repository,
        branch: jobBranch, phase: 'idle', transition
      });
      removedQueuedRuns.push({
        branch: jobBranch,
        runId: transition.runId,
        transitionAt: transition.transitionAt
      });
    }

    return { success: true, cancelledActiveRuns, removedQueuedRuns };
  } catch (error) {
    console.error('Error stopping indexing job:', error);
    return { success: false, message: (error as Error).message, cancelledActiveRuns: [], removedQueuedRuns: [] };
  }
}
