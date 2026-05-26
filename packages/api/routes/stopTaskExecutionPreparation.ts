import type { RedisClientType } from 'redis';
import {
  ensureTaskStateForCancellation,
  type StopTaskContext,
} from './stopTaskExecutionContext.js';
import {
  getStopTaskActivity,
  getTaskContainerId,
  shouldAbortTask,
} from './stopTaskExecutionGuards.js';
import {
  removeQueuedJobAfterStateCreation,
  removeQueueJobIfNeeded,
} from './stopTaskExecutionQueueing.js';
import type { StopTaskExecutionDeps } from './stopTaskExecution.js';

type RedisClientLike = Pick<RedisClientType, 'get' | 'set' | 'del' | 'rPush' | 'lRange'>;

export async function prepareContextForStop(params: {
  context: StopTaskContext;
  redisClient: RedisClientLike;
  activity: ReturnType<typeof getStopTaskActivity>;
  shouldAbort: boolean;
  queueRemovalShouldPrecedeAbort: boolean;
}): Promise<{
  context: StopTaskContext;
  jobRemoved: boolean;
  queueStateAfterFailure: string | null;
  persistedStopOutcomeDuringStop: boolean;
  abortSignalArmed: boolean;
}> {
  const {
    redisClient,
    activity,
    shouldAbort,
    queueRemovalShouldPrecedeAbort,
  } = params;
  const { context } = params;
  let jobRemoved = false;
  let queueStateAfterFailure: string | null = null;
  let persistedStopOutcomeDuringStop = false;

  if (queueRemovalShouldPrecedeAbort) {
    ({ jobRemoved, queueStateAfterFailure, persistedStopOutcomeDuringStop } = await removeQueuedJobAfterStateCreation({
      context,
      activity,
      redisClient,
    }));
  }

  const abortSignalArmed = shouldArmAbortSignal({
    shouldAbort,
    queueRemovalShouldPrecedeAbort,
    jobRemoved,
    queueStateAfterFailure,
  });
  return {
    context,
    jobRemoved,
    queueStateAfterFailure,
    persistedStopOutcomeDuringStop,
    abortSignalArmed,
  };
}

export async function refreshContextForStop(
  context: StopTaskContext,
  deps: StopTaskExecutionDeps,
): Promise<{
  context: StopTaskContext;
  trackedContainerId: string | null;
  activity: ReturnType<typeof getStopTaskActivity>;
  shouldAbort: boolean;
  queueRemovalShouldPrecedeAbort: boolean;
}> {
  const initialTrackedContainerId = getTaskContainerId(context.state, context.currentState);
  const initialActivity = getStopTaskActivity(context.currentState, context.queueState, initialTrackedContainerId !== null);
  if (shouldRemoveQueueJobBeforeArmingAbort(initialActivity)) {
    const stateBackedContext = await ensureContextTaskStateForCancellation(context, deps);
    const trackedContainerId = getTaskContainerId(stateBackedContext.state, stateBackedContext.currentState);
    const activity = getStopTaskActivity(stateBackedContext.currentState, stateBackedContext.queueState, trackedContainerId !== null);
    return {
      context: stateBackedContext,
      trackedContainerId,
      activity,
      shouldAbort: shouldAbortTask(activity),
      queueRemovalShouldPrecedeAbort: true,
    };
  }

  const refreshedContext = await ensureContextTaskStateForCancellation(context, deps);
  const trackedContainerId = getTaskContainerId(refreshedContext.state, refreshedContext.currentState);
  const activity = getStopTaskActivity(refreshedContext.currentState, refreshedContext.queueState, trackedContainerId !== null);
  const shouldAbort = shouldAbortTask(activity);
  return {
    context: refreshedContext,
    trackedContainerId,
    activity,
    shouldAbort,
    queueRemovalShouldPrecedeAbort: shouldRemoveQueueJobBeforeArmingAbort(activity),
  };
}

export async function ensureContextTaskStateAfterQueueRemoval(params: {
  context: StopTaskContext;
  preparedStop: {
    jobRemoved: boolean;
    queueStateAfterFailure: string | null;
  };
  queueRemovalShouldPrecedeAbort: boolean;
  deps: StopTaskExecutionDeps;
}): Promise<StopTaskContext> {
  const {
    context,
    preparedStop,
    queueRemovalShouldPrecedeAbort,
    deps,
  } = params;
  if (!queueRemovalShouldPrecedeAbort) {
    return context;
  }

  if (!preparedStop.jobRemoved && preparedStop.queueStateAfterFailure !== 'active') {
    return context;
  }

  return ensureContextTaskStateForCancellation(context, deps);
}

export async function removeQueueJobAfterAbortIfNeeded(params: {
  context: StopTaskContext;
  activity: ReturnType<typeof getStopTaskActivity>;
  preparedStop: {
    jobRemoved: boolean;
    queueStateAfterFailure: string | null;
  };
  queueRemovalShouldPrecedeAbort: boolean;
}): Promise<void> {
  const {
    context,
    activity,
    preparedStop,
    queueRemovalShouldPrecedeAbort,
  } = params;
  if (queueRemovalShouldPrecedeAbort) {
    return;
  }

  const removalResult = await removeQueueJobIfNeeded(context.queueJob, activity.isQueuePreStart);
  preparedStop.jobRemoved = removalResult.jobRemoved;
  preparedStop.queueStateAfterFailure = removalResult.queueStateAfterFailure;
}

async function ensureContextTaskStateForCancellation(
  context: StopTaskContext,
  deps: StopTaskExecutionDeps,
): Promise<StopTaskContext> {
  const ensuredState = await (deps.ensureTaskStateForCancellation ?? ensureTaskStateForCancellation)(
    context.taskId,
    context.state,
    context.queueJob,
    deps,
  );
  if (!ensuredState) {
    return context;
  }

  return {
    ...context,
    state: ensuredState,
    currentState: ensuredState.history[ensuredState.history.length - 1]?.state ?? context.currentState,
  };
}

function shouldRemoveQueueJobBeforeArmingAbort(activity: ReturnType<typeof getStopTaskActivity>): boolean {
  return activity.isQueuePreStart
    && !activity.isRunningTaskState
    && !activity.isQueueActive
    && !activity.hasContainerToStop;
}

function shouldArmAbortSignal(params: {
  shouldAbort: boolean;
  queueRemovalShouldPrecedeAbort: boolean;
  jobRemoved: boolean;
  queueStateAfterFailure: string | null;
}): boolean {
  const {
    shouldAbort,
    queueRemovalShouldPrecedeAbort,
    jobRemoved,
    queueStateAfterFailure,
  } = params;
  if (!shouldAbort) {
    return false;
  }

  if (!queueRemovalShouldPrecedeAbort) {
    return true;
  }

  return !jobRemoved && queueStateAfterFailure === 'active';
}
