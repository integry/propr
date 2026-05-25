import type { RedisClientType } from 'redis';

type RedisClientLike = Pick<RedisClientType, 'get' | 'set' | 'del'>;

export interface PersistedStopOutcome {
  containerId: string | null;
  containerStopped: boolean;
  jobRemoved: boolean;
}

const STOP_OUTCOME_KEY_PREFIX = 'worker:stop-outcome';
const STOP_OUTCOME_TTL_SECONDS = 24 * 60 * 60;

export function hasConcreteStopOutcome(stopOutcome: PersistedStopOutcome): boolean {
  return stopOutcome.containerStopped || stopOutcome.jobRemoved;
}

export function mergeStopOutcomes(
  persistedStopOutcome: PersistedStopOutcome,
  currentStopOutcome: PersistedStopOutcome,
): PersistedStopOutcome {
  return {
    containerId: currentStopOutcome.containerId ?? persistedStopOutcome.containerId,
    containerStopped: persistedStopOutcome.containerStopped || currentStopOutcome.containerStopped,
    jobRemoved: persistedStopOutcome.jobRemoved || currentStopOutcome.jobRemoved,
  };
}

export function resolveCancellationQueueState(
  stopOutcome: PersistedStopOutcome,
  queueState: string | null,
): string | null {
  if (stopOutcome.jobRemoved) {
    return 'removed_before_start';
  }

  if (queueState) {
    return queueState;
  }

  return null;
}

export async function loadPersistedStopOutcome(
  redisClient: RedisClientLike,
  taskIds: string | string[],
): Promise<PersistedStopOutcome> {
  let mergedOutcome: PersistedStopOutcome = { containerId: null, containerStopped: false, jobRemoved: false };
  for (const taskId of getUniqueTaskIds(taskIds)) {
    const outcomeData = await redisClient.get(getStopOutcomeKey(taskId));
    if (!outcomeData) {
      continue;
    }

    try {
      const outcome = JSON.parse(outcomeData) as Partial<PersistedStopOutcome>;
      mergedOutcome = mergeStopOutcomes(mergedOutcome, {
        containerId: typeof outcome.containerId === 'string' ? outcome.containerId : null,
        containerStopped: outcome.containerStopped === true,
        jobRemoved: outcome.jobRemoved === true,
      });
    } catch {
      await clearPersistedStopOutcome(redisClient, taskId);
    }
  }

  return mergedOutcome;
}

export async function persistStopOutcome(
  redisClient: RedisClientLike,
  taskIds: string | string[],
  stopOutcome: PersistedStopOutcome,
): Promise<void> {
  if (!hasConcreteStopOutcome(stopOutcome)) {
    return;
  }

  const serializedOutcome = JSON.stringify(stopOutcome);
  await Promise.all(getUniqueTaskIds(taskIds).map((taskId) => redisClient.set(
    getStopOutcomeKey(taskId),
    serializedOutcome,
    { EX: STOP_OUTCOME_TTL_SECONDS },
  )));
}

export async function clearPersistedStopOutcome(redisClient: RedisClientLike, taskIds: string | string[]): Promise<void> {
  await Promise.all(getUniqueTaskIds(taskIds).map((taskId) => redisClient.del(getStopOutcomeKey(taskId))));
}

function getStopOutcomeKey(taskId: string): string {
  return `${STOP_OUTCOME_KEY_PREFIX}:${taskId}`;
}

function getUniqueTaskIds(taskIds: string | string[]): string[] {
  return [...new Set((Array.isArray(taskIds) ? taskIds : [taskIds]).filter(Boolean))];
}
