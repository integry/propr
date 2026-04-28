import { Redis } from 'ioredis';
import { type IndexingPhase } from '@propr/shared';
import { getEventPublisher } from '../../utils/eventPublisher.js';

const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379', 10);

const CANCELLATION_KEY_PREFIX = 'indexing:cancel:';
const PROGRESS_KEY_PREFIX = 'indexing:progress:';
const CANCELLATION_TTL_SECONDS = 3600; // 1 hour TTL
const PROGRESS_TTL_SECONDS = 3600; // 1 hour TTL

export interface IndexingProgress {
  totalFiles: number;
  processedFiles: number;
  totalBatches: number;
  completedBatches: number;
  inputTokens: number;
  outputTokens: number;
  startedAt: number;
  // Directory aggregation phase
  totalDirectories: number;
  processedDirectories: number;
  phase: 'files' | 'directories' | 'completed';
}

let redisClient: Redis | null = null;

function getRedis(): Redis {
  if (!redisClient) {
    redisClient = new Redis({
      host: REDIS_HOST,
      port: REDIS_PORT,
      maxRetriesPerRequest: 3,
      lazyConnect: true,
    });
  }
  return redisClient;
}

function getCancellationKey(repository: string, branch = 'HEAD'): string {
  return `${CANCELLATION_KEY_PREFIX}${repository}:${branch}`;
}

/**
 * Request cancellation of an indexing job for a repository.
 * The worker will check this flag and stop processing.
 */
export async function requestIndexingCancellation(repository: string, branch = 'HEAD'): Promise<void> {
  const redis = getRedis();
  const key = getCancellationKey(repository, branch);
  await redis.set(key, '1', 'EX', CANCELLATION_TTL_SECONDS);
}

/**
 * Check if indexing has been cancelled for a repository.
 * Called by the worker during processing.
 */
export async function isIndexingCancelled(repository: string, branch = 'HEAD'): Promise<boolean> {
  const redis = getRedis();
  const key = getCancellationKey(repository, branch);
  const value = await redis.get(key);
  return value === '1';
}

/**
 * Clear the cancellation flag for a repository.
 * Called when indexing completes (success, failure, or cancellation).
 */
export async function clearIndexingCancellation(repository: string, branch = 'HEAD'): Promise<void> {
  const redis = getRedis();
  const key = getCancellationKey(repository, branch);
  await redis.del(key);
}

/**
 * Custom error thrown when indexing is cancelled by user.
 */
export class IndexingCancelledError extends Error {
  constructor(repository: string) {
    super(`Indexing cancelled by user for repository: ${repository}`);
    this.name = 'IndexingCancelledError';
  }
}

// --- Progress Tracking ---

function getProgressKey(repository: string, branch = 'HEAD'): string {
  return `${PROGRESS_KEY_PREFIX}${repository}:${branch}`;
}

/**
 * Initialize progress tracking for a repository.
 */
export async function initIndexingProgress(repository: string, totalFiles: number, branch = 'HEAD'): Promise<void> {
  const redis = getRedis();
  const key = getProgressKey(repository, branch);
  const progress: IndexingProgress = {
    totalFiles,
    processedFiles: 0,
    totalBatches: 0,
    completedBatches: 0,
    inputTokens: 0,
    outputTokens: 0,
    startedAt: Date.now(),
    totalDirectories: 0,
    processedDirectories: 0,
    phase: 'files',
  };
  await redis.set(key, JSON.stringify(progress), 'EX', PROGRESS_TTL_SECONDS);

  // Publish initial progress so clients see totalFiles and phase immediately.
  // Best-effort: don't let a pub/sub failure abort indexing.
  try {
    await publishProgress(repository, branch);
  } catch {
    // Swallow — progress publishing is non-critical
  }
}

/**
 * Update progress after processing a batch.
 * Returns the updated progress so callers can pass it to publishProgress
 * without an extra Redis read.
 */
export async function updateIndexingProgress(
  repository: string,
  update: {
    filesProcessed: number;
    batchCompleted: boolean;
    inputTokens: number;
    outputTokens: number;
  },
  branch = 'HEAD'
): Promise<IndexingProgress | null> {
  const redis = getRedis();
  const key = getProgressKey(repository, branch);
  const existing = await redis.get(key);
  if (!existing) return null;

  const progress: IndexingProgress = JSON.parse(existing);
  progress.processedFiles += update.filesProcessed;
  if (update.batchCompleted) {
    progress.completedBatches++;
  }
  progress.inputTokens += update.inputTokens;
  progress.outputTokens += update.outputTokens;

  await redis.set(key, JSON.stringify(progress), 'EX', PROGRESS_TTL_SECONDS);
  return progress;
}

/**
 * Set the total number of batches (known after first pass through files).
 */
export async function setTotalBatches(repository: string, totalBatches: number, branch = 'HEAD'): Promise<void> {
  const redis = getRedis();
  const key = getProgressKey(repository, branch);
  const existing = await redis.get(key);
  if (!existing) return;

  const progress: IndexingProgress = JSON.parse(existing);
  progress.totalBatches = totalBatches;
  await redis.set(key, JSON.stringify(progress), 'EX', PROGRESS_TTL_SECONDS);
}

/**
 * Start the directory aggregation phase.
 */
export async function startDirectoryPhase(repository: string, branch: string, totalDirectories: number): Promise<void> {
  const redis = getRedis();
  const key = getProgressKey(repository, branch);
  const existing = await redis.get(key);
  if (!existing) return;

  const progress: IndexingProgress = JSON.parse(existing);
  progress.phase = 'directories';
  progress.totalDirectories = totalDirectories;
  progress.processedDirectories = 0;
  await redis.set(key, JSON.stringify(progress), 'EX', PROGRESS_TTL_SECONDS);

  // Publish phase transition so clients see directory phase start immediately.
  // Best-effort: don't let a pub/sub failure abort indexing.
  try {
    await publishProgress(repository, branch);
  } catch {
    // Swallow — progress publishing is non-critical
  }
}

/**
 * Update progress after processing a directory.
 * Returns the updated progress so callers can pass it to publishProgress
 * without an extra Redis read.
 */
export async function updateDirectoryProgress(repository: string, branch = 'HEAD'): Promise<IndexingProgress | null> {
  const redis = getRedis();
  const key = getProgressKey(repository, branch);
  const existing = await redis.get(key);
  if (!existing) return null;

  const progress: IndexingProgress = JSON.parse(existing);
  progress.processedDirectories++;
  await redis.set(key, JSON.stringify(progress), 'EX', PROGRESS_TTL_SECONDS);
  return progress;
}

/**
 * Get current indexing progress for a repository.
 */
export async function getIndexingProgress(repository: string, branch = 'HEAD'): Promise<IndexingProgress | null> {
  const redis = getRedis();
  const key = getProgressKey(repository, branch);
  const data = await redis.get(key);
  if (!data) return null;
  return JSON.parse(data);
}

/**
 * Clear progress tracking for a repository.
 */
export async function clearIndexingProgress(repository: string, branch = 'HEAD'): Promise<void> {
  const redis = getRedis();
  const key = getProgressKey(repository, branch);
  await redis.del(key);
}

/**
 * Publish indexing progress to WebSocket clients via Redis pub/sub.
 * Accepts progress data directly to avoid a redundant Redis read on the hot path.
 * Falls back to reading from Redis if no progress data is provided (e.g. for phase transitions).
 */
export async function publishProgress(repository: string, branch: string, progressData?: IndexingProgress): Promise<void> {
  const progress = progressData ?? await getIndexingProgress(repository, branch);
  if (!progress) return;

  const totalItems = progress.phase === 'directories' ? progress.totalDirectories : progress.totalFiles;
  const processedItems = progress.phase === 'directories' ? progress.processedDirectories : progress.processedFiles;
  const percentComplete = totalItems > 0 ? Math.round((processedItems / totalItems) * 100) : 0;

  await getEventPublisher().publishIndexingUpdate({
    repository,
    branch,
    phase: progress.phase,
    progress: percentComplete,
    totalFiles: progress.totalFiles,
    processedFiles: progress.processedFiles,
    totalDirectories: progress.totalDirectories,
    processedDirectories: progress.processedDirectories,
  });
}

/**
 * Publish an indexing status change (e.g., indexing, completed, failed, idle) to WebSocket clients.
 */
export async function publishIndexingStatus(repository: string, branch: string, phase: IndexingPhase): Promise<void> {
  await getEventPublisher().publishIndexingUpdate({
    repository,
    branch,
    phase,
  });
}
