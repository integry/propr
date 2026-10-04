/* eslint-disable max-lines -- the Redis relay, its rooms and the per-event broadcasters are one transport boundary */
import { ShellActivityBroadcaster } from './shellActivityBroadcaster.js';
import { Server as SocketIOServer } from 'socket.io';
import { Server as HttpServer } from 'http';
import { Redis } from 'ioredis';
import { Queue } from 'bullmq';
import { RedisClientType } from 'redis';
import { Knex } from 'knex';
import { goalActivityState, type WorkerStateManagerOptions } from '@propr/core';
import {
  REDIS_CHANNELS,
  GOAL_UPDATE, isActivityTimestamp, isActivityUpdatePayload, isGoalUpdatePayload, isTerminalActivityChange,
  isShellActivityUpdatePayload, isShellNotificationUpdatePayload, isShellUsageUpdatePayload,
  isUsageUpdatePayload,
  type GoalUpdatePayload,
  TASK_UPDATE,
  DRAFT_UPDATE,
  INDEXING_UPDATE,
  TASK_LIVE_UPDATE,
  QUEUE_STATS_UPDATE,
  ACTIVITY_UPDATE,
  NOTIFICATION_UPDATE,
  USAGE_UPDATE,
  type ActivityUpdatePayload,
  type EventPayload,
  type NotificationUpdatePayload,
  type UsageUpdatePayload,
  type TaskUpdatePayload,
  type DraftUpdatePayload,
  type IndexingUpdatePayload,
  type TaskLiveUpdatePayload,
  type QueueStatsUpdatePayload
} from '@propr/shared';
import type {
  ActivityChange, ActivityDomain, ActivityUpdatePayload as ScopedActivityUpdatePayload,
  NotificationUpdatePayload as RecipientListNotificationUpdate, UsageUpdatePayload as ScopedUsageUpdatePayload,
} from '@propr/shared/dist/activityEvents.js';
import {
  activityFromDraftUpdate,
  activityFromIndexingUpdate,
  activityFromQueueStatsUpdate,
  activityFromTaskUpdate,
  isAttentionTaskState,
} from './activityEvents.js';
import { ActivityBroadcaster, ACTIVITY_ROOM as BROADCAST_ACTIVITY_ROOM } from './activityBroadcast.js';
import { QueueBroadcaster } from './queueBroadcaster.js';
import { TaskWatcherManager } from './taskWatcher.js';
import {
  configureSocketAuthentication,
  type SocketAuthenticationOptions,
} from './socketAuthentication.js';
import {
  INSTANCE_OPERATIONAL_ROOM, ACTIVITY_ROOM, activityUserRoom,
  SocketSubscriptionManager,
  taskRoom,
  userRoom,
} from './socketSubscriptions.js';
import {
  admitTaskRevision,
  DEFAULT_TASK_STATE_EXPIRY_SECONDS,
  loadDurableTaskRevision,
  type TaskRevisionCacheEntry,
} from './taskRevisionOrdering.js';
import type { NotificationProjectionSink } from './notificationBackgroundProtocol.js';

/** CORS origin validation function type compatible with Socket.IO */
type CorsOriginCallback = (err: Error | null, allow?: boolean) => void;
type CorsOriginFunction = (origin: string | undefined, callback: CorsOriginCallback) => void;

/** Dependencies for queue stats broadcasting */
export interface QueueDependencies {
  readSystemStatus?: () => Promise<Record<string, unknown>>;
  taskQueue: Queue;
  redisClient: RedisClientType;
  db: Knex;
  workerStateOptions?: Pick<WorkerStateManagerOptions, 'keyPrefix' | 'stateExpiry'>;
  notificationProjection?: NotificationProjectionSink;
}

function shouldRefreshGoalForTask(payload: TaskUpdatePayload): boolean {
  // Tool-call heartbeats do not change goal resources. Terminal frames still
  // reconcile the goal, whose result may have just been committed.
  return payload.state !== payload.previousState
    || ['completed', 'failed', 'cancelled'].includes(payload.state);
}

/**
 * SocketService manages WebSocket connections and Redis pub/sub subscriptions.
 * It subscribes to Redis channels and broadcasts events to connected WebSocket clients.
 *
 * Enhanced features:
 * - Live task details file watching (.jsonl Claude logs)
 * - Queue statistics broadcasting via BullMQ events
 * - Task-specific room subscriptions for targeted updates
 */
export class SocketService {
  private io: SocketIOServer;
  private subscriber: InstanceType<typeof Redis>;
  private isSubscribed = false;
  private shellBroadcaster: ShellActivityBroadcaster | null = null;
  private queueBroadcaster: QueueBroadcaster | null = null;
  private activityBroadcaster: ActivityBroadcaster | null = null;
  private taskWatcherManager: TaskWatcherManager;
  private subscriptionManager: SocketSubscriptionManager;
  private queueDeps: QueueDependencies | null = null;
  private taskRevisions = new Map<string, TaskRevisionCacheEntry>();
  private taskUpdateTails = new Map<string, Promise<void>>();
  private draftUpdateTails = new Map<string, Promise<void>>();
  private notificationProjection: NotificationProjectionSink | null = null;

  constructor(
    httpServer: HttpServer,
    corsOrigins: string | string[] | CorsOriginFunction,
    authentication: SocketAuthenticationOptions,
  ) {
    // Initialize Socket.IO server with CORS configuration
    this.io = new SocketIOServer(httpServer, {
      cors: {
        origin: corsOrigins as string | string[] | ((origin: string | undefined, callback: CorsOriginCallback) => void),
        credentials: true
      },
      transports: ['websocket']
    });
    configureSocketAuthentication(this.io, authentication);

    // Create a dedicated Redis client for subscriptions
    // (pub/sub clients can't be used for other commands)
    this.subscriber = new Redis({
      host: process.env.REDIS_HOST || '127.0.0.1',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
      maxRetriesPerRequest: null,
      enableReadyCheck: false
    });

    this.subscriber.on('error', (error: Error) => {
      console.error('[SocketService] Redis subscriber error:', error.message);
    });

    this.taskWatcherManager = new TaskWatcherManager(this.io);
    this.subscriptionManager = new SocketSubscriptionManager({
      getQueueDependencies: () => this.queueDeps,
      getQueueBroadcaster: () => this.queueBroadcaster,
      taskWatcherManager: this.taskWatcherManager,
    });

    this.setupConnectionHandlers();
    this.setupRedisSubscription();
  }

  /**
   * Initialize queue-related features (BullMQ event listeners, queue stats broadcasting).
   * Must be called after the service is created with the queue dependencies.
   */
  initQueueFeatures(deps: QueueDependencies): void {
    this.queueDeps = deps;
    this.shellBroadcaster = new ShellActivityBroadcaster(this.io, deps.readSystemStatus);
    this.shellBroadcaster.start();
    this.taskWatcherManager.setDeps({ redisClient: deps.redisClient, db: deps.db });
    this.queueBroadcaster = new QueueBroadcaster(this.io, deps.taskQueue);
    this.queueBroadcaster.init();
    this.notificationProjection = deps.notificationProjection ?? null;
    console.log('[SocketService] Queue features initialized');
  }

  /**
   * Derives the general activity surface from the producer events this service
   * already subscribes to, so 'a task changed' and 'activity happened' cannot
   * drift apart, and so no second Redis subscription has to be opened and torn
   * down for it. Resolved on first use because it needs nothing but this
   * service's own Socket.IO server.
   */
  private get activity(): ActivityBroadcaster {
    // Use the target branch's opt-in rooms with the PR's validated derivation.
    this.activityBroadcaster ??= new ActivityBroadcaster({
      to: room => this.io.to(room === BROADCAST_ACTIVITY_ROOM ? ACTIVITY_ROOM
        : room.startsWith('user:') ? activityUserRoom(room.slice('user:'.length)) : room),
    });
    return this.activityBroadcaster;
  }

  /**
   * Set up Socket.IO connection handlers
   */
  private setupConnectionHandlers(): void {
    this.io.on('connection', socket => {
      console.log(`[SocketService] Client connected: ${socket.id}`);
      this.subscriptionManager.setup(socket);
    });
  }

  /**
   * Set up Redis pub/sub subscription to receive events
   */
  private async setupRedisSubscription(): Promise<void> {
    if (this.isSubscribed) return;

    try {
      // Every declared channel, so adding one to the contract is enough.
      await this.subscriber.subscribe(...Object.values(REDIS_CHANNELS));
      this.isSubscribed = true;
      console.log('[SocketService] Subscribed to Redis channels:', Object.values(REDIS_CHANNELS));

      this.subscriber.on('message', (channel: string, message: string) => {
        try {
          const payload = JSON.parse(message) as EventPayload;
          this.handleEvent(channel, payload);
        } catch (error) {
          console.error('[SocketService] Failed to parse Redis message:', error);
        }
      });
    } catch (error) {
      console.error('[SocketService] Failed to subscribe to Redis channels:', error);
    }
  }

  /**
   * Handle incoming events from Redis and broadcast to WebSocket clients
   */
  private handleEvent(_channel: string, payload: EventPayload | RecipientListNotificationUpdate): void {
    switch (payload.eventType) {
      // Two published activity formats reach this relay - the envelope's
      // `entityId` shape and the shell surfaces' `subjectId` shape - and either
      // is re-emitted to browsers, so each is validated whole against its own
      // contract first. The format a frame claims decides which contract it has
      // to satisfy, so supporting the second one does not let an envelope
      // publisher omit a field the envelope requires. Filling the envelope's
      // missing fields downstream is normalization, not validation: a frame with
      // a malformed timestamp, an unknown domain or change, a scope no consumer
      // can filter on, or a `terminal` flag that disagrees with its own change
      // is dropped here rather than forwarded.
      case ACTIVITY_UPDATE:
        if ('entityId' in payload
          ? isActivityUpdatePayload(payload)
          : isShellActivityUpdatePayload(payload)) this.broadcastPushEvent(payload);
        else this.dropMalformedFrame(ACTIVITY_UPDATE);
        break;
      case GOAL_UPDATE:
        void this.handleGoalUpdate(payload).catch(error => console.error('Goal broadcast failed:', error));
        break;
      case NOTIFICATION_UPDATE:
        if ('recipientIds' in payload) this.activity.notificationUpdated(payload);
        else if (isShellNotificationUpdatePayload(payload)) this.broadcastPushEvent(payload);
        else this.dropMalformedFrame(NOTIFICATION_UPDATE);
        break;
      // Same rule for the two usage formats: a trigger naming a `source` is held
      // to the envelope's capacity readings, and the shell trigger's optional
      // `provider` is checked in its place. Either way the timestamp has to be
      // one a consumer can order by.
      case USAGE_UPDATE:
        if ('source' in payload
          ? isUsageUpdatePayload(payload)
          : isShellUsageUpdatePayload(payload)) this.broadcastPushEvent(payload);
        else this.dropMalformedFrame(USAGE_UPDATE);
        break;
      case TASK_UPDATE:
        this.enqueueTaskUpdate(payload as TaskUpdatePayload);
        break;
      case DRAFT_UPDATE:
        this.enqueueDraftUpdate(payload as DraftUpdatePayload);
        break;
      case INDEXING_UPDATE:
        this.handleIndexingUpdate(payload as IndexingUpdatePayload);
        break;
      case TASK_LIVE_UPDATE:
        this.handleTaskLiveUpdate(payload as TaskLiveUpdatePayload);
        break;
      case QUEUE_STATS_UPDATE:
        this.handleQueueStatsUpdate(payload as QueueStatsUpdatePayload);
        break;
      default:
        console.warn(`[SocketService] Dropped unsupported event ${payload.eventType}`);
    }
  }

  /**
   * A publish that does not satisfy any accepted format for its event is
   * reported and dropped: forwarding half a contract is what turns one bad
   * publish into a consumer acting on a change that never happened.
   */
  private dropMalformedFrame(eventType: string): void {
    console.warn(`[SocketService] Dropped malformed ${eventType} frame`);
  }

  private broadcastActivity(frame: {
    domain: ActivityDomain;
    entityId: string;
    repository: string | null;
    change: ActivityChange;
    /** Defaults to the public activity room; private subjects pass their own. */
    room?: string;
    /** Defaults to now; a producer that timestamped the change passes its own. */
    occurredAt?: string;
    details?: Partial<ActivityUpdatePayload>;
  }): void {
    const { domain, entityId, repository, change, room = ACTIVITY_ROOM, details = {} } = frame;
    this.io.to(room).emit(ACTIVITY_UPDATE, { ...details, eventType: ACTIVITY_UPDATE, domain, entityId,
      repository, change, terminal: isTerminalActivityChange(change),
      occurredAt: frame.occurredAt ?? new Date().toISOString() });
  }

  private async handleGoalUpdate(
    payload: Partial<GoalUpdatePayload> & { goalId: string; ownerId?: string },
  ): Promise<void> {
    if (!this.queueDeps || typeof payload.goalId !== 'string' || !payload.goalId
      || !isActivityTimestamp(payload.occurredAt)) return;
    // Rich transition frames must satisfy the PR contract. Bare invalidations
    // from checkpoint/session writers are resolved from the committed goal row.
    if (payload.state !== undefined && !isGoalUpdatePayload(payload)) return;
    const goal = await this.queueDeps.db('goals').where({ goal_id: payload.goalId }).first();
    const ownerId = goal?.owner_id ?? payload.ownerId;
    if (typeof ownerId !== 'string' || !ownerId) return;
    const frame: GoalUpdatePayload = {
      eventType: GOAL_UPDATE,
      goalId: payload.goalId,
      repository: goal?.repository ?? payload.repository,
      state: payload.state ?? (goal ? goalActivityState(goal) : 'cancelled'),
      occurredAt: payload.occurredAt,
      desiredState: goal?.desired_state,
      resultState: goal?.result_state,
      currentTaskId: payload.currentTaskId ?? goal?.current_task_id,
      ...(payload.revision === undefined ? {} : { revision: payload.revision }),
    };
    // Both the goal frame and its derived activity have the same private audience.
    new ActivityBroadcaster({ to: () => this.io.to(activityUserRoom(ownerId)) }).goalUpdated(frame);
  }

  private enqueueTaskUpdate(payload: TaskUpdatePayload): void {
    const previous = this.taskUpdateTails.get(payload.taskId) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(() => this.handleTaskUpdate(payload))
      .finally(() => {
        if (this.taskUpdateTails.get(payload.taskId) === current) {
          this.taskUpdateTails.delete(payload.taskId);
        }
      })
      .catch(error => {
        console.error(`[SocketService] Failed to process task update for ${payload.taskId}:`, error);
      });
    this.taskUpdateTails.set(payload.taskId, current);
  }

  private enqueueDraftUpdate(payload: DraftUpdatePayload): void {
    const previous = this.draftUpdateTails.get(payload.draftId) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(() => this.handleDraftUpdate(payload))
      .finally(() => {
        if (this.draftUpdateTails.get(payload.draftId) === current) {
          this.draftUpdateTails.delete(payload.draftId);
        }
      })
      .catch(error => {
        console.error(`[SocketService] Failed to process draft update for ${payload.draftId}:`, error);
      });
    this.draftUpdateTails.set(payload.draftId, current);
  }

  /** Durable revision baseline for a task, or undefined when no store is wired. */
  private async seedDurableTaskRevision(taskId: string): Promise<number | undefined> {
    const deps = this.queueDeps;
    if (!deps) return undefined;
    return loadDurableTaskRevision(key => deps.redisClient.get(key), taskId, deps.workerStateOptions);
  }

  // One task frame fans out to its room, the activity envelope, private goal
  // tasks and the notification projection.
  private async handleTaskUpdate(payload: TaskUpdatePayload): Promise<void> {
    const admitted = await admitTaskRevision({
      cache: this.taskRevisions,
      taskId: payload.taskId,
      version: payload.version,
      seed: taskId => this.seedDurableTaskRevision(taskId),
      stateExpirySeconds: () => this.queueDeps?.workerStateOptions?.stateExpiry
        ?? DEFAULT_TASK_STATE_EXPIRY_SECONDS,
    });
    if (!admitted) return;
    this.io
      .to(INSTANCE_OPERATIONAL_ROOM)
      .to(taskRoom(payload.taskId))
      .emit(TASK_UPDATE, payload);
    // Derived after the ordering gate above, so a replayed or out-of-order task
    // event cannot produce an activity frame the task feed itself rejected.
    if (payload.taskId.startsWith('goal-')) {
      const goal = shouldRefreshGoalForTask(payload) && this.queueDeps && await this.queueDeps.db('goals')
        .where({ current_task_id: payload.taskId }).first('goal_id');
      if (goal) await this.handleGoalUpdate({
        eventType: GOAL_UPDATE, goalId: goal.goal_id,
        repository: payload.repository ?? undefined, occurredAt: payload.timestamp,
      });
    } else if (payload.state !== payload.previousState || payload.metadata?.issueRefUpdated) {
      // A task waiting on a human is `blocked`, not `progressed`: the dashboard
      // summary, its attention pane and the header's attention count all
      // declare that interest, and nothing else in the envelope tells them a
      // run stopped for a person rather than moving along.
      const change: ActivityChange = payload.state === 'completed' ? 'completed'
        : payload.state === 'failed' ? 'failed'
        : payload.state === 'cancelled' ? 'cancelled'
        : payload.state === 'pending' || payload.state === 'queued' ? 'created'
        : isAttentionTaskState(payload.state) ? 'blocked'
        : payload.previousState === 'pending' || !payload.previousState ? 'started' : 'progressed';
      this.broadcastActivity({ domain: 'task', entityId: payload.taskId,
        repository: payload.repository ?? null, change, details: activityFromTaskUpdate(payload) });
    }
    console.log(`[SocketService] Broadcasted ${TASK_UPDATE} for task ${payload.taskId}`);
    if (this.notificationProjection) {
      await this.notificationProjection.projectTaskUpdate(payload);
    }
  }

  private async handleDraftUpdate(payload: DraftUpdatePayload): Promise<void> {
    const queueDependencies = this.queueDeps;
    if (!queueDependencies) return;

    let ownerId: string;
    try {
      const draft = await queueDependencies.db('task_drafts')
        .select('user_id')
        .where({ draft_id: payload.draftId })
        .first() as { user_id?: string } | undefined;
      if (typeof draft?.user_id !== 'string' || !draft.user_id) return;
      ownerId = draft.user_id;
    } catch (error) {
      console.error(`[SocketService] Failed to resolve owner for draft ${payload.draftId}:`, error);
      return;
    }

    this.io
      .to(`draft:${payload.draftId}`)
      .to(userRoom(ownerId))
      .emit(DRAFT_UPDATE, payload);
    console.log(`[SocketService] Broadcasted ${DRAFT_UPDATE} for draft ${payload.draftId}, step: ${payload.step}`);
    // Every draft update reaches the owner's activity room, not just the ones
    // that moved the draft's status: a consumer that reacts to plan activity at
    // all has no other way to learn a generation run is progressing. The change
    // stays in the envelope's vocabulary so the frame satisfies the wire
    // contract every consumer validates against, while `details` carries the
    // shell surfaces' fields derived from the same payload.
    this.broadcastActivity({
      domain: 'plan',
      entityId: payload.draftId,
      // Draft updates carry no repository; a consumer filtering by repository
      // resolves it from the draft it already reads rather than a guess here.
      repository: null,
      // `review` is the one draft status a person has to act on.
      change: payload.draftStatus === 'review' ? 'blocked'
        : payload.draftStatus === 'failed' ? 'failed'
          : payload.draftStatus === 'merged' ? 'completed'
            : 'progressed',
      room: activityUserRoom(ownerId),
      occurredAt: payload.timestamp,
      details: activityFromDraftUpdate(payload) ?? undefined,
    });
    if (this.notificationProjection) {
      await this.notificationProjection.projectDraftUpdate(payload);
    }
  }

  private handleIndexingUpdate(payload: IndexingUpdatePayload): void {
    this.io.to(`indexing:${payload.repository}`).emit(INDEXING_UPDATE, payload);
    this.io.to('indexing:updates').emit(INDEXING_UPDATE, payload);
    console.log(`[SocketService] Broadcasted ${INDEXING_UPDATE} for repository ${payload.repository}, phase: ${payload.phase}`);
    this.broadcastPushEvent(activityFromIndexingUpdate(payload));
    if (this.notificationProjection) {
      void this.notificationProjection.projectIndexingUpdate(payload).catch(error => {
        console.error(`[SocketService] Failed to project indexing update for ${payload.repository}:`, error);
      });
    }
  }

  private handleTaskLiveUpdate(payload: TaskLiveUpdatePayload): void {
    this.io.to(`task:live:${payload.taskId}`).emit(TASK_LIVE_UPDATE, payload);
    console.log(`[SocketService] Broadcasted ${TASK_LIVE_UPDATE} for task ${payload.taskId}`);
  }

  private handleQueueStatsUpdate(payload: QueueStatsUpdatePayload): void {
    this.io.to('queue:stats').emit(QUEUE_STATS_UPDATE, payload);
    console.log(`[SocketService] Broadcasted ${QUEUE_STATS_UPDATE}`);
    this.broadcastPushEvent(activityFromQueueStatsUpdate(payload));
  }

  /**
   * Broadcast a push event to the room allowed to see it.
   *
   * Activity and usage reach clients subscribed to instance activity;
   * notifications reach only their recipients. Consumers declare an interest
   * rather than subscribing per resource,
   * so this is the one place a new producer has to reach to become visible.
   */
  broadcastPushEvent(
    payload: ActivityUpdatePayload | ScopedActivityUpdatePayload
      | NotificationUpdatePayload | RecipientListNotificationUpdate | UsageUpdatePayload | ScopedUsageUpdatePayload,
  ): void {
    if (payload.eventType === USAGE_UPDATE
      || (payload.eventType === ACTIVITY_UPDATE && ['health', 'system', 'indexing'].includes(payload.domain))) {
      void this.shellBroadcaster?.sample();
    }
    if (payload.eventType === NOTIFICATION_UPDATE) {
      const { recipientIds, recipientId, ...frame } = payload as NotificationUpdatePayload & Partial<RecipientListNotificationUpdate>;
      const recipients = Array.isArray(recipientIds) ? recipientIds : recipientId ? [recipientId] : [];
      for (const id of new Set(recipients)) {
        if (typeof id === 'string' && id) this.io.to(activityUserRoom(id)).emit(NOTIFICATION_UPDATE, frame);
      }
      return;
    }
    this.io.to(ACTIVITY_ROOM).emit(payload.eventType, payload.eventType === ACTIVITY_UPDATE
      ? { ...payload, entityId: 'entityId' in payload ? payload.entityId : payload.subjectId ?? payload.domain,
        repository: payload.repository ?? null }
      : payload);
  }

  /** Whether any client is connected to this instance, i.e. anyone to tell. */
  hasConnectedClients(): boolean {
    return this.io.sockets.sockets.size > 0;
  }

  /** Get the Socket.IO server instance */
  getIO(): SocketIOServer {
    return this.io;
  }

  /** Get the number of connected clients */
  async getConnectedClientsCount(): Promise<number> {
    const sockets = await this.io.fetchSockets();
    return sockets.length;
  }

  /** Broadcast a task live update (can be called externally) */
  async emitTaskLiveUpdate(taskId: string, payload: TaskLiveUpdatePayload): Promise<void> {
    this.io.to(`task:live:${taskId}`).emit(TASK_LIVE_UPDATE, payload);
  }

  /** Broadcast queue stats update (can be called externally) */
  async emitQueueStatsUpdate(payload: QueueStatsUpdatePayload): Promise<void> {
    this.handleQueueStatsUpdate(payload);
  }

  /** Check if there are clients subscribed to a specific task's live updates */
  hasTaskLiveSubscribers(taskId: string): boolean {
    const room = this.io.sockets.adapter.rooms.get(`task:live:${taskId}`);
    return room !== undefined && room.size > 0;
  }

  /** Check if there are clients subscribed to queue stats */
  hasQueueStatsSubscribers(): boolean {
    const room = this.io.sockets.adapter.rooms.get('queue:stats');
    return room !== undefined && room.size > 0;
  }

  /** Clean up resources on shutdown */
  async close(): Promise<void> {
    try {
      this.shellBroadcaster?.close();
      if (this.queueBroadcaster) {
        await this.queueBroadcaster.close();
        this.queueBroadcaster = null;
      }

      await this.taskWatcherManager.closeAll();

      if (this.isSubscribed) {
        await this.subscriber.unsubscribe();
        this.isSubscribed = false;
      }
      await this.subscriber.quit();
      await this.io.close();
      console.log('[SocketService] Closed all connections');
    } catch (error) {
      console.error('[SocketService] Error during cleanup:', error);
    }
  }
}

// Singleton instance
let socketServiceInstance: SocketService | null = null;

/**
 * Initialize the SocketService singleton.
 * Must be called once during server startup.
 */
export function initSocketService(
  httpServer: HttpServer,
  corsOrigins: string | string[] | CorsOriginFunction,
  authentication: SocketAuthenticationOptions,
): SocketService {
  if (socketServiceInstance) {
    console.warn('[SocketService] Service already initialized, returning existing instance');
    return socketServiceInstance;
  }
  socketServiceInstance = new SocketService(httpServer, corsOrigins, authentication);
  return socketServiceInstance;
}

/** Get the SocketService instance. Returns null if not initialized. */
export function getSocketService(): SocketService | null {
  return socketServiceInstance;
}

/** Close the SocketService and clean up resources. */
export async function closeSocketService(): Promise<void> {
  if (socketServiceInstance) {
    await socketServiceInstance.close();
    socketServiceInstance = null;
  }
}
