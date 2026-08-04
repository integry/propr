import {
  db as coreDb,
  INDEXING_WORKER_HEARTBEAT_STALE_MS,
} from '@propr/core';

export type ServiceStatus =
  | 'connected' | 'disconnected' | 'active' | 'queued' | 'idle' | 'failed' | 'unknown';

export interface IndexingStatusQueue {
  getJobCounts(...statuses: Array<'active' | 'waiting' | 'delayed'>): Promise<Record<string, number>>;
}

export interface IndexingHealth {
  activity: ServiceStatus;
  service: ServiceStatus;
}

export const INDEXING_WORKER_MAX_FUTURE_SKEW_MS = 60_000;

export async function loadRepositoryIndexingStatus(
  database = coreDb
): Promise<ServiceStatus | undefined> {
  if (!await database.schema.hasTable('repositories')) return undefined;
  const failed = await database('repositories')
    .whereRaw('lower(indexing_status) = ?', ['failed'])
    .first('indexing_status');
  if (failed) return 'failed';
  const active = await database('repositories')
    .whereRaw('lower(indexing_status) = ?', ['indexing'])
    .first('indexing_status');
  if (active) return 'active';
  return await database('repositories').first('indexing_status') ? 'idle' : undefined;
}

export async function getIndexingHealth(
  getIndexingQueue: () => Promise<IndexingStatusQueue>,
  getRepositoryStatus: () => Promise<ServiceStatus | undefined>,
  indexingWorkerStatus: ServiceStatus = 'unknown'
): Promise<IndexingHealth> {
  try {
    const [indexingQueue, repositoryStatus] = await Promise.all([
      getIndexingQueue(),
      getRepositoryStatus(),
    ]);
    const counts = await indexingQueue.getJobCounts('active', 'waiting', 'delayed');
    const service = indexingWorkerStatus === 'connected'
      ? 'connected'
      : indexingWorkerStatus === 'disconnected' ? 'disconnected' : 'unknown';
    if ((counts.active ?? 0) > 0) return { activity: 'active', service };
    if ((counts.waiting ?? 0) > 0 || (counts.delayed ?? 0) > 0) {
      return { activity: 'queued', service };
    }
    return { activity: repositoryStatus ?? 'idle', service };
  } catch {
    return { activity: 'disconnected', service: 'disconnected' };
  }
}

export function resolveIndexingWorkerStatus(
  heartbeat: string | null,
  currentTime: number
): ServiceStatus {
  if (!heartbeat) return 'disconnected';
  const observedAt = Number(heartbeat);
  const age = currentTime - observedAt;
  return Number.isFinite(observedAt)
    && age >= -INDEXING_WORKER_MAX_FUTURE_SKEW_MS
    && age < INDEXING_WORKER_HEARTBEAT_STALE_MS
    ? 'connected'
    : 'disconnected';
}
