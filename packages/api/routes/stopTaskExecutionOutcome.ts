import type { RedisClientType } from 'redis';

type RedisClientLike = Pick<RedisClientType, 'get' | 'set' | 'del'>;

export interface PersistedStopOutcome {
  containerId: string | null;
  containerStopped: boolean;
  jobRemoved: boolean;
}

const STOP_OUTCOME_KEY_PREFIX = 'worker:stop-outcome';

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
  taskId: string,
): Promise<PersistedStopOutcome> {
  const outcomeData = await redisClient.get(getStopOutcomeKey(taskId));
  if (!outcomeData) {
    return { containerId: null, containerStopped: false, jobRemoved: false };
  }

  try {
    const outcome = JSON.parse(outcomeData) as Partial<PersistedStopOutcome>;
    return {
      containerId: typeof outcome.containerId === 'string' ? outcome.containerId : null,
      containerStopped: outcome.containerStopped === true,
      jobRemoved: outcome.jobRemoved === true,
    };
  } catch {
    await clearPersistedStopOutcome(redisClient, taskId);
    return { containerId: null, containerStopped: false, jobRemoved: false };
  }
}

export async function persistStopOutcome(
  redisClient: RedisClientLike,
  taskId: string,
  stopOutcome: PersistedStopOutcome,
): Promise<void> {
  if (!hasConcreteStopOutcome(stopOutcome)) {
    return;
  }

  await redisClient.set(getStopOutcomeKey(taskId), JSON.stringify(stopOutcome), { EX: 3600 });
}

export async function clearPersistedStopOutcome(redisClient: RedisClientLike, taskId: string): Promise<void> {
  await redisClient.del(getStopOutcomeKey(taskId));
}

function getStopOutcomeKey(taskId: string): string {
  return `${STOP_OUTCOME_KEY_PREFIX}:${taskId}`;
}
