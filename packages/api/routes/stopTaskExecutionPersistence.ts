import { createHash } from 'crypto';
import { getStateManager, logger, TaskStates, type TaskState } from '@propr/core';
import type { RedisClientType } from 'redis';
import type { StopTaskCancellationReason, StopTaskExecutionDeps } from './stopTaskExecution.js';
import type { StopTaskContext } from './stopTaskExecutionContext.js';

type RedisConversationClient = {
  rPush: RedisClientType['rPush'];
  lRange?: RedisClientType['lRange'];
  set?: RedisClientType['set'];
};
type PendingStopRedisClient = Pick<RedisClientType, 'set' | 'rPush'> & Partial<Pick<RedisClientType, 'lRange'>>;
type PendingStopReadClient = Pick<RedisClientType, 'get'> & Partial<Pick<RedisClientType, 'del'>>;
type PendingStopClearClient = Pick<RedisClientType, 'del'>;
const RECENT_DUPLICATE_MESSAGE_LIMIT = 100;
const PENDING_STOP_REQUEST_KEY_PREFIX = 'worker:stop-requested';
const PENDING_STOP_REQUEST_TTL_SECONDS = 24 * 60 * 60;
const CONVERSATION_MESSAGE_DEDUPE_KEY_PREFIX = 'conversation:stop-message-dedupe';
const CONVERSATION_MESSAGE_DEDUPE_TTL_SECONDS = 24 * 60 * 60;
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

async function isDuplicateConversationMessage(
  redisClient: RedisConversationClient,
  conversationKey: string,
  message: Record<string, unknown>,
): Promise<boolean> {
  const fingerprintReserved = await reserveConversationMessageFingerprint(redisClient, conversationKey, message);
  if (fingerprintReserved === false) {
    return true;
  }

  if (typeof redisClient.lRange !== 'function') {
    return false;
  }

  const recentMessages = await redisClient.lRange(conversationKey, -RECENT_DUPLICATE_MESSAGE_LIMIT, -1);
  const cancellationRequestId = getConversationMessageRequestId(message);
  if (cancellationRequestId === null) {
    return false;
  }

  for (const serializedMessage of recentMessages) {
    try {
      const parsedMessage = JSON.parse(serializedMessage) as Record<string, unknown>;
      if (
        getConversationMessageRequestId(parsedMessage) === cancellationRequestId
        && buildConversationMessageFingerprint(parsedMessage) === buildConversationMessageFingerprint(message)
      ) {
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

async function reserveConversationMessageFingerprint(
  redisClient: RedisConversationClient,
  conversationKey: string,
  message: Record<string, unknown>,
): Promise<boolean | null> {
  if (typeof redisClient.set !== 'function') {
    return null;
  }

  const cancellationRequestId = getConversationMessageRequestId(message);
  if (cancellationRequestId === null) {
    return null;
  }

  const fingerprint = buildConversationMessageFingerprint(message);
  const dedupeKey = `${CONVERSATION_MESSAGE_DEDUPE_KEY_PREFIX}:${hashDedupeValue(`${conversationKey}:${cancellationRequestId}:${fingerprint}`)}`;
  try {
    const result = await redisClient.set(dedupeKey, '1', {
      NX: true,
      EX: CONVERSATION_MESSAGE_DEDUPE_TTL_SECONDS,
    });
    return result !== null;
  } catch (error) {
    logger.warn({
      conversationKey,
      error: (error as Error).message,
    }, 'Failed to reserve duplicate stop-message fingerprint');
    return null;
  }
}

function buildStopMessageMetadata(cancellation: StopTaskCancellationReason, requestedBy: string): Record<string, string> {
  return {
    reasonCode: cancellation.code,
    requestedBy,
    ...(cancellation.requestId ? { cancellationRequestId: cancellation.requestId } : {}),
  };
}

function buildConversationMessageFingerprint(message: Record<string, unknown>): string {
  const messageWithoutTimestamp = { ...message };
  delete messageWithoutTimestamp.timestamp;
  return JSON.stringify(sortRecord(messageWithoutTimestamp));
}

function hashDedupeValue(value: string): string {
  return createHash('sha256').update(value).digest('hex');
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

function getConversationMessageRequestId(message: Record<string, unknown>): string | null {
  const metadata = message.metadata;
  if (!metadata || typeof metadata !== 'object') {
    return null;
  }

  const requestId = (metadata as Record<string, unknown>).cancellationRequestId;
  return typeof requestId === 'string' && requestId.length > 0 ? requestId : null;
}
