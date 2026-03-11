/**
 * Service for managing repository chat message persistence.
 */

import { db } from '../db/connection.js';
import logger from '../utils/logger.js';

export interface ChatMessageRecord {
  id: number;
  message_id: string;
  repository: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  estimated_duration_ms: number | null;
  actual_duration_ms: number | null;
  is_historical_estimate: boolean | null;
  created_at: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  metadata?: {
    estimatedDurationMs?: number;
    actualDurationMs?: number;
    isHistoricalEstimate?: boolean;
  };
}

export interface SaveMessageParams {
  messageId: string;
  repository: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  estimatedDurationMs?: number;
  actualDurationMs?: number;
  isHistoricalEstimate?: boolean;
}

/**
 * Get all chat messages for a repository, ordered by timestamp.
 */
export async function getMessagesForRepository(repository: string): Promise<ChatMessage[]> {
  try {
    const records = await db<ChatMessageRecord>('repo_chat_messages')
      .where('repository', repository)
      .orderBy('timestamp', 'asc');

    return records.map((record) => ({
      id: record.message_id,
      role: record.role,
      content: record.content,
      timestamp: new Date(record.timestamp).getTime(),
      metadata: record.role === 'assistant' ? {
        estimatedDurationMs: record.estimated_duration_ms ?? undefined,
        actualDurationMs: record.actual_duration_ms ?? undefined,
        isHistoricalEstimate: record.is_historical_estimate ?? undefined,
      } : undefined,
    }));
  } catch (error) {
    logger.error({ error: (error as Error).message, repository }, 'Failed to get chat messages');
    throw error;
  }
}

/**
 * Save a new chat message.
 */
export async function saveMessage(params: SaveMessageParams): Promise<void> {
  try {
    await db<ChatMessageRecord>('repo_chat_messages').insert({
      message_id: params.messageId,
      repository: params.repository,
      role: params.role,
      content: params.content,
      timestamp: new Date(params.timestamp).toISOString(),
      estimated_duration_ms: params.estimatedDurationMs ?? null,
      actual_duration_ms: params.actualDurationMs ?? null,
      is_historical_estimate: params.isHistoricalEstimate ?? null,
    });

    logger.debug({ messageId: params.messageId, repository: params.repository, role: params.role }, 'Chat message saved');
  } catch (error) {
    logger.error({ error: (error as Error).message, repository: params.repository }, 'Failed to save chat message');
    throw error;
  }
}

/**
 * Delete a single chat message by its ID.
 */
export async function deleteMessage(messageId: string): Promise<boolean> {
  try {
    const deleted = await db<ChatMessageRecord>('repo_chat_messages')
      .where('message_id', messageId)
      .del();

    logger.debug({ messageId, deleted }, 'Chat message deleted');
    return deleted > 0;
  } catch (error) {
    logger.error({ error: (error as Error).message, messageId }, 'Failed to delete chat message');
    throw error;
  }
}

/**
 * Clear all chat messages for a repository.
 */
export async function clearMessagesForRepository(repository: string): Promise<number> {
  try {
    const deleted = await db<ChatMessageRecord>('repo_chat_messages')
      .where('repository', repository)
      .del();

    logger.info({ repository, deleted }, 'Chat messages cleared for repository');
    return deleted;
  } catch (error) {
    logger.error({ error: (error as Error).message, repository }, 'Failed to clear chat messages');
    throw error;
  }
}
