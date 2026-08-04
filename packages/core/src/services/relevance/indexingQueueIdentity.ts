import { createHash, randomUUID } from 'node:crypto';
import { normalizeGithubRepositoryIdentity } from '@propr/shared';

export const INDEXING_FAILED_JOB_RETENTION = { age: 7 * 24 * 60 * 60, count: 1_000 } as const;
/** Fallback window in case promotion after durable producer acceptance fails. */
export const INDEXING_JOB_ACCEPTANCE_DELAY_MS = 60_000;

export function normalizeIndexingQueueBranch(branch?: string): string {
  return branch?.trim() || 'HEAD';
}

export function createIndexingRunIdentity(now: Date = new Date()): {
  runId: string;
  transitionAt: string;
} {
  return { runId: randomUUID(), transitionAt: now.toISOString() };
}

/** BullMQ's atomic repository/branch deduplication key for live indexing work. */
export function createIndexingQueueDeduplicationId(
  fullName: string,
  branch: string = 'HEAD'
): string {
  const normalizedRepository = normalizeGithubRepositoryIdentity(fullName);
  if (!normalizedRepository) {
    throw new TypeError('Indexing queue repository must be a GitHub owner/name identity');
  }
  const normalizedBranch = normalizeIndexingQueueBranch(branch);
  const digest = createHash('sha256')
    .update(`${normalizedRepository}\0${normalizedBranch}`)
    .digest('hex');
  return `index-repository-${digest}`;
}

/** A run-scoped job ID lets Queue.add() report whether deduplication accepted this run. */
export function createIndexingQueueJobId(
  fullName: string,
  branch: string = 'HEAD',
  runId?: string
): string {
  const deduplicationId = createIndexingQueueDeduplicationId(
    fullName,
    normalizeIndexingQueueBranch(branch)
  );
  return runId ? `${deduplicationId}-${runId}` : deduplicationId;
}

/** Stable ownership identity for pre-handshake jobs across BullMQ retries/reconstruction. */
export function createLegacyIndexingRunIdForJob(
  fullName: string,
  branch: string,
  jobId: string
): string {
  const normalizedJobId = jobId.trim();
  if (normalizedJobId.length === 0) {
    throw new TypeError('Indexing queue job ID must be non-blank');
  }
  const normalizedBranch = normalizeIndexingQueueBranch(branch);
  return `legacy-job-${createHash('sha256')
    .update(`${fullName.trim().toLowerCase()}\0${normalizedBranch}\0${normalizedJobId}`)
    .digest('hex')}`;
}
