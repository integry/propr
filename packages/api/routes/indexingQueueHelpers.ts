import { RedisClientType } from 'redis';
import * as configManager from '@propr/core';
import {
  getIndexingQueue, generateCorrelationId, ensureRepoCloned, getRepoUrl, getAuthenticatedOctokit,
  updateRepositoryStatus, requestIndexingCancellation, fetchLatestChanges
} from '@propr/core';
import type { IndexingJobData } from '@propr/core';
import { getEnabledResummarizationTargets } from './indexingRouteHelpers.js';

export interface QueueIndexingResult {
  success: boolean;
  error?: string;
  jobId?: string;
  correlationId?: string;
}

interface QueueResummarizationForRepoOptions {
  repoFullName: string;
  token: string;
  baseBranch?: string;
  queue?: Awaited<ReturnType<typeof getIndexingQueue>>;
  queuedRepoBranches?: Set<string>;
}

export async function queueResummarizationForAllRepos(): Promise<number> {
  const monitoredRepos = getEnabledResummarizationTargets(await configManager.loadMonitoredReposRaw());
  const queue = await getIndexingQueue();
  const existingJobs = await queue.getJobs(['waiting', 'active', 'delayed']);
  const queuedRepoBranches = new Set(
    existingJobs.map((job: { data: IndexingJobData }) =>
      getRepoBranchKey(job.data.repository, job.data.baseBranch)
    )
  );
  const octokit = await getAuthenticatedOctokit();
  const { token } = await octokit.auth({ type: 'installation' }) as { token: string };
  let repositoriesQueued = 0;

  for (const repoConfig of monitoredRepos) {
    const queued = await queueResummarizationForRepo({
      repoFullName: repoConfig.name,
      token,
      baseBranch: repoConfig.baseBranch,
      queue,
      queuedRepoBranches
    });
    if (queued) {
      repositoriesQueued++;
    }
  }
  return repositoriesQueued;
}

async function queueResummarizationForRepo({
  repoFullName,
  token,
  baseBranch,
  queue: queueArg,
  queuedRepoBranches
}: QueueResummarizationForRepoOptions): Promise<boolean> {
  const queue = queueArg ?? await getIndexingQueue();
  const [owner, name] = repoFullName.split('/');
  const effectiveBranch = baseBranch || 'HEAD';
  const repoBranchKey = getRepoBranchKey(repoFullName, baseBranch);
  const alreadyQueued = queuedRepoBranches
    ? queuedRepoBranches.has(repoBranchKey)
    : (await queue.getJobs(['waiting', 'active', 'delayed'])).some((j: { data: IndexingJobData }) =>
      getRepoBranchKey(j.data.repository, j.data.baseBranch) === repoBranchKey
    );
  if (alreadyQueued) {
    return false;
  }

  const repoUrl = getRepoUrl({ repoOwner: owner, repoName: name });
  let repoPath: string;
  try {
    repoPath = await ensureRepoCloned({ repoUrl, owner, repoName: name, authToken: token, baseBranch });
  } catch {
    console.error(`Failed to clone repository ${repoFullName} for resummarization`);
    return false;
  }

  const fetchResult = await fetchLatestChanges({
    owner,
    repoName: name,
    authToken: token,
    branch: baseBranch
  });

  if (!fetchResult.success) {
    console.warn(`Failed to fetch latest changes for ${repoFullName}: ${fetchResult.error}`);
  }

  const correlationId = generateCorrelationId();
  await queue.add(
    'indexRepository',
    {
      repository: repoFullName,
      repoPath,
      correlationId,
      priority: 'normal',
      fullReindex: true,
      baseBranch
    },
    {
      jobId: `index-${repoFullName.replace('/', '-')}-${sanitizeJobIdSegment(effectiveBranch)}-prompt-change-${Date.now()}`,
      priority: 2
    }
  );
  queuedRepoBranches?.add(repoBranchKey);
  return true;
}

function sanitizeJobIdSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, '-');
}

function getRepoBranchKey(repository: string, branch?: string): string {
  return `${repository}:${branch || 'HEAD'}`;
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

export async function queueIndexingJob(repository: string, fullReindex: boolean, baseBranch?: string): Promise<QueueIndexingResult> {
  const settings = await configManager.loadSummarizationSettings();
  if (!settings.enabled) {
    return { success: false, error: 'Summarization is not enabled. Enable it in settings first.' };
  }
  if (!settings.agent_alias) {
    return { success: false, error: 'No agent configured for summarization. Configure one in settings first.' };
  }

  const queue = await getIndexingQueue();
  const existingJobs = await queue.getJobs(['waiting', 'active', 'delayed']);
  const effectiveBranch = baseBranch || 'HEAD';
  const alreadyQueued = existingJobs.some((j: { data: IndexingJobData }) =>
    j.data.repository === repository && (j.data.baseBranch || 'HEAD') === effectiveBranch
  );
  if (alreadyQueued) {
    return { success: false, error: 'Indexing job already queued for this repository and branch' };
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
  const sanitizedBranch = sanitizeJobIdSegment(effectiveBranch);
  const job = await queue.add(
    'indexRepository',
    { repository, repoPath, correlationId, priority: 'high', fullReindex, baseBranch },
    { jobId: `index-${repository.replace('/', '-')}-${sanitizedBranch}-${correlationId}`, priority: 1 }
  );

  return { success: true, jobId: job.id, correlationId };
}

export async function stopIndexingJob(repository: string, branch?: string): Promise<{
  success: boolean;
  message?: string;
  cancelledActiveBranches: string[];
  removedQueuedBranches: string[];
}> {
  try {
    const queue = await getIndexingQueue();
    const jobs = await queue.getJobs(['active', 'waiting', 'delayed']);
    const matchingJobs = jobs.filter((j: { data: IndexingJobData }) => {
      if (j.data.repository !== repository) return false;
      if (branch) {
        return (j.data.baseBranch || 'HEAD') === branch;
      }
      return true;
    });

    const cancelledActiveBranches: string[] = [];
    const removedQueuedBranches: string[] = [];

    if (matchingJobs.length > 0) {
      for (const job of matchingJobs) {
        const jobBranch = job.data.baseBranch || 'HEAD';
        const state = await job.getState();
        if (state === 'active') {
          await requestIndexingCancellation(repository, jobBranch);
          await updateRepositoryStatus(repository, 'idle', jobBranch);
          cancelledActiveBranches.push(jobBranch);
        } else {
          await job.remove();
          await updateRepositoryStatus(repository, 'idle', jobBranch);
          removedQueuedBranches.push(jobBranch);
        }
      }
    } else if (branch) {
      await updateRepositoryStatus(repository, 'idle', branch);
      removedQueuedBranches.push(branch);
    } else {
      const statuses = await configManager.getRepositoriesIndexingStatus();
      const repoStatuses = statuses.filter(
        (s: { full_name: string }) => s.full_name === repository
      );
      for (const s of repoStatuses) {
        const statusBranch = s.branch || 'HEAD';
        await updateRepositoryStatus(repository, 'idle', statusBranch);
        removedQueuedBranches.push(statusBranch);
      }
      if (repoStatuses.length === 0) {
        await updateRepositoryStatus(repository, 'idle', 'HEAD');
        removedQueuedBranches.push('HEAD');
      }
    }

    return { success: true, cancelledActiveBranches, removedQueuedBranches };
  } catch (error) {
    console.error('Error stopping indexing job:', error);
    return { success: false, message: (error as Error).message, cancelledActiveBranches: [], removedQueuedBranches: [] };
  }
}
