import { Redis } from 'ioredis';
import logger from './logger.js';
import {
  REDIS_CHANNELS,
  TASK_UPDATE,
  DRAFT_UPDATE,
  INDEXING_UPDATE,
  type TaskUpdatePayload,
  type DraftUpdatePayload,
  type IndexingUpdatePayload,
  type EventPayload
} from '@propr/shared';

/**
 * Event publisher for real-time updates via Redis pub/sub.
 * Publishes events that will be consumed by the SocketService in the dashboard.
 */
class EventPublisher {
  private redis: InstanceType<typeof Redis> | null = null;
  private isInitialized = false;

  /**
   * Initialize the Redis connection for publishing events.
   * This is called lazily on first publish to avoid connection overhead if not needed.
   */
  private async ensureInitialized(): Promise<void> {
    if (this.isInitialized) return;

    this.redis = new Redis({
      host: process.env.REDIS_HOST ?? '127.0.0.1',
      port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      lazyConnect: true
    });

    this.redis.on('error', (error: Error) => {
      logger.warn({ error: error.message }, 'Redis error in EventPublisher');
    });

    try {
      await this.redis.connect();
      this.isInitialized = true;
      logger.debug('EventPublisher Redis connection established');
    } catch (error) {
      logger.warn({ error: (error as Error).message }, 'Failed to connect EventPublisher to Redis');
      this.redis = null;
    }
  }

  /**
   * Publish an event to a Redis channel.
   * Silently fails if Redis is not available to avoid breaking main application flow.
   */
  private async publish(channel: string, payload: EventPayload): Promise<void> {
    try {
      await this.ensureInitialized();
      if (!this.redis) return;

      const message = JSON.stringify(payload);
      await this.redis.publish(channel, message);
      logger.debug({ channel, eventType: payload.eventType }, 'Published event');
    } catch (error) {
      // Log but don't throw - event publishing should not break main flow
      logger.warn({ error: (error as Error).message, channel }, 'Failed to publish event');
    }
  }

  /**
   * Publish a task state update event.
   * Called when a task's state changes (e.g., pending -> processing -> completed).
   */
  async publishTaskUpdate(params: {
    taskId: string;
    state: string;
    previousState?: string;
    repository?: string;
    issueNumber?: number;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    const payload: TaskUpdatePayload = {
      eventType: TASK_UPDATE,
      taskId: params.taskId,
      state: params.state,
      previousState: params.previousState,
      repository: params.repository,
      issueNumber: params.issueNumber,
      timestamp: new Date().toISOString(),
      metadata: params.metadata
    };
    await this.publish(REDIS_CHANNELS.TASKS, payload);
  }

  /**
   * Publish a draft generation progress event.
   * Called when draft generation steps progress (e.g., relevance, context, llm).
   */
  async publishDraftUpdate(params: {
    draftId: string;
    step: string;
    status: 'pending' | 'in_progress' | 'completed' | 'failed';
    data?: Record<string, unknown>;
  }): Promise<void> {
    const payload: DraftUpdatePayload = {
      eventType: DRAFT_UPDATE,
      draftId: params.draftId,
      step: params.step,
      status: params.status,
      timestamp: new Date().toISOString(),
      data: params.data
    };
    await this.publish(REDIS_CHANNELS.DRAFTS, payload);
  }

  /**
   * Publish an indexing progress event.
   * Called when repository indexing progress changes.
   */
  async publishIndexingUpdate(params: {
    repository: string;
    phase: string;
    progress?: number;
    totalFiles?: number;
    processedFiles?: number;
  }): Promise<void> {
    const payload: IndexingUpdatePayload = {
      eventType: INDEXING_UPDATE,
      repository: params.repository,
      phase: params.phase,
      progress: params.progress,
      totalFiles: params.totalFiles,
      processedFiles: params.processedFiles,
      timestamp: new Date().toISOString()
    };
    await this.publish(REDIS_CHANNELS.INDEXING, payload);
  }

  /**
   * Close the Redis connection.
   * Should be called during application shutdown.
   */
  async close(): Promise<void> {
    if (this.redis) {
      await this.redis.quit();
      this.redis = null;
      this.isInitialized = false;
      logger.debug('EventPublisher Redis connection closed');
    }
  }
}

// Singleton instance
let eventPublisherInstance: EventPublisher | null = null;

/**
 * Get the singleton EventPublisher instance.
 */
export function getEventPublisher(): EventPublisher {
  if (!eventPublisherInstance) {
    eventPublisherInstance = new EventPublisher();
  }
  return eventPublisherInstance;
}

/**
 * Close the EventPublisher connection.
 * Call during application shutdown.
 */
export async function closeEventPublisher(): Promise<void> {
  if (eventPublisherInstance) {
    await eventPublisherInstance.close();
    eventPublisherInstance = null;
  }
}

// Export the class for type usage
export { EventPublisher };
