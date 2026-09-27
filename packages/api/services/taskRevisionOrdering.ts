import type { WorkerStateManagerOptions } from '@propr/core';

export const DEFAULT_TASK_STATE_EXPIRY_SECONDS = 7 * 24 * 3600;

/** Cap on live revision entries, so a long-lived process cannot grow unbounded. */
const MAX_TRACKED_TASKS = 10_000;

export interface TaskRevisionCacheEntry {
  version: number;
  expiresAt: number;
}

export function readCachedTaskRevision(
  entry: TaskRevisionCacheEntry | undefined,
  now = Date.now(),
): number | undefined {
  return entry && entry.expiresAt > now ? entry.version : undefined;
}

export function shouldBroadcastTaskUpdate(
  latestVersion: number | undefined,
  incomingVersion: number | undefined,
  allowSeededEquality = false,
): boolean {
  if (incomingVersion !== undefined
    && (!Number.isSafeInteger(incomingVersion) || incomingVersion < 0)) return false;
  if (latestVersion === undefined) return true;
  if (incomingVersion === undefined) return false;
  return incomingVersion > latestVersion
    || (allowSeededEquality && incomingVersion === latestVersion);
}

export async function loadDurableTaskRevision(
  get: (key: string) => Promise<string | null>,
  taskId: string,
  options: Pick<WorkerStateManagerOptions, 'keyPrefix'> = {},
): Promise<number | undefined> {
  const stateValue = await get(`${options.keyPrefix ?? 'worker:state:'}${taskId}`);
  const isValidRevision = (value: number): boolean => (
    Number.isSafeInteger(value) && value >= 0
  );
  let stateRevision = Number.NaN;
  if (stateValue) {
    try {
      const parsed = JSON.parse(stateValue) as { version?: unknown };
      stateRevision = typeof parsed.version === 'number' && isValidRevision(parsed.version)
        ? parsed.version
        : Number.NaN;
    } catch {
      // A malformed/partially-written state cannot seed event ordering.
    }
  }
  return isValidRevision(stateRevision) ? stateRevision : undefined;
}

export interface TaskRevisionAdmission {
  /** Live revision baselines, keyed by task. Mutated in place when admitting. */
  cache: Map<string, TaskRevisionCacheEntry>;
  taskId: string;
  version: number | undefined;
  /** Durable worker-state baseline, consulted only on a cache miss. */
  seed: (taskId: string) => Promise<number | undefined>;
  stateExpirySeconds: () => number;
  now?: number;
}

/**
 * Decides whether a task event may be broadcast, recording an accepted
 * version as the task's new baseline so a replayed or out-of-order event
 * cannot rewind the feed.
 */
export async function admitTaskRevision(admission: TaskRevisionAdmission): Promise<boolean> {
  const { cache, taskId, version, seed, now = Date.now() } = admission;
  const cached = cache.get(taskId);
  let latestVersion = readCachedTaskRevision(cached, now);
  if (cached && latestVersion === undefined) cache.delete(taskId);

  let allowSeededEquality = false;
  if (latestVersion === undefined && version !== undefined) {
    try {
      latestVersion = await seed(taskId);
      allowSeededEquality = latestVersion !== undefined;
    } catch (error) {
      console.error(`[SocketService] Failed to seed task revision for ${taskId}:`, error);
      // A versioned pub/sub event is already self-ordering. Accept it as the
      // live baseline when durable state is transiently unavailable rather
      // than silently dropping the only update clients may receive.
      latestVersion = undefined;
    }
  }

  // During rolling upgrades, legacy events may be accepted until a
  // versioned producer establishes the ordered stream for this task.
  if (!shouldBroadcastTaskUpdate(latestVersion, version, allowSeededEquality)) return false;
  if (version !== undefined) {
    recordTaskRevision(cache, taskId, {
      version,
      expiresAt: now + Math.max(1, admission.stateExpirySeconds()) * 1000,
    });
  }
  return true;
}

function recordTaskRevision(
  cache: Map<string, TaskRevisionCacheEntry>,
  taskId: string,
  entry: TaskRevisionCacheEntry,
): void {
  // Re-inserted so the map stays in least-recently-accepted order for eviction.
  cache.delete(taskId);
  cache.set(taskId, entry);
  if (cache.size > MAX_TRACKED_TASKS) {
    const oldestTaskId = cache.keys().next().value;
    if (oldestTaskId !== undefined) cache.delete(oldestTaskId);
  }
}
