import { Redis } from 'ioredis';
import logger from './logger.js';
import {
  REDIS_CHANNELS,
  TASK_UPDATE,
  DRAFT_UPDATE,
  INDEXING_UPDATE,
  TASK_LIVE_UPDATE,
  QUEUE_STATS_UPDATE,
  GOAL_UPDATE,
  NOTIFICATION_UPDATE,
  USAGE_UPDATE,
  type TaskUpdatePayload,
  type DraftUpdatePayload,
  type DraftStatus,
  type StepStatus,
  type DraftUpdateGenerationTrace,
  type IndexingUpdatePayload,
  type IndexingPhase,
  type TaskLiveUpdatePayload,
  type QueueStatsUpdatePayload,
  type ConversationEvent,
  type TodoItem,
  type TokenUsageInfo,
  type QueueStatsData,
  type GoalUpdatePayload,
  type NotificationUpdatePayload,
  type UsageUpdatePayload,
  type EventPayload
} from '@propr/shared';

/**
 * Event publisher for real-time updates via Redis pub/sub.
 * Publishes events that will be consumed by the SocketService in the dashboard.
 */
/**
 * How long to leave the publisher offline after a failed connection.
 *
 * Without it, every publish during an outage builds a fresh client that keeps
 * retrying in the background: one unreachable Redis turns a burst of events
 * into a connection storm, and the abandoned clients keep the process alive.
 */
const CONNECT_RETRY_COOLDOWN_MS = 5_000;

class EventPublisher {
  private redis: InstanceType<typeof Redis> | null = null;
  private isInitialized = false;
  private connectRetryAfter = 0;

  /**
   * Initialize the Redis connection for publishing events.
   * This is called lazily on first publish to avoid connection overhead if not needed.
   */
  private async ensureInitialized(): Promise<void> {
    if (this.isInitialized) return;
    if (Date.now() < this.connectRetryAfter) return;

    const client = new Redis({
      host: process.env.REDIS_HOST ?? '127.0.0.1',
      port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      lazyConnect: true
    });

    client.on('error', (error: Error) => {
      logger.warn({ error: error.message }, 'Redis error in EventPublisher');
    });

    try {
      await client.connect();
      this.redis = client;
      this.isInitialized = true;
      logger.debug('EventPublisher Redis connection established');
    } catch (error) {
      // Drop the client for real. Nulling the reference alone would leave it
      // reconnecting forever behind our back.
      client.disconnect();
      this.redis = null;
      this.connectRetryAfter = Date.now() + CONNECT_RETRY_COOLDOWN_MS;
      logger.warn({ error: (error as Error).message }, 'Failed to connect EventPublisher to Redis');
    }
  }

  /**
   * Publish an event to a Redis channel.
   * Silently fails if Redis is not available to avoid breaking main application flow.
   */
  private async publish(channel: string, payload: EventPayload): Promise<boolean> {
    try {
      await this.ensureInitialized();
      if (!this.redis) return false;

      const message = JSON.stringify(payload);
      await this.redis.publish(channel, message);
      logger.debug({ channel, eventType: payload.eventType }, 'Published event');
      return true;
    } catch (error) {
      logger.warn({ error: (error as Error).message, channel }, 'Failed to publish event');
      return false;
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
    version?: number;
    updatedAt?: string;
    timestamp?: string;
    metadata?: Record<string, unknown>;
  }): Promise<boolean> {
    const payload: TaskUpdatePayload = {
      eventType: TASK_UPDATE,
      taskId: params.taskId,
      state: params.state,
      previousState: params.previousState,
      repository: params.repository,
      issueNumber: params.issueNumber,
      timestamp: params.updatedAt ?? params.timestamp ?? new Date().toISOString(),
      version: params.version,
      metadata: params.metadata
    };
    return this.publish(REDIS_CHANNELS.TASKS, payload);
  }

  /**
   * Publish a draft generation progress event.
   * Called when draft generation steps progress (e.g., relevance, context, llm).
   */
  async publishDraftUpdate(params: {
    draftId: string;
    runId?: string;
    step: string;
    status: StepStatus;
    data?: Record<string, unknown>;
    draftStatus?: DraftStatus;
    generationTrace?: DraftUpdateGenerationTrace;
  }): Promise<boolean> {
    const payload: DraftUpdatePayload = {
      eventType: DRAFT_UPDATE,
      draftId: params.draftId,
      runId: params.runId,
      step: params.step,
      status: params.status,
      timestamp: new Date().toISOString(),
      data: params.data,
      draftStatus: params.draftStatus,
      generationTrace: params.generationTrace
    };
    return this.publish(REDIS_CHANNELS.DRAFTS, payload);
  }

  /**
   * Publish an indexing progress event.
   * Called when repository indexing progress changes.
   */
  async publishIndexingUpdate(params: {
    repository: string;
    branch?: string;
    phase: IndexingPhase;
    progress?: number;
    totalFiles?: number;
    processedFiles?: number;
    totalDirectories?: number;
    processedDirectories?: number;
  }): Promise<void> {
    const payload: IndexingUpdatePayload = {
      eventType: INDEXING_UPDATE,
      repository: params.repository,
      branch: params.branch,
      phase: params.phase,
      progress: params.progress,
      totalFiles: params.totalFiles,
      processedFiles: params.processedFiles,
      totalDirectories: params.totalDirectories,
      processedDirectories: params.processedDirectories,
      timestamp: new Date().toISOString()
    };
    await this.publish(REDIS_CHANNELS.INDEXING, payload);
  }

  /**
   * Publish a live task details update event.
   * Called when Claude log file changes are detected during task execution.
   */
  async publishTaskLiveUpdate(params: {
    taskId: string;
    events: ConversationEvent[];
    todos: TodoItem[];
    currentTask: string | null;
    tokenUsage: TokenUsageInfo | null;
  }): Promise<void> {
    const payload: TaskLiveUpdatePayload = {
      eventType: TASK_LIVE_UPDATE,
      taskId: params.taskId,
      events: params.events,
      todos: params.todos,
      currentTask: params.currentTask,
      tokenUsage: params.tokenUsage,
      timestamp: new Date().toISOString()
    };
    await this.publish(REDIS_CHANNELS.LIVE_DETAILS, payload);
  }

  /**
   * Publish a queue statistics update event.
   * Called when queue state changes (jobs added, completed, failed, etc.).
   */
  async publishQueueStatsUpdate(params: {
    stats: QueueStatsData;
  }): Promise<void> {
    const payload: QueueStatsUpdatePayload = {
      eventType: QUEUE_STATS_UPDATE,
      stats: params.stats,
      timestamp: new Date().toISOString()
    };
    await this.publish(REDIS_CHANNELS.QUEUE_STATS, payload);
  }

  /**
   * Publish a goal lifecycle transition.
   * Called from the transition itself rather than from a sweep, so the Goals
   * console stops polling to discover a pause or a completion it could have
   * been told about.
   */
  async publishGoalUpdate(params: Omit<GoalUpdatePayload, 'eventType'>): Promise<void> {
    await this.publish(REDIS_CHANNELS.GOALS, { eventType: GOAL_UPDATE, ...params });
  }

  /**
   * Publish a notification create/read/dismiss change.
   * `recipientIds` is carried so the API can fan out to per-user rooms; it is
   * narrowed to the receiving recipient before the frame reaches a browser.
   */
  async publishNotificationUpdate(
    params: Omit<NotificationUpdatePayload, 'eventType'>
  ): Promise<void> {
    await this.publish(REDIS_CHANNELS.NOTIFICATIONS, {
      eventType: NOTIFICATION_UPDATE,
      ...params
    });
  }

  /**
   * Publish an agent usage change.
   * Deliberately payload-free beyond its source: the client re-reads the
   * existing usage endpoint, which already owns the projection and the
   * permission check.
   */
  async publishUsageUpdate(params: Omit<UsageUpdatePayload, 'eventType'>): Promise<void> {
    await this.publish(REDIS_CHANNELS.USAGE, { eventType: USAGE_UPDATE, ...params });
  }

  /**
   * Close the Redis connection.
   * Should be called during application shutdown.
   */
  async close(): Promise<void> {
    this.connectRetryAfter = 0;
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
