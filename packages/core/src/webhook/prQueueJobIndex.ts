import type { Job } from 'bullmq';

const TRACKED_PR_QUEUE_STATES = new Set(['waiting', 'active', 'delayed']);
const PR_QUEUE_JOB_INDEX_TTL_SECONDS = 24 * 60 * 60;

type QueueLike = {
  getJob: (jobId: string) => Promise<Job | undefined | null>;
  client: Promise<PrQueueIndexRedisLike>;
};

type PrQueueIndexRedisLike = {
  expire: (key: string, seconds: number) => Promise<unknown>;
  sAdd?: (key: string, ...members: string[]) => Promise<unknown>;
  sRem?: (key: string, ...members: string[]) => Promise<unknown>;
  sMembers?: (key: string) => Promise<string[]>;
  sadd?: (key: string, ...members: string[]) => Promise<unknown>;
  srem?: (key: string, ...members: string[]) => Promise<unknown>;
  smembers?: (key: string) => Promise<string[]>;
};

export async function trackPrQueueJob(
  queue: QueueLike,
  repository: string,
  prNumber: number,
  jobId: string,
): Promise<void> {
  const client = await queue.client;
  const key = getPrQueueJobIndexKey(repository, prNumber);

  if (client.sAdd) {
    await client.sAdd(key, jobId);
  } else if (client.sadd) {
    await client.sadd(key, jobId);
  }

  await client.expire(key, PR_QUEUE_JOB_INDEX_TTL_SECONDS);
}

export async function getTrackedPrQueueJobs(
  queue: QueueLike,
  repository: string,
  prNumber: number,
): Promise<Array<{ jobId: string; state: string }>> {
  const client = await queue.client;
  const key = getPrQueueJobIndexKey(repository, prNumber);
  const jobIds = client.sMembers
    ? await client.sMembers(key)
    : client.smembers
      ? await client.smembers(key)
      : [];

  if (jobIds.length === 0) {
    return [];
  }

  const staleJobIds: string[] = [];
  const trackedJobs: Array<{ jobId: string; state: string }> = [];

  for (const jobId of jobIds) {
    const job = await queue.getJob(jobId);
    if (!job) {
      staleJobIds.push(jobId);
      continue;
    }

    const state = await job.getState();
    if (TRACKED_PR_QUEUE_STATES.has(state)) {
      trackedJobs.push({ jobId, state });
      continue;
    }

    staleJobIds.push(jobId);
  }

  if (staleJobIds.length > 0) {
    if (client.sRem) {
      await client.sRem(key, ...staleJobIds);
    } else if (client.srem) {
      await client.srem(key, ...staleJobIds);
    }
  }

  return trackedJobs;
}

function getPrQueueJobIndexKey(repository: string, prNumber: number): string {
  return `pr-queue-jobs:${repository}:${prNumber}`;
}
