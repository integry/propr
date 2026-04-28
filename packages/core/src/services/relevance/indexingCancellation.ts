import { Redis } from 'ioredis';
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
  phase: 'files' | 'directories' | 'done';
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

function getCancellationKey(repository: string): string {
  return `${CANCELLATION_KEY_PREFIX}${repository}`;
}

/**
 * Request cancellation of an indexing job for a repository.
 * The worker will check this flag and stop processing.
 */
export async function requestIndexingCancellation(repository: string): Promise<void> {
  const redis = getRedis();
  const key = getCancellationKey(repository);
  await redis.set(key, '1', 'EX', CANCELLATION_TTL_SECONDS);
}

/**
 * Check if indexing has been cancelled for a repository.
 * Called by the worker during processing.
 */
export async function isIndexingCancelled(repository: string): Promise<boolean> {
  const redis = getRedis();
  const key = getCancellationKey(repository);
  const value = await redis.get(key);
  return value === '1';
}

/**
 * Clear the cancellation flag for a repository.
 * Called when indexing completes (success, failure, or cancellation).
 */
export async function clearIndexingCancellation(repository: string): Promise<void> {
  const redis = getRedis();
  const key = getCancellationKey(repository);
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

function getProgressKey(repository: string): string {
  return `${PROGRESS_KEY_PREFIX}${repository}`;
}

/**
 * Initialize progress tracking for a repository.
 */
export async function initIndexingProgress(repository: string, totalFiles: number): Promise<void> {
  const redis = getRedis();
  const key = getProgressKey(repository);
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
}

/**
 * Update progress after processing a batch.
 */
export async function updateIndexingProgress(
  repository: string,
  update: {
    filesProcessed: number;
    batchCompleted: boolean;
    inputTokens: number;
    outputTokens: number;
  }
): Promise<void> {
  const redis = getRedis();
  const key = getProgressKey(repository);
  const existing = await redis.get(key);
  if (!existing) return;

  const progress: IndexingProgress = JSON.parse(existing);
  progress.processedFiles += update.filesProcessed;
  if (update.batchCompleted) {
    progress.completedBatches++;
  }
  progress.inputTokens += update.inputTokens;
  progress.outputTokens += update.outputTokens;

  await redis.set(key, JSON.stringify(progress), 'EX', PROGRESS_TTL_SECONDS);
}

/**
 * Set the total number of batches (known after first pass through files).
 */
export async function setTotalBatches(repository: string, totalBatches: number): Promise<void> {
  const redis = getRedis();
  const key = getProgressKey(repository);
  const existing = await redis.get(key);
  if (!existing) return;

  const progress: IndexingProgress = JSON.parse(existing);
  progress.totalBatches = totalBatches;
  await redis.set(key, JSON.stringify(progress), 'EX', PROGRESS_TTL_SECONDS);
}

/**
 * Start the directory aggregation phase.
 */
export async function startDirectoryPhase(repository: string, totalDirectories: number): Promise<void> {
  const redis = getRedis();
  const key = getProgressKey(repository);
  const existing = await redis.get(key);
  if (!existing) return;

  const progress: IndexingProgress = JSON.parse(existing);
  progress.phase = 'directories';
  progress.totalDirectories = totalDirectories;
  progress.processedDirectories = 0;
  await redis.set(key, JSON.stringify(progress), 'EX', PROGRESS_TTL_SECONDS);
}

/**
 * Update progress after processing a directory.
 */
export async function updateDirectoryProgress(repository: string): Promise<void> {
  const redis = getRedis();
  const key = getProgressKey(repository);
  const existing = await redis.get(key);
  if (!existing) return;

  const progress: IndexingProgress = JSON.parse(existing);
  progress.processedDirectories++;
  await redis.set(key, JSON.stringify(progress), 'EX', PROGRESS_TTL_SECONDS);
}

/**
 * Get current indexing progress for a repository.
 */
export async function getIndexingProgress(repository: string): Promise<IndexingProgress | null> {
  const redis = getRedis();
  const key = getProgressKey(repository);
  const data = await redis.get(key);
  if (!data) return null;
  return JSON.parse(data);
}

/**
 * Clear progress tracking for a repository.
 */
export async function clearIndexingProgress(repository: string): Promise<void> {
  const redis = getRedis();
  const key = getProgressKey(repository);
  await redis.del(key);
}

/**
 * Publish current indexing progress to WebSocket clients via Redis pub/sub.
 * Reads the current progress from Redis and broadcasts it.
 */
export async function publishProgress(repository: string, branch: string): Promise<void> {
  const progress = await getIndexingProgress(repository);
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
export async function publishIndexingStatus(repository: string, branch: string, phase: string): Promise<void> {
  await getEventPublisher().publishIndexingUpdate({
    repository,
    branch,
    phase,
  });
}
