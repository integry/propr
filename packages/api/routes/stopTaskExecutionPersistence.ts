import { getStateManager, logger, type TaskState } from '@propr/core';
import type { RedisClientType } from 'redis';
import type { StopTaskCancellationReason, StopTaskExecutionDeps } from './stopTaskExecution.js';

type RedisConversationClient = Pick<RedisClientType, 'rPush'> & Partial<Pick<RedisClientType, 'lRange'>>;
const RECENT_DUPLICATE_MESSAGE_LIMIT = 5;
const RECENT_DUPLICATE_MESSAGE_WINDOW_MS = 5 * 60 * 1000;

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
      if (messageTimestamp === null || recentTimestamp === null || messageTimestamp - recentTimestamp <= RECENT_DUPLICATE_MESSAGE_WINDOW_MS) {
        return true;
      }
    } catch {
      return false;
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
