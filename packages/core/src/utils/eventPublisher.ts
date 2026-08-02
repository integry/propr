import { Redis } from 'ioredis';
import logger from './logger.js';
import {
  REDIS_CHANNELS,
  TASK_UPDATE,
  DRAFT_UPDATE,
  INDEXING_UPDATE,
  TASK_LIVE_UPDATE,
  QUEUE_STATS_UPDATE,
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
  type EventPayload
} from '@propr/shared';
import { projectNotificationUpdateBestEffort } from '../services/notificationProjectionService.js';

const NOTIFICATION_PROJECTION_DEADLINE_MS = 250;
const NOTIFICATION_PROJECTION_MAX_QUEUE_SIZE = 512;
const NOTIFICATION_PROJECTION_CONCURRENCY = 2;

interface NotificationProjectionJob {
  payload: EventPayload;
  resolve: () => void;
}

export interface EventPublisherOptions {
  now?: () => Date;
  publish?: (channel: string, payload: EventPayload) => Promise<boolean>;
  projectNotification?: (payload: EventPayload) => Promise<void>;
  projectionDeadlineMs?: number;
  projectionMaxQueueSize?: number;
  projectionConcurrency?: number;
}

/**
 * Event publisher for real-time updates via Redis pub/sub.
 * Publishes events that will be consumed by the SocketService in the dashboard.
 */
class EventPublisher {
  private redis: InstanceType<typeof Redis> | null = null;
  private isInitialized = false;
  private readonly now: () => Date;
  private readonly publishOverride?: EventPublisherOptions['publish'];
  private readonly notificationProjector: NonNullable<EventPublisherOptions['projectNotification']>;
  private readonly projectionDeadlineMs: number;
  private readonly projectionMaxQueueSize: number;
  private readonly projectionConcurrency: number;
  private readonly projectionQueue: NotificationProjectionJob[] = [];
  private readonly projectionDrainWaiters = new Set<() => void>();
  private activeProjections = 0;
  private projectionClosing = false;

  constructor(options: EventPublisherOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.publishOverride = options.publish;
    this.notificationProjector = options.projectNotification ?? projectNotificationUpdateBestEffort;
    this.projectionDeadlineMs = options.projectionDeadlineMs ?? NOTIFICATION_PROJECTION_DEADLINE_MS;
    this.projectionMaxQueueSize = options.projectionMaxQueueSize ?? NOTIFICATION_PROJECTION_MAX_QUEUE_SIZE;
    this.projectionConcurrency = options.projectionConcurrency ?? NOTIFICATION_PROJECTION_CONCURRENCY;
    if (!Number.isSafeInteger(this.projectionDeadlineMs) || this.projectionDeadlineMs <= 0) {
      throw new TypeError('projectionDeadlineMs must be a positive safe integer');
    }
    if (!Number.isSafeInteger(this.projectionMaxQueueSize) || this.projectionMaxQueueSize <= 0) {
      throw new TypeError('projectionMaxQueueSize must be a positive safe integer');
    }
    if (!Number.isSafeInteger(this.projectionConcurrency) || this.projectionConcurrency <= 0) {
      throw new TypeError('projectionConcurrency must be a positive safe integer');
    }
  }

  /** Bound publication latency while retaining work in a tracked, bounded queue. */
  private async projectNotification(payload: EventPayload): Promise<void> {
    const projection = this.enqueueNotificationProjection(payload);
    if (!projection) {
      logger.warn({
        eventType: payload.eventType,
        queueSize: this.projectionQueue.length,
        active: this.activeProjections
      }, this.projectionClosing
        ? 'Notification projection rejected during publisher shutdown'
        : 'Notification projection queue is full; dropping best-effort projection');
      return;
    }
    let timeout: NodeJS.Timeout | undefined;
    const completed = await Promise.race([
      projection.then(() => true),
      new Promise<false>(resolve => {
        timeout = setTimeout(() => resolve(false), this.projectionDeadlineMs);
      })
    ]);
    if (timeout) clearTimeout(timeout);
    if (!completed) {
      logger.warn({
        eventType: payload.eventType,
        deadlineMs: this.projectionDeadlineMs
      }, 'Notification projection exceeded the publication deadline and continues in background');
    }
  }

  private enqueueNotificationProjection(payload: EventPayload): Promise<void> | null {
    if (
      this.projectionClosing
      || this.projectionQueue.length + this.activeProjections >= this.projectionMaxQueueSize
    ) return null;

    const completion = new Promise<void>((resolve) => {
      this.projectionQueue.push({ payload, resolve });
    });
    this.pumpNotificationProjectionQueue();
    return completion;
  }

  private pumpNotificationProjectionQueue(): void {
    while (
      this.activeProjections < this.projectionConcurrency
      && this.projectionQueue.length > 0
    ) {
      const job = this.projectionQueue.shift()!;
      this.activeProjections++;
      void this.notificationProjector(job.payload)
        .catch((error) => {
          logger.warn({
            eventType: job.payload.eventType,
            error: error instanceof Error ? error.message : String(error)
          }, 'Notification projection failed');
        })
        .finally(() => {
          this.activeProjections--;
          job.resolve();
          this.pumpNotificationProjectionQueue();
          this.resolveProjectionDrainWaiters();
        });
    }
  }

  private resolveProjectionDrainWaiters(): void {
    if (this.activeProjections > 0 || this.projectionQueue.length > 0) return;
    for (const resolve of this.projectionDrainWaiters) resolve();
    this.projectionDrainWaiters.clear();
  }

  private async drainNotificationProjections(): Promise<void> {
    if (this.activeProjections === 0 && this.projectionQueue.length === 0) return;
    await new Promise<void>((resolve) => this.projectionDrainWaiters.add(resolve));
  }

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
  private async publish(channel: string, payload: EventPayload): Promise<boolean> {
    try {
      if (this.publishOverride) return await this.publishOverride(channel, payload);
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
    metadata?: Record<string, unknown>;
    timestamp?: string;
  }): Promise<void> {
    const payload: TaskUpdatePayload = {
      eventType: TASK_UPDATE,
      taskId: params.taskId,
      state: params.state,
      previousState: params.previousState,
      repository: params.repository,
      issueNumber: params.issueNumber,
      timestamp: params.timestamp ?? this.now().toISOString(),
      metadata: params.metadata
    };
    await Promise.all([
      this.publish(REDIS_CHANNELS.TASKS, payload),
      this.projectNotification(payload)
    ]);
  }

  /**
   * Publish a draft generation progress event.
   * Called when draft generation steps progress (e.g., relevance, context, llm).
   */
  async publishDraftUpdate(params: {
    draftId: string;
    step: string;
    status: StepStatus;
    data?: Record<string, unknown>;
    draftStatus?: DraftStatus;
    generationTrace?: DraftUpdateGenerationTrace;
    timestamp?: string;
  }): Promise<boolean> {
    const payload: DraftUpdatePayload = {
      eventType: DRAFT_UPDATE,
      draftId: params.draftId,
      step: params.step,
      status: params.status,
      timestamp: params.timestamp ?? this.now().toISOString(),
      data: params.data,
      draftStatus: params.draftStatus,
      generationTrace: params.generationTrace
    };
    const [published] = await Promise.all([
      this.publish(REDIS_CHANNELS.DRAFTS, payload),
      this.projectNotification(payload)
    ]);
    return published;
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
    transitionAt?: string;
    runId?: string;
    timestamp?: string;
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
      transitionAt: params.transitionAt,
      runId: params.runId,
      timestamp: params.timestamp ?? this.now().toISOString()
    };
    await Promise.all([
      this.publish(REDIS_CHANNELS.INDEXING, payload),
      this.projectNotification(payload)
    ]);
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
      timestamp: this.now().toISOString()
    };
    await Promise.all([
      this.publish(REDIS_CHANNELS.LIVE_DETAILS, payload),
      this.projectNotification(payload)
    ]);
  }

  /** Record task liveness without emitting an artificial dashboard update. */
  async projectTaskHeartbeat(taskId: string, timestamp = this.now().toISOString()): Promise<void> {
    const payload: TaskLiveUpdatePayload = {
      eventType: TASK_LIVE_UPDATE,
      taskId,
      events: [],
      todos: [],
      currentTask: null,
      tokenUsage: null,
      timestamp
    };
    await this.projectNotification(payload);
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
      timestamp: this.now().toISOString()
    };
    await this.publish(REDIS_CHANNELS.QUEUE_STATS, payload);
  }

  /**
   * Close the Redis connection.
   * Should be called during application shutdown.
   */
  async close(): Promise<void> {
    this.projectionClosing = true;
    await this.drainNotificationProjections();
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
