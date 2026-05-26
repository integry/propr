import { createHash } from 'crypto';
import { logger } from '@propr/core';
import type { RedisClientType } from 'redis';

type RedisConversationClient = {
  lRange?: RedisClientType['lRange'];
  set?: RedisClientType['set'];
  del?: RedisClientType['del'];
};

const RECENT_DUPLICATE_MESSAGE_LIMIT = 100;
const CONVERSATION_MESSAGE_DEDUPE_KEY_PREFIX = 'conversation:stop-message-dedupe';
const CONVERSATION_MESSAGE_DEDUPE_TTL_SECONDS = 24 * 60 * 60;

export async function hasDuplicateRecentConversationMessage(
  redisClient: RedisConversationClient,
  conversationKey: string,
  message: Record<string, unknown>,
): Promise<boolean> {
  if (typeof redisClient.lRange !== 'function') {
    return false;
  }

  const recentMessages = await redisClient.lRange(conversationKey, -RECENT_DUPLICATE_MESSAGE_LIMIT, -1);
  const dedupeIdentity = getConversationMessageDedupeIdentity(message);
  for (const serializedMessage of recentMessages) {
    try {
      const parsedMessage = JSON.parse(serializedMessage) as Record<string, unknown>;
      if (
        getConversationMessageDedupeIdentity(parsedMessage) === dedupeIdentity
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

export async function reserveConversationMessageFingerprint(
  redisClient: RedisConversationClient,
  conversationKey: string,
  message: Record<string, unknown>,
): Promise<{ reserved: boolean | null; dedupeKey: string | null }> {
  if (typeof redisClient.set !== 'function') {
    return { reserved: null, dedupeKey: null };
  }

  const fingerprint = buildConversationMessageFingerprint(message);
  const dedupeIdentity = getConversationMessageDedupeIdentity(message);
  const dedupeKey = `${CONVERSATION_MESSAGE_DEDUPE_KEY_PREFIX}:${hashDedupeValue(`${conversationKey}:${dedupeIdentity}:${fingerprint}`)}`;
  try {
    const result = await redisClient.set(dedupeKey, '1', {
      NX: true,
      EX: CONVERSATION_MESSAGE_DEDUPE_TTL_SECONDS,
    });
    return { reserved: result !== null, dedupeKey };
  } catch (error) {
    logger.warn({ conversationKey, error: (error as Error).message }, 'Failed to reserve duplicate stop-message fingerprint');
    return { reserved: null, dedupeKey: null };
  }
}

export async function releaseConversationMessageFingerprintReservation(
  redisClient: RedisConversationClient,
  dedupeKey: string | null,
): Promise<void> {
  if (!dedupeKey || typeof redisClient.del !== 'function') {
    return;
  }

  try {
    await redisClient.del(dedupeKey);
  } catch (error) {
    logger.warn({ dedupeKey, error: (error as Error).message }, 'Failed to release duplicate stop-message fingerprint after conversation write failure');
  }
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

function getConversationMessageDedupeIdentity(message: Record<string, unknown>): string {
  const requestId = getConversationMessageRequestId(message);
  return requestId !== null ? `request:${requestId}` : `fingerprint:${buildConversationMessageFingerprint(message)}`;
}
