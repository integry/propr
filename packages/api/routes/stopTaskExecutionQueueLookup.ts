import type { Job } from 'bullmq';
import {
  getIssueQueue,
  getTaskIdFromQueueJob,
  logger,
  normalizeTaskId,
} from '@propr/core';
import type { QueueJobData } from './stopTaskExecutionContext.js';

const TRACKED_QUEUE_STATES = ['waiting', 'active', 'delayed', 'paused', 'prioritized', 'waiting-children'] as const;
const QUEUE_TASK_ID_SCAN_PAGE_SIZE = 100;
const QUEUE_TASK_ID_SCAN_MAX_JOBS_PER_STATE = 5000;

export async function findQueueJobByTaskIdScan(
  queue: Awaited<ReturnType<typeof getIssueQueue>>,
  candidateTaskIdSet: Set<string>,
  uniqueCandidates: string[],
): Promise<Job<QueueJobData> | null> {
  for (const trackedQueueState of TRACKED_QUEUE_STATES) {
    let start = 0;
    let jobs = await loadQueueScanPage(queue, trackedQueueState, start);
    while (jobs.length > 0) {
      const matchingJob = findMatchingQueueJob(jobs, candidateTaskIdSet, uniqueCandidates);
      if (matchingJob) {
        return matchingJob;
      }

      start += jobs.length;
      if (jobs.length < QUEUE_TASK_ID_SCAN_PAGE_SIZE) {
        break;
      }
      if (start >= QUEUE_TASK_ID_SCAN_MAX_JOBS_PER_STATE) {
        logger.warn({
          queueState: trackedQueueState,
          scannedJobs: start,
          taskReferenceCandidates: uniqueCandidates,
        }, 'Stopped fallback queued task-id scan after reaching the per-state scan bound');
        break;
      }
      jobs = await loadQueueScanPage(queue, trackedQueueState, start);
    }
  }

  return null;
}

async function loadQueueScanPage(
  queue: Awaited<ReturnType<typeof getIssueQueue>>,
  trackedQueueState: typeof TRACKED_QUEUE_STATES[number],
  start: number,
): Promise<Job<QueueJobData>[]> {
  const end = Math.min(
    start + QUEUE_TASK_ID_SCAN_PAGE_SIZE - 1,
    QUEUE_TASK_ID_SCAN_MAX_JOBS_PER_STATE - 1,
  );
  return await queue.getJobs([trackedQueueState], start, end) as unknown as Job<QueueJobData>[];
}

function findMatchingQueueJob(
  jobs: Job<QueueJobData>[],
  candidateTaskIdSet: Set<string>,
  uniqueCandidates: string[],
): Job<QueueJobData> | null {
  for (const job of jobs) {
    const derivedTaskId = getTaskIdFromQueueJob(job);
    const rawJobId = job.id === null || job.id === undefined ? null : String(job.id);
    const normalizedJobId = rawJobId === null ? null : normalizeTaskId(rawJobId);
    if (isCandidateQueueJob(candidateTaskIdSet, derivedTaskId, rawJobId, normalizedJobId)) {
      logger.info({
        taskReferenceCandidates: uniqueCandidates,
        queueJobId: rawJobId,
        derivedTaskId,
      }, 'Resolved queued task stop lookup via fallback task-id scan');
      return job;
    }
  }

  return null;
}

function isCandidateQueueJob(
  candidateTaskIdSet: Set<string>,
  derivedTaskId: string | null,
  rawJobId: string | null,
  normalizedJobId: string | null,
): boolean {
  return (derivedTaskId !== null && candidateTaskIdSet.has(derivedTaskId))
    || (rawJobId !== null && candidateTaskIdSet.has(rawJobId))
    || (normalizedJobId !== null && candidateTaskIdSet.has(normalizedJobId));
}
