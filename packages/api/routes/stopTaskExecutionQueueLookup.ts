import type { Job } from 'bullmq';
import {
  getIssueQueue,
  getTaskIdFromQueueJob,
  logger,
  normalizeTaskId,
} from '@propr/core';
import type { QueueJobData } from './stopTaskExecutionContext.js';

const TRACKED_QUEUE_STATES = ['waiting', 'active', 'delayed', 'paused', 'prioritized', 'waiting-children'] as const;
const QUEUE_SCAN_PAGE_SIZE = 500;
const MAX_QUEUE_SCAN_JOBS = 10000;

export async function findQueueJobByTaskIdScan(
  queue: Awaited<ReturnType<typeof getIssueQueue>>,
  candidateTaskIdSet: Set<string>,
  uniqueCandidates: string[],
): Promise<Job<QueueJobData> | null> {
  const startedAt = Date.now();
  let scannedJobs = 0;
  for (const trackedQueueState of TRACKED_QUEUE_STATES) {
    let start = 0;
    while (scannedJobs < MAX_QUEUE_SCAN_JOBS) {
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

      if (jobs.length < QUEUE_SCAN_PAGE_SIZE) {
        break;
      }

      start += jobs.length;
    }
  }

  if (scannedJobs > 0) {
    logger.info({
      taskReferenceCandidates: uniqueCandidates,
      scannedJobs,
      durationMs: Date.now() - startedAt,
    }, 'Fallback queued task-id scan completed without a match');
  }
  if (scannedJobs >= MAX_QUEUE_SCAN_JOBS) {
    logger.warn({
      taskReferenceCandidates: uniqueCandidates,
      scannedJobs,
      maxQueueScanJobs: MAX_QUEUE_SCAN_JOBS,
      durationMs: Date.now() - startedAt,
    }, 'Fallback queued task-id scan stopped after reaching the scan cap');
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
