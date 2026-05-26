import { getStateManager, logger, TaskStates, type TaskState } from '@propr/core';
import type { RedisClientType } from 'redis';
import type { StopTaskCancellationReason, StopTaskExecutionDeps } from './stopTaskExecution.js';
import type { StopTaskContext } from './stopTaskExecutionContext.js';
import {
  hasDuplicateRecentConversationMessage,
  releaseConversationMessageFingerprintReservation,
  reserveConversationMessageFingerprint,
} from './stopTaskExecutionConversationDedupe.js';
import { buildStopMessageMetadata } from './stopTaskExecutionMetadata.js';

type RedisConversationClient = {
  rPush: RedisClientType['rPush'];
  lRange?: RedisClientType['lRange'];
  set?: RedisClientType['set'];
  del?: RedisClientType['del'];
};
type PendingStopRedisClient = Pick<RedisClientType, 'set' | 'rPush' | 'del'> & Partial<Pick<RedisClientType, 'lRange'>>;
type PendingStopReadClient = Pick<RedisClientType, 'get'> & Partial<Pick<RedisClientType, 'del'>>;
type PendingStopClearClient = Pick<RedisClientType, 'del'>;
const PENDING_STOP_REQUEST_KEY_PREFIX = 'worker:stop-requested';
const PENDING_STOP_REQUEST_TTL_SECONDS = 24 * 60 * 60;
const CORE_TASK_STATE_SET = new Set<string>(Object.values(TaskStates));

export interface PendingStopRequest {
  timestamp: string;
  requestedBy: string;
  reasonCode: string;
  reason: string;
  source: string;
  requestId?: string;
}

export async function pushStopConversationMessage(
  redisClient: RedisConversationClient,
  taskId: string,
  message: Record<string, unknown>,
): Promise<void> {
  const conversationKey = `conversation:${taskId}`;
  if (await hasDuplicateRecentConversationMessage(redisClient, conversationKey, message)) {
    return;
  }

  const reservation = await reserveConversationMessageFingerprint(redisClient, conversationKey, message);
  if (reservation.reserved === false) {
    return;
  }

  try {
    await redisClient.rPush(conversationKey, JSON.stringify(message));
  } catch (error) {
    await releaseConversationMessageFingerprintReservation(redisClient, reservation.dedupeKey);
    throw error;
  }
}

export async function persistTaskCancellation(params: {
  taskId: string;
  requestedBy: string;
  cancellation: StopTaskCancellationReason;
  queueState: string | null;
  containerId: string | null;
  containerStopped: boolean;
  jobRemoved: boolean;
  stopVerified: boolean;
  abortSignalArmed: boolean;
  deps: StopTaskExecutionDeps;
}): Promise<void> {
  const {
    taskId,
    requestedBy,
    cancellation,
    queueState,
    containerId,
    containerStopped,
    jobRemoved,
    stopVerified,
    abortSignalArmed,
    deps,
  } = params;
  const stateManager = (deps.getStateManager ?? getStateManager)();

  await stateManager.markTaskCancelled(taskId, requestedBy, {
    reason: cancellation.message,
    cancellation: {
      code: cancellation.code,
      message: cancellation.message,
      cancelledBy: requestedBy,
      source: getCancellationSource(cancellation),
      containerStopped,
      jobRemoved,
      ...(containerId ? { containerId } : {}),
      ...(cancellation.requestId ? { requestId: cancellation.requestId } : {}),
    },
    historyMetadata: {
      cancellation: {
        code: cancellation.code,
        message: cancellation.message,
      },
      requestedBy,
      containerStopped,
      jobRemoved,
      stopVerified,
      abortSignalArmed,
      ...(containerId ? { containerId } : {}),
      ...(queueState ? { queueState } : {}),
    },
  });
  logger.info({
    taskId,
    requestedBy,
    reasonCode: cancellation.code,
    queueState,
    containerId: containerId ?? null,
    containerStopped,
    jobRemoved,
    stopVerified,
    abortSignalArmed,
  }, 'Task marked as cancelled');
}

export async function persistPendingTaskCancellationRequest(params: {
  taskId: string;
  requestedBy: string;
  cancellation: StopTaskCancellationReason;
  currentState: string | null;
  queueState: string | null;
  containerId: string | null;
  abortSignalArmed: boolean;
  deps: StopTaskExecutionDeps;
}): Promise<void> {
  const {
    taskId,
    requestedBy,
    cancellation,
    currentState,
    queueState,
    containerId,
    abortSignalArmed,
    deps,
  } = params;
  if (!currentState) {
    return;
  }

  if (!isCoreTaskState(currentState)) {
    logger.warn({ taskId, currentState }, 'Skipping pending cancellation metadata for unknown task state');
    return;
  }

  const stateManager = (deps.getStateManager ?? getStateManager)();
  await stateManager.updateHistoryMetadata(taskId, currentState, {
    cancellationRequested: {
      code: cancellation.code,
      message: cancellation.message,
      requestedBy,
      source: getCancellationSource(cancellation),
      abortSignalArmed,
      ...(containerId ? { containerId } : {}),
      ...(queueState ? { queueState } : {}),
      ...(cancellation.requestId ? { requestId: cancellation.requestId } : {}),
    },
  });
  logger.info({
    taskId,
    requestedBy,
    reasonCode: cancellation.code,
    queueState,
    containerId: containerId ?? null,
    abortSignalArmed,
  }, 'Recorded pending task cancellation request');
}

export async function persistPendingCancellationRequest(params: {
  redisClient: PendingStopRedisClient;
  context: StopTaskContext;
  requestedBy: string;
  cancellation: StopTaskCancellationReason;
  resolvedQueueState: string | null;
  containerId: string | null;
  abortSignalArmed: boolean;
  timestamp: string;
  deps: StopTaskExecutionDeps;
}): Promise<void> {
  const {
    redisClient,
    context,
    requestedBy,
    cancellation,
    resolvedQueueState,
    containerId,
    abortSignalArmed,
    timestamp,
    deps,
  } = params;
  await persistPendingStopRequest(redisClient, context.abortTaskIds, {
    timestamp,
    requestedBy,
    reasonCode: cancellation.code,
    reason: cancellation.message,
    source: cancellation.source ?? 'task_stop',
    ...(cancellation.requestId ? { requestId: cancellation.requestId } : {}),
  });
  await persistPendingTaskCancellationRequest({
    taskId: context.taskId,
    requestedBy,
    cancellation,
    currentState: context.currentState,
    queueState: resolvedQueueState,
    containerId,
    abortSignalArmed,
    deps,
  });
  await pushStopConversationMessage(redisClient, context.taskId, {
    type: 'system',
    timestamp: new Date().toISOString(),
    content: 'Cancellation requested. Worker shutdown is still in progress.',
    level: 'info',
    metadata: buildStopMessageMetadata(cancellation, requestedBy),
  });
}

export async function loadPendingStopRequest(
  redisClient: PendingStopReadClient,
  taskId: string,
): Promise<PendingStopRequest | null> {
  const pendingStopRequestKey = getPendingStopRequestKey(taskId);
  const requestData = await redisClient.get(pendingStopRequestKey);
  if (!requestData) {
    return null;
  }

  try {
    const parsed = JSON.parse(requestData) as Partial<PendingStopRequest>;
    if (
      typeof parsed.timestamp !== 'string'
      || typeof parsed.requestedBy !== 'string'
      || typeof parsed.reasonCode !== 'string'
      || typeof parsed.reason !== 'string'
      || typeof parsed.source !== 'string'
      || (parsed.requestId !== undefined && typeof parsed.requestId !== 'string')
    ) {
      await clearMalformedPendingStopRequest(redisClient, taskId, pendingStopRequestKey);
      return null;
    }

    return {
      timestamp: parsed.timestamp,
      requestedBy: parsed.requestedBy,
      reasonCode: parsed.reasonCode,
      reason: parsed.reason,
      source: parsed.source,
      ...(parsed.requestId ? { requestId: parsed.requestId } : {}),
    };
  } catch {
    await clearMalformedPendingStopRequest(redisClient, taskId, pendingStopRequestKey);
    return null;
  }
}

export async function clearPendingStopRequest(
  redisClient: PendingStopClearClient,
  taskIds: string[],
): Promise<void> {
  for (const taskId of taskIds) {
    await redisClient.del(getPendingStopRequestKey(taskId));
  }
}

async function persistPendingStopRequest(
  redisClient: Pick<RedisClientType, 'set'>,
  taskIds: string[],
  pendingStopRequest: PendingStopRequest,
): Promise<void> {
  const stopPayload = JSON.stringify(pendingStopRequest);
  for (const taskId of taskIds) {
    await redisClient.set(
      getPendingStopRequestKey(taskId),
      stopPayload,
      { EX: PENDING_STOP_REQUEST_TTL_SECONDS },
    );
  }
}

function getPendingStopRequestKey(taskId: string): string {
  return `${PENDING_STOP_REQUEST_KEY_PREFIX}:${taskId}`;
}

function isCoreTaskState(state: string): state is TaskState {
  return CORE_TASK_STATE_SET.has(state);
}

async function clearMalformedPendingStopRequest(
  redisClient: PendingStopReadClient,
  taskId: string,
  pendingStopRequestKey: string,
): Promise<void> {
  if (!redisClient.del) {
    return;
  }

  await redisClient.del(pendingStopRequestKey);
  logger.warn({ taskId }, 'Cleared malformed pending stop request');
}

function getCancellationSource(cancellation: StopTaskCancellationReason): string {
  if (typeof cancellation.source === 'string' && cancellation.source.length > 0) {
    return cancellation.source;
  }

  if (cancellation.code === 'pull_request_merged') {
    return 'pull_request_merged';
  }

  return 'task_stop';
}
