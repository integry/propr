import { Redis } from 'ioredis';
import { type IndexingPhase, type IndexingUpdatePayload } from '@propr/shared';
import { getEventPublisher } from '../../utils/eventPublisher.js';
import logger from '../../utils/logger.js';
import type { IndexingRunIdentity } from './summaryMinerQueries.js';

const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379', 10);
const CANCELLATION_KEY_PREFIX = 'indexing:cancel:';
const SCOPED_CANCELLATION_KEY_PREFIX = 'indexing:cancel:v2:';
const PROGRESS_KEY_PREFIX = 'indexing:progress:';
const CANCELLATION_TTL_SECONDS = 3600;
const PROGRESS_TTL_SECONDS = 3600;

const REQUEST_CANCELLATION_SCRIPT = `
  redis.call('SET', KEYS[1], '1', 'EX', ARGV[2])
  redis.call('SET', KEYS[2], ARGV[1], 'EX', ARGV[2])
  return 1
`;

const IS_CANCELLATION_REQUESTED_SCRIPT = `
  local legacy = redis.call('GET', KEYS[1])
  local scoped = redis.call('GET', KEYS[2])
  local run_id = ARGV[1]
  local function matches(value)
    return value and (run_id == '' or value == run_id or value == '*' or value == '1')
  end
  if not scoped then return matches(legacy) and 1 or 0 end
  if matches(scoped) then return 1 end
  if matches(legacy) and redis.call('PTTL', KEYS[1]) > redis.call('PTTL', KEYS[2]) then
    return 1
  end
  return 0
`;

const CLEAR_CANCELLATION_SCRIPT = `
  local legacy = redis.call('GET', KEYS[1])
  local scoped = redis.call('GET', KEYS[2])
  local run_id = ARGV[1]
  local function matches(value)
    return value and (run_id == '' or value == run_id or value == '*' or value == '1')
  end
  if run_id == '' then
    local removed = redis.call('DEL', KEYS[1])
    return removed + redis.call('DEL', KEYS[2])
  end
  if scoped then
    local legacy_ttl = legacy and redis.call('PTTL', KEYS[1]) or -2
    local scoped_ttl = redis.call('PTTL', KEYS[2])
    if matches(scoped) then
      local removed = redis.call('DEL', KEYS[2])
      if matches(legacy) and legacy_ttl <= scoped_ttl then
        removed = removed + redis.call('DEL', KEYS[1])
      end
      return removed
    end
    if matches(legacy) and legacy_ttl > scoped_ttl then
      return redis.call('DEL', KEYS[1])
    end
    return 0
  end
  if matches(legacy) then return redis.call('DEL', KEYS[1]) end
  return 0
`;

const CLEAR_PROGRESS_IF_RUN_MATCHES_SCRIPT = `
  local value = redis.call('GET', KEYS[1])
  if not value then return 0 end
  if ARGV[1] == '' then return redis.call('DEL', KEYS[1]) end
  local progress = cjson.decode(value)
  if (progress.runId or '') == ARGV[1] then return redis.call('DEL', KEYS[1]) end
  return 0
`;

const INIT_PROGRESS_SCRIPT = `
  local existingRaw = redis.call('GET', KEYS[1])
  if existingRaw then
    local existing = cjson.decode(existingRaw)
    local existingRun = existing.runId or ''
    local incomingRun = ARGV[2]
    if existingRun == incomingRun then return existingRaw end
    if existingRun ~= '' and incomingRun == '' then return existingRaw end
    local existingTransition = existing.transitionAt or ''
    if existingRun ~= '' and existingTransition ~= '' and existingTransition >= ARGV[3] then
      return existingRaw
    end
  end
  redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[4])
  return ARGV[1]
`;

const MUTATE_PROGRESS_SCRIPT = `
  local raw = redis.call('GET', KEYS[1])
  if not raw then return nil end
  local progress = cjson.decode(raw)
  local expectedRun = ARGV[1]
  if expectedRun ~= '' and (progress.runId or '') ~= expectedRun then return nil end
  local action = ARGV[2]
  if action == 'batch' then
    progress.processedFiles = progress.processedFiles + tonumber(ARGV[3])
    if ARGV[4] == '1' then progress.completedBatches = progress.completedBatches + 1 end
    progress.inputTokens = progress.inputTokens + tonumber(ARGV[5])
    progress.outputTokens = progress.outputTokens + tonumber(ARGV[6])
  elseif action == 'total-batches' then
    progress.totalBatches = tonumber(ARGV[3])
  elseif action == 'start-directories' then
    progress.phase = 'directories'
    progress.totalDirectories = tonumber(ARGV[3])
    progress.processedDirectories = 0
  elseif action == 'directory' then
    progress.processedDirectories = progress.processedDirectories + 1
  end
  local updated = cjson.encode(progress)
  redis.call('SET', KEYS[1], updated, 'EX', ARGV[7])
  return updated
`;

export interface IndexingProgress {
  totalFiles: number;
  processedFiles: number;
  totalBatches: number;
  completedBatches: number;
  inputTokens: number;
  outputTokens: number;
  startedAt: number;
  totalDirectories: number;
  processedDirectories: number;
  phase: 'files' | 'directories' | 'completed';
  runId?: string;
  transitionAt?: string;
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

function getScopedCancellationKey(repository: string, branch = 'HEAD'): string {
  return `${SCOPED_CANCELLATION_KEY_PREFIX}${repository}:${branch}`;
}

function getProgressKey(repository: string, branch = 'HEAD'): string {
  return `${PROGRESS_KEY_PREFIX}${repository}:${branch}`;
}

export async function requestIndexingCancellation(
  repository: string,
  branch = 'HEAD',
  runId?: string
): Promise<void> {
  // Keep writing the legacy wildcard throughout rolling deployments so old
  // workers still stop. New workers use the v2 key for run-scoped matching.
  await getRedis().eval(
    REQUEST_CANCELLATION_SCRIPT,
    2,
    getCancellationKey(repository, branch),
    getScopedCancellationKey(repository, branch),
    runId ?? '*',
    String(CANCELLATION_TTL_SECONDS)
  );
}

export async function isIndexingCancelled(
  repository: string,
  branch = 'HEAD',
  runId?: string
): Promise<boolean> {
  const requested = await getRedis().eval(
    IS_CANCELLATION_REQUESTED_SCRIPT,
    2,
    getCancellationKey(repository, branch),
    getScopedCancellationKey(repository, branch),
    runId ?? ''
  );
  return Number(requested) === 1;
}

export async function clearIndexingCancellation(
  repository: string,
  branch = 'HEAD',
  runId?: string
): Promise<void> {
  await getRedis().eval(
    CLEAR_CANCELLATION_SCRIPT,
    2,
    getCancellationKey(repository, branch),
    getScopedCancellationKey(repository, branch),
    runId ?? ''
  );
}

export async function clearIndexingRuntimeStateBestEffort(
  repository: string,
  branch: string,
  runId: string
): Promise<void> {
  const cleanup = await Promise.allSettled([
    clearIndexingCancellation(repository, branch, runId),
    clearIndexingProgress(repository, branch, runId)
  ]);
  const failures = cleanup.filter((result) => result.status === 'rejected');
  if (failures.length > 0) {
    logger.warn({ repository, branch, runId, failures: failures.length },
      'Failed to fully clear indexing runtime state');
  }
}

export class IndexingCancelledError extends Error {
  constructor(repository: string) {
    super(`Indexing cancelled by user for repository: ${repository}`);
    this.name = 'IndexingCancelledError';
  }
}

export async function initIndexingProgress(
  repository: string,
  totalFiles: number,
  branch = 'HEAD',
  indexingRun?: IndexingRunIdentity
): Promise<void> {
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
    ...(indexingRun ?? {})
  };
  const stored = await getRedis().eval(
    INIT_PROGRESS_SCRIPT,
    1,
    getProgressKey(repository, branch),
    JSON.stringify(progress),
    indexingRun?.runId ?? '',
    indexingRun?.transitionAt ?? '',
    String(PROGRESS_TTL_SECONDS)
  ) as string;
  const current = JSON.parse(stored) as IndexingProgress;
  if (indexingRun && current.runId !== indexingRun.runId) return;
  try { await publishProgress(repository, branch, current); } catch { /* best-effort */ }
}

export async function ensureIndexingProgress(
  repository: string,
  branch = 'HEAD',
  indexingRun?: IndexingRunIdentity
): Promise<void> {
  const existing = await getIndexingProgress(repository, branch, indexingRun?.runId);
  if (existing) return;
  await initIndexingProgress(repository, 0, branch, indexingRun);
}

async function mutateProgress(input: {
  repository: string;
  branch: string;
  runId?: string;
  action: 'batch' | 'total-batches' | 'start-directories' | 'directory';
  values?: [number?, boolean?, number?, number?];
}): Promise<IndexingProgress | null> {
  const values = input.values ?? [];
  const result = await getRedis().eval(
    MUTATE_PROGRESS_SCRIPT,
    1,
    getProgressKey(input.repository, input.branch),
    input.runId ?? '',
    input.action,
    String(values[0] ?? 0),
    values[1] ? '1' : '0',
    String(values[2] ?? 0),
    String(values[3] ?? 0),
    String(PROGRESS_TTL_SECONDS)
  ) as string | null;
  return result ? JSON.parse(result) as IndexingProgress : null;
}

export async function updateIndexingProgress(
  repository: string,
  update: {
    filesProcessed: number;
    batchCompleted: boolean;
    inputTokens: number;
    outputTokens: number;
  },
  branch = 'HEAD',
  runId?: string
): Promise<IndexingProgress | null> {
  return mutateProgress({
    repository,
    branch,
    runId,
    action: 'batch',
    values: [update.filesProcessed, update.batchCompleted, update.inputTokens, update.outputTokens]
  });
}

export async function setTotalBatches(
  repository: string,
  totalBatches: number,
  branch = 'HEAD',
  runId?: string
): Promise<void> {
  await mutateProgress({ repository, branch, runId, action: 'total-batches', values: [totalBatches] });
}

export async function startDirectoryPhase(
  repository: string,
  branch: string,
  totalDirectories: number,
  runId?: string
): Promise<void> {
  const progress = await mutateProgress({
    repository,
    branch,
    runId,
    action: 'start-directories',
    values: [totalDirectories]
  });
  if (!progress) return;
  try { await publishProgress(repository, branch, progress); } catch { /* best-effort */ }
}

export async function updateDirectoryProgress(
  repository: string,
  branch = 'HEAD',
  runId?: string
): Promise<IndexingProgress | null> {
  return mutateProgress({ repository, branch, runId, action: 'directory' });
}

export async function getIndexingProgress(
  repository: string,
  branch = 'HEAD',
  runId?: string
): Promise<IndexingProgress | null> {
  const data = await getRedis().get(getProgressKey(repository, branch));
  if (!data) return null;
  const progress = JSON.parse(data) as IndexingProgress;
  return runId !== undefined && progress.runId !== runId ? null : progress;
}

export async function clearIndexingProgress(
  repository: string,
  branch = 'HEAD',
  runId?: string
): Promise<void> {
  await getRedis().eval(
    CLEAR_PROGRESS_IF_RUN_MATCHES_SCRIPT,
    1,
    getProgressKey(repository, branch),
    runId ?? ''
  );
}

export async function publishProgress(
  repository: string,
  branch: string,
  progressData?: IndexingProgress
): Promise<void> {
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
    transitionAt: progress.transitionAt,
    runId: progress.runId
  });
}

export async function publishIndexingStatus(
  repository: string,
  branch: string,
  phase: IndexingPhase,
  transition?: IndexingRunIdentity
): Promise<void> {
  const payload: Pick<
    IndexingUpdatePayload,
    'repository' | 'branch' | 'phase' | 'progress' | 'transitionAt' | 'runId'
  > = {
    repository,
    branch,
    phase,
    ...(transition === undefined ? {} : {
      runId: transition.runId,
      transitionAt: transition.transitionAt
    })
  };
  if (phase === 'completed') payload.progress = 100;
  await getEventPublisher().publishIndexingUpdate(payload);
}
