import { Redis } from 'ioredis';
import logger from './logger.js';
import {
  REDIS_CHANNELS,
  ACTIVITY_UPDATE, GOAL_UPDATE, NOTIFICATION_UPDATE, USAGE_UPDATE, isTerminalActivityChange,
  TASK_UPDATE,
  DRAFT_UPDATE,
  INDEXING_UPDATE,
  TASK_LIVE_UPDATE,
  QUEUE_STATS_UPDATE,
  type NotificationChange,
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
  type GoalUpdateTriggerPayload,
  type NotificationUpdatePayload,
  type UsageUpdatePayload,
  type EventPayload
} from '@propr/shared';
// The activity envelope's own payload shapes. The barrel exports the shell
// surfaces' variants under these names, so the envelope ones are imported
// directly rather than aliased through it.
import type {
  ActivityUpdatePayload as ScopedActivityUpdatePayload,
  NotificationUpdatePayload as RecipientListNotificationUpdate,
} from '@propr/shared/dist/activityEvents.js';

/**
 * The two notification producer shapes: a change fanned out to every recipient
 * of one event, or a change for a single recipient carrying its unread count.
 */
type NotificationUpdateInput =
  | (Omit<RecipientListNotificationUpdate, 'eventType' | 'occurredAt'> & { occurredAt?: string })
  | {
      change: NotificationChange;
      recipientId: string;
      eventId?: string;
      unreadCount?: number;
      occurredAt?: string;
    };

/**
 * Event publisher for real-time updates via Redis pub/sub.
 * Publishes events that will be consumed by the SocketService in the dashboard.
 */
/**
 * How long to leave best-effort publishing offline after a failed connection.
 *
 * Without it, every publish during an outage builds a fresh client that keeps
 * retrying in the background: one unreachable Redis turns a burst of events
 * into a connection storm, and the abandoned clients keep the process alive.
 */
const CONNECT_RETRY_COOLDOWN_MS = 5_000;

/**
 * How long one publish may take before it is abandoned.
 *
 * The new freshness triggers are best effort, but their callers are not:
 * a notification mutation or goal transition awaits its event after the write has
 * committed. A Redis that stops answering - rather than refusing the
 * connection - must therefore cost the caller this long at most, never the
 * length of the outage. Existing lifecycle streams use a separate connection
 * without this deadline.
 */
const PUBLISH_TIMEOUT_MS = 1_000;

/**
 * How long to stop publishing after a publish that a live connection failed.
 *
 * A per-publish deadline bounds one event; it does not bound an operation that
 * publishes several. A cleanup that closes a hundred notifications produces a
 * hundred announcements, and a Redis that has connected and then stopped
 * answering commands would charge each of them its own timeout - a hundred
 * seconds of waiting after the database write already committed. One timeout is
 * enough evidence that the connection is not answering: the rest of the batch
 * is dropped immediately, and publishing resumes on its own once the cooldown
 * expires. This is the command-level twin of `CONNECT_RETRY_COOLDOWN_MS`, which
 * only covers a connection that never came up.
 */
const PUBLISH_FAILURE_COOLDOWN_MS = 5_000;

/** Each delivery policy owns its connection, retries, and failure cooldown. */
class EventPublisherConnection {
  constructor(private readonly bestEffort: boolean) {}

  private redis: InstanceType<typeof Redis> | null = null;
  private isInitialized = false;
  private connectRetryAfter = 0;
  private connecting: Promise<void> | null = null;
  /** Skip publishing until this time: a live connection just failed a publish. */
  private publishRetryAfter = 0;
  /** Bumped by `close()`, so a connection still in flight is not adopted after it. */
  private generation = 0;
  /** Publishes awaiting an answer. The socket is only ref'd while this is > 0. */
  private inFlight = 0;

  /**
   * Hold the event loop open for this connection only while a publish needs it.
   *
   * The publisher connects lazily on the first event and then keeps the socket
   * for reuse, which is a live libuv handle. In a server that is invisible -
   * the HTTP listener or the queue worker already holds the process open - but
   * it makes an idle publisher able to decide when anything else exits. A
   * process that merely touched a publishing code path then hangs until
   * something calls `closeEventPublisher()`, which is the wrong ownership:
   * publishing is best effort, so nothing should have to know it happened in
   * order to shut down.
   *
   * So the socket is unref'd whenever no publish is outstanding, and ref'd
   * again for the duration of one. An in-flight event still keeps the process
   * alive long enough to reach Redis, while an idle connection lets the process
   * exit and take the socket with it. `close()` remains the way to release it
   * within a living process.
   */
  private applySocketRef(client: InstanceType<typeof Redis>): void {
    // ioredis replaces `stream` on every reconnect, so this is re-applied from
    // the `connect` event rather than once at construction.
    const stream = (client as { stream?: { ref?: () => void; unref?: () => void } }).stream;
    if (!stream) return;
    if (this.inFlight > 0) stream.ref?.();
    else stream.unref?.();
  }

  /**
   * Initialize the Redis connection for publishing events.
   * This is called lazily on first publish to avoid connection overhead if not needed.
   */
  private async ensureInitialized(): Promise<void> {
    if (this.isInitialized) return;
    if (Date.now() < this.connectRetryAfter) return;
    // One attempt at a time. A publish that gives up on its deadline leaves the
    // attempt running, and concurrent publishes arrive together on startup:
    // both must join the connection in flight instead of building another
    // client that retries behind our back.
    this.connecting ??= this.connect().finally(() => {
      this.connecting = null;
    });
    await this.connecting;
  }

  private async connect(): Promise<void> {
    const generation = this.generation;
    const client = new Redis({
      host: process.env.REDIS_HOST ?? '127.0.0.1',
      port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
      // Existing lifecycle streams keep their offline queue and retries.
      // Only the new freshness triggers may be dropped during an outage.
      maxRetriesPerRequest: this.bestEffort ? 0 : null,
      ...(this.bestEffort ? { commandTimeout: PUBLISH_TIMEOUT_MS } : {}),
      enableOfflineQueue: !this.bestEffort,
      enableReadyCheck: false,
      lazyConnect: true
    });

    client.on('error', (error: Error) => {
      logger.warn({ error: error.message }, 'Redis error in EventPublisher');
    });
    // Registered before connecting so the very first socket is unref'd as soon
    // as it exists, and every reconnect's replacement after that.
    client.on('connect', () => {
      this.applySocketRef(client);
    });

    try {
      await client.connect();
      if (generation !== this.generation) {
        // Shutdown ran while this attempt was in flight. Adopting the client
        // now would leave a live connection nothing ever closes.
        client.disconnect();
        return;
      }
      this.redis = client;
      this.isInitialized = true;
      logger.debug('EventPublisher Redis connection established');
    } catch (error) {
      // Drop the client for real. Nulling the reference alone would leave it
      // reconnecting forever behind our back.
      client.disconnect();
      this.redis = null;
      if (this.bestEffort && generation === this.generation) {
        this.connectRetryAfter = Date.now() + CONNECT_RETRY_COOLDOWN_MS;
      }
      logger.warn({ error: (error as Error).message }, 'Failed to connect EventPublisher to Redis');
    }
  }

  /**
   * Publish an event to a Redis channel.
   * Silently fails if Redis is not available to avoid breaking main application flow.
   *
   * New freshness triggers have a deadline; existing streams await Redis's
   * acknowledgement, including through a transient reconnect.
   */
  async publish(channel: string, payload: EventPayload): Promise<boolean> {
    if (!this.bestEffort) return this.attemptPublish(channel, payload);
    // A publish that already timed out speaks for the ones behind it: the rest
    // of a batch is dropped for free instead of waiting out its own deadline.
    if (Date.now() < this.publishRetryAfter) {
      logger.debug({ channel }, 'Dropped event: EventPublisher is waiting out a failed publish');
      return false;
    }
    // `attempt` never rejects, so abandoning it at the deadline cannot leave an
    // unhandled rejection behind.
    const attempt = this.attemptPublish(channel, payload);
    let expire: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<boolean>(resolve => {
      expire = setTimeout(() => {
        logger.warn({ channel, timeoutMs: PUBLISH_TIMEOUT_MS }, 'Dropped slow event publish');
        this.suspendPublishing(`no answer within ${PUBLISH_TIMEOUT_MS}ms`);
        resolve(false);
      }, PUBLISH_TIMEOUT_MS);
      expire.unref?.();
    });
    try {
      return await Promise.race([attempt, deadline]);
    } finally {
      clearTimeout(expire);
    }
  }

  /** One publish attempt. Resolves false instead of rejecting. */
  private async attemptPublish(channel: string, payload: EventPayload): Promise<boolean> {
    try {
      await this.ensureInitialized();
      const client = this.redis;
      if (!client) return false;
      // The best-effort client may be reconnecting in the background. Its
      // offline queue is disabled, so the publish would be rejected anyway;
      // dropping it here keeps an outage from costing the caller a round of
      // command timeouts per event.
      if (this.bestEffort && client.status !== 'ready') {
        logger.debug(
          { channel, status: client.status },
          'Dropped event: EventPublisher Redis is not connected'
        );
        return false;
      }

      const message = JSON.stringify(payload);
      // Hold the event loop for this one event, so a process whose only
      // remaining work is an outstanding publish still delivers it.
      this.inFlight += 1;
      this.applySocketRef(client);
      try {
        await client.publish(channel, message);
      } catch (error) {
        // A failed freshness trigger pauses only the best-effort connection;
        // lifecycle events retain their existing retry behavior.
        if (this.bestEffort) this.suspendPublishing((error as Error).message);
        throw error;
      } finally {
        this.inFlight -= 1;
        this.applySocketRef(client);
      }
      logger.debug({ channel, eventType: payload.eventType }, 'Published event');
      return true;
    } catch (error) {
      logger.warn({ error: (error as Error).message, channel }, 'Failed to publish event');
      return false;
    }
  }

  /**
   * Stop publishing for a cooldown after a live connection failed a publish.
   *
   * Keeps the client: the connection itself may well be fine again by the time
   * the cooldown expires, and one successful publish afterwards costs a single
   * command. An already running cooldown is left as it is, so a burst of
   * failures cannot extend the silence indefinitely.
   */
  private suspendPublishing(reason: string): void {
    if (Date.now() < this.publishRetryAfter) return;
    this.publishRetryAfter = Date.now() + PUBLISH_FAILURE_COOLDOWN_MS;
    logger.warn(
      { reason, cooldownMs: PUBLISH_FAILURE_COOLDOWN_MS },
      'Pausing event publishing after a failed publish'
    );
  }

  /**
   * Close the Redis connection.
   * Should be called during application shutdown.
   */
  async close(): Promise<void> {
    this.connectRetryAfter = 0;
    this.publishRetryAfter = 0;
    this.generation += 1;
    const client = this.redis;
    if (client) {
      this.redis = null;
      this.isInitialized = false;
      try {
        await client.quit();
      } catch (error) {
        // With the offline queue disabled a disconnected client rejects `quit`
        // instead of answering it. Dropping the socket is the same teardown,
        // and shutdown must not wait on an unreachable Redis either.
        client.disconnect();
        logger.debug(
          { error: (error as Error).message },
          'EventPublisher Redis connection dropped instead of closed'
        );
      }
      logger.debug('EventPublisher Redis connection closed');
    }
  }
}

class EventPublisher {
  private readonly lifecycle = new EventPublisherConnection(false);
  private readonly bestEffort = new EventPublisherConnection(true);

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
    return this.lifecycle.publish(REDIS_CHANNELS.TASKS, payload);
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
    return this.lifecycle.publish(REDIS_CHANNELS.DRAFTS, payload);
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
    await this.lifecycle.publish(REDIS_CHANNELS.INDEXING, payload);
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
    await this.lifecycle.publish(REDIS_CHANNELS.LIVE_DETAILS, payload);
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
    await this.lifecycle.publish(REDIS_CHANNELS.QUEUE_STATS, payload);
  }

  async publishActivity(params: Omit<ScopedActivityUpdatePayload, 'eventType' | 'occurredAt' | 'terminal'>): Promise<boolean> {
    return this.bestEffort.publish(REDIS_CHANNELS.ACTIVITY, {
      ...params, eventType: ACTIVITY_UPDATE, occurredAt: new Date().toISOString(),
      terminal: isTerminalActivityChange(params.change),
    });
  }

  /**
   * Publish a goal lifecycle transition.
   *
   * Called from the transition itself rather than from a sweep, so the Goals
   * console stops polling to discover a pause or a completion it could have
   * been told about. Writers that only know the goal moved publish its
   * identity: the API completes the frame from the committed row, so a bare
   * trigger is a valid publish here.
   */
  async publishGoalUpdate(
    params: Omit<GoalUpdateTriggerPayload, 'eventType' | 'occurredAt'> & { occurredAt?: string }
  ): Promise<boolean> {
    return this.bestEffort.publish(REDIS_CHANNELS.GOALS, {
      ...params,
      eventType: GOAL_UPDATE,
      occurredAt: params.occurredAt ?? new Date().toISOString()
    });
  }

  /**
   * Publish a notification change.
   *
   * Producers run outside the process that owns the websocket - the projection
   * worker creates the notification, and server-side cleanup dismisses it - so
   * the change reaches the recipient's open tabs through the same Redis relay
   * as every other event rather than through a socket they cannot see.
   *
   * Two producer shapes exist: the notification service fans a change out to
   * the recipients of one event at once, while per-recipient producers publish
   * one frame with the recipient's new unread count. The relay routes either to
   * the recipients' rooms, so both are accepted rather than forcing a producer
   * to restate what it knows.
   */
  async publishNotificationUpdate(
    params: NotificationUpdateInput
  ): Promise<boolean> {
    if ('recipientIds' in params) {
      return this.bestEffort.publish(REDIS_CHANNELS.NOTIFICATIONS, {
        ...params, eventType: NOTIFICATION_UPDATE, occurredAt: params.occurredAt ?? new Date().toISOString(),
      });
    }
    const payload: NotificationUpdatePayload = {
      eventType: NOTIFICATION_UPDATE,
      change: params.change,
      recipientId: params.recipientId,
      ...(params.eventId === undefined ? {} : { eventId: params.eventId }),
      ...(params.unreadCount === undefined ? {} : { unreadCount: params.unreadCount }),
      occurredAt: params.occurredAt ?? new Date().toISOString()
    };
    return this.bestEffort.publish(REDIS_CHANNELS.NOTIFICATIONS, payload);
  }

  /**
   * Publish an agent capacity/quota change.
   *
   * A bare trigger, not a snapshot: each client re-reads the usage endpoint,
   * which keeps owning the projection and its permission check.
   */
  async publishUsageUpdate(params: { provider?: string; source?: 'agent-tank'; occurredAt?: string } = {}): Promise<boolean> {
    const payload: UsageUpdatePayload & { source: 'agent-tank' } = {
      eventType: USAGE_UPDATE,
      source: params.source ?? 'agent-tank',
      ...(params.provider === undefined ? {} : { provider: params.provider }),
      occurredAt: params.occurredAt ?? new Date().toISOString()
    };
    return this.bestEffort.publish(REDIS_CHANNELS.USAGE, payload);
  }

  async close(): Promise<void> {
    await Promise.all([this.lifecycle.close(), this.bestEffort.close()]);
  }
}

/**
 * Relay a notification change to the recipient's open tabs, fire and forget.
 *
 * The producers that need this - the projection worker, and the webhook process
 * closing a merged pull request's cards - run outside the process that owns the
 * websocket, so the change travels the same Redis path as every other event.
 * Losing it costs those tabs freshness until their next reconcile, never the
 * write that caused it.
 */
export function publishNotificationUpdateThroughRedis(payload: {
  change: NotificationChange;
  recipientId: string;
  eventId?: string;
  unreadCount?: number;
  occurredAt?: string;
}): void {
  void getEventPublisher().publishNotificationUpdate(payload).catch(() => undefined);
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
