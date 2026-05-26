import type { Job } from 'bullmq';
import {
  getIssueQueue,
  getPrNumberFromJobData,
  getRepositoryFromJobData,
  getTaskIdFromQueueJob,
  logger,
  normalizeTaskId,
} from '@propr/core';
import type { QueueJobData } from './stopTaskExecutionContext.js';
import type { CancellationTarget } from './stopTaskExecutionQueueIdentity.js';

const TRACKED_QUEUE_STATES = ['waiting', 'active', 'delayed', 'paused', 'prioritized', 'waiting-children'] as const;
const QUEUE_SCAN_PAGE_SIZE = 500;
const QUEUE_SCAN_MAX_JOBS = 12000;

export async function findQueueJobByTaskIdScan(
  queue: Awaited<ReturnType<typeof getIssueQueue>>,
  candidateTaskIdSet: Set<string>,
  uniqueCandidates: string[],
  cancellationTarget?: CancellationTarget,
): Promise<Job<QueueJobData> | null> {
  const startedAt = Date.now();
  let scannedJobs = 0;
  const targetMatches = new Map<string, Job<QueueJobData>>();
  for (const trackedQueueState of TRACKED_QUEUE_STATES) {
    let start = 0;
    while (true) {
      const jobs = await loadQueueScanState(queue, trackedQueueState, start);
      scannedJobs += jobs.length;
      const matchingJob = findMatchingQueueJob(jobs, candidateTaskIdSet);
      if (matchingJob) {
        logger.info({
          taskReferenceCandidates: uniqueCandidates,
          scannedJobs,
          durationMs: Date.now() - startedAt,
        }, 'Resolved queued task stop lookup via fallback task-id scan');
        return matchingJob;
      }
      collectTargetMatches(jobs, targetMatches, cancellationTarget);

      if (jobs.length < QUEUE_SCAN_PAGE_SIZE) {
        break;
      }

      if (scannedJobs >= QUEUE_SCAN_MAX_JOBS) {
        logger.warn({
          taskReferenceCandidates: uniqueCandidates,
          scannedJobs,
          maxJobs: QUEUE_SCAN_MAX_JOBS,
          durationMs: Date.now() - startedAt,
        }, 'Stopping fallback queued task-id scan after reaching scan limit');
        return null;
      }

      start += jobs.length;
    }
  }

  if (targetMatches.size === 1) {
    const [matchingJob] = targetMatches.values();
    logger.info({
      taskReferenceCandidates: uniqueCandidates,
      cancellationTarget,
      scannedJobs,
      durationMs: Date.now() - startedAt,
    }, 'Resolved queued task stop lookup via fallback PR-target scan');
    return matchingJob;
  }

  if (targetMatches.size > 1) {
    logger.warn({
      taskReferenceCandidates: uniqueCandidates,
      cancellationTarget,
      targetMatchCount: targetMatches.size,
      scannedJobs,
      durationMs: Date.now() - startedAt,
    }, 'Skipped fallback PR-target queue scan because multiple jobs matched');
  }

  if (scannedJobs > 0) {
    logger.info({
      taskReferenceCandidates: uniqueCandidates,
      scannedJobs,
      durationMs: Date.now() - startedAt,
    }, 'Fallback queued task-id scan completed without a match');
  }
  return null;
}

async function loadQueueScanState(
  queue: Awaited<ReturnType<typeof getIssueQueue>>,
  trackedQueueState: typeof TRACKED_QUEUE_STATES[number],
  start: number,
): Promise<Job<QueueJobData>[]> {
  return await queue.getJobs([trackedQueueState], start, start + QUEUE_SCAN_PAGE_SIZE - 1) as unknown as Job<QueueJobData>[];
}

function findMatchingQueueJob(
  jobs: Job<QueueJobData>[],
  candidateTaskIdSet: Set<string>,
): Job<QueueJobData> | null {
  for (const job of jobs) {
    const derivedTaskId = getTaskIdFromQueueJob(job);
    const rawJobId = job.id === null || job.id === undefined ? null : String(job.id);
    const normalizedJobId = rawJobId === null ? null : normalizeTaskId(rawJobId);
    if (isCandidateQueueJob(candidateTaskIdSet, derivedTaskId, rawJobId, normalizedJobId)) {
      return job;
    }
  }

  return null;
}

function collectTargetMatches(
  jobs: Job<QueueJobData>[],
  targetMatches: Map<string, Job<QueueJobData>>,
  cancellationTarget?: CancellationTarget,
): void {
  if (!cancellationTarget) {
    return;
  }

  for (const job of jobs) {
    if (!isCancellationTargetQueueJob(job, cancellationTarget)) {
      continue;
    }

    targetMatches.set(getQueueJobMapKey(job), job);
  }
}

function isCancellationTargetQueueJob(
  job: Job<QueueJobData>,
  cancellationTarget: CancellationTarget,
): boolean {
  return getRepositoryFromJobData(job.data) === cancellationTarget.repository
    && getPrNumberFromJobData(job.data) === cancellationTarget.prNumber;
}

function getQueueJobMapKey(job: Job<QueueJobData>): string {
  return job.id === null || job.id === undefined
    ? JSON.stringify(job.data)
    : String(job.id);
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
