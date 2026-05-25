import { getStateManager, logger, type TaskState } from '@propr/core';
import type { RedisClientType } from 'redis';
import type { StopTaskCancellationReason, StopTaskExecutionDeps } from './stopTaskExecution.js';
import type { StopTaskContext } from './stopTaskExecutionContext.js';

type RedisConversationClient = Pick<RedisClientType, 'rPush'> & Partial<Pick<RedisClientType, 'lRange'>>;
type PendingStopRedisClient = Pick<RedisClientType, 'set' | 'rPush'> & Partial<Pick<RedisClientType, 'lRange'>>;
type PendingStopReadClient = Pick<RedisClientType, 'get'>;
type PendingStopClearClient = Pick<RedisClientType, 'del'>;
const RECENT_DUPLICATE_MESSAGE_LIMIT = 5;
const RECENT_DUPLICATE_MESSAGE_WINDOW_MS = 5 * 60 * 1000;
const PENDING_STOP_REQUEST_KEY_PREFIX = 'worker:stop-requested';
const PENDING_STOP_REQUEST_TTL_SECONDS = 24 * 60 * 60;

export interface PendingStopRequest {
  timestamp: string;
  requestedBy: string;
  reasonCode: string;
  reason: string;
  source: string;
}

export async function pushStopConversationMessage(
  redisClient: RedisConversationClient,
  taskId: string,
  message: Record<string, unknown>,
): Promise<void> {
  const conversationKey = `conversation:${taskId}`;
  if (await isDuplicateConversationMessage(redisClient, conversationKey, message)) {
    return;
  }

  await redisClient.rPush(conversationKey, JSON.stringify(message));
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

  const stateManager = (deps.getStateManager ?? getStateManager)();
  await stateManager.updateHistoryMetadata(taskId, currentState as TaskState, {
    cancellationRequested: {
      code: cancellation.code,
      message: cancellation.message,
      requestedBy,
      source: getCancellationSource(cancellation),
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
    metadata: { reasonCode: cancellation.code, requestedBy },
  });
}

export async function loadPendingStopRequest(
  redisClient: PendingStopReadClient,
  taskId: string,
): Promise<PendingStopRequest | null> {
  const requestData = await redisClient.get(getPendingStopRequestKey(taskId));
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
    ) {
      return null;
    }

    return {
      timestamp: parsed.timestamp,
      requestedBy: parsed.requestedBy,
      reasonCode: parsed.reasonCode,
      reason: parsed.reason,
      source: parsed.source,
    };
  } catch {
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

function getCancellationSource(cancellation: StopTaskCancellationReason): string {
  if (typeof cancellation.source === 'string' && cancellation.source.length > 0) {
    return cancellation.source;
  }

  if (cancellation.code === 'pull_request_merged') {
    return 'pull_request_merged';
  }

  return 'task_stop';
}

async function isDuplicateConversationMessage(
  redisClient: RedisConversationClient,
  conversationKey: string,
  message: Record<string, unknown>,
): Promise<boolean> {
  if (typeof redisClient.lRange !== 'function') {
    return false;
  }

  const recentMessages = await redisClient.lRange(conversationKey, -RECENT_DUPLICATE_MESSAGE_LIMIT, -1);
  const messageFingerprint = buildConversationMessageFingerprint(message);
  const messageTimestamp = getConversationMessageTimestamp(message);

  for (const serializedMessage of recentMessages) {
    try {
      const parsedMessage = JSON.parse(serializedMessage) as Record<string, unknown>;
      if (buildConversationMessageFingerprint(parsedMessage) !== messageFingerprint) {
        continue;
      }

      const recentTimestamp = getConversationMessageTimestamp(parsedMessage);
      const elapsedMs = messageTimestamp !== null && recentTimestamp !== null
        ? Math.abs(messageTimestamp - recentTimestamp)
        : null;
      if (elapsedMs === null || elapsedMs <= RECENT_DUPLICATE_MESSAGE_WINDOW_MS) {
        return true;
      }
    } catch (error) {
      logger.warn({
        conversationKey,
        error: (error as Error).message,
      }, 'Ignoring malformed conversation message during duplicate stop-message detection');
    }
  }

  return false;
}

function buildConversationMessageFingerprint(message: Record<string, unknown>): string {
  const messageWithoutTimestamp = { ...message };
  delete messageWithoutTimestamp.timestamp;
  return JSON.stringify(sortRecord(messageWithoutTimestamp));
}

function sortRecord(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortRecord);
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nestedValue]) => [key, sortRecord(nestedValue)]),
  );
}

function getConversationMessageTimestamp(message: Record<string, unknown>): number | null {
  if (typeof message.timestamp !== 'string') {
    return null;
  }

  const parsedTimestamp = Date.parse(message.timestamp);
  return Number.isNaN(parsedTimestamp) ? null : parsedTimestamp;
}
