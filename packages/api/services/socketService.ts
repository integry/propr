import { ShellActivityBroadcaster } from './shellActivityBroadcaster.js';
import { Server as SocketIOServer } from 'socket.io';
import { Server as HttpServer } from 'http';
import { Redis } from 'ioredis';
import { Queue } from 'bullmq';
import { RedisClientType } from 'redis';
import { Knex } from 'knex';
import type { WorkerStateManagerOptions } from '@propr/core';
import {
  REDIS_CHANNELS,
  ACTIVITY_UPDATE, GOAL_UPDATE, NOTIFICATION_UPDATE, USAGE_UPDATE, isActivityUpdatePayload, isTerminalActivityChange,
  type ActivityChange, type ActivityDomain, type GoalUpdatePayload, type NotificationUpdatePayload,
  TASK_UPDATE,
  DRAFT_UPDATE,
  INDEXING_UPDATE,
  TASK_LIVE_UPDATE,
  QUEUE_STATS_UPDATE,
  type EventPayload,
  type TaskUpdatePayload,
  type DraftUpdatePayload,
  type IndexingUpdatePayload,
  type TaskLiveUpdatePayload,
  type QueueStatsUpdatePayload
} from '@propr/shared';
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

const DEFAULT_TASK_STATE_EXPIRY_SECONDS = 7 * 24 * 3600;

export interface TaskRevisionCacheEntry {
  version: number;
  expiresAt: number;
}

export function readCachedTaskRevision(
  entry: TaskRevisionCacheEntry | undefined,
  now = Date.now(),
): number | undefined {
  return entry && entry.expiresAt > now ? entry.version : undefined;
}

export function shouldBroadcastTaskUpdate(
  latestVersion: number | undefined,
  incomingVersion: number | undefined,
  allowSeededEquality = false,
): boolean {
  if (incomingVersion !== undefined
    && (!Number.isSafeInteger(incomingVersion) || incomingVersion < 0)) return false;
  if (latestVersion === undefined) return true;
  if (incomingVersion === undefined) return false;
  return incomingVersion > latestVersion
    || (allowSeededEquality && incomingVersion === latestVersion);
}

export async function loadDurableTaskRevision(
  get: (key: string) => Promise<string | null>,
  taskId: string,
  options: Pick<WorkerStateManagerOptions, 'keyPrefix'> = {},
): Promise<number | undefined> {
  const stateValue = await get(`${options.keyPrefix ?? 'worker:state:'}${taskId}`);
  const isValidRevision = (value: number): boolean => (
    Number.isSafeInteger(value) && value >= 0
  );
  let stateRevision = Number.NaN;
  if (stateValue) {
    try {
      const parsed = JSON.parse(stateValue) as { version?: unknown };
      stateRevision = typeof parsed.version === 'number' && isValidRevision(parsed.version)
        ? parsed.version
        : Number.NaN;
    } catch {
      // A malformed/partially-written state cannot seed event ordering.
    }
  }
  return isValidRevision(stateRevision) ? stateRevision : undefined;
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
      await this.subscriber.subscribe(
        REDIS_CHANNELS.ACTIVITY,
        REDIS_CHANNELS.TASKS,
        REDIS_CHANNELS.DRAFTS,
        REDIS_CHANNELS.INDEXING,
        REDIS_CHANNELS.LIVE_DETAILS,
        REDIS_CHANNELS.QUEUE_STATS
      );
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
  private handleEvent(_channel: string, payload: EventPayload): void {
    switch (payload.eventType) {
      case ACTIVITY_UPDATE:
        if (isActivityUpdatePayload(payload)) this.io.to(ACTIVITY_ROOM).emit(ACTIVITY_UPDATE, payload);
        break;
      case GOAL_UPDATE:
        void this.handleGoalUpdate(payload).catch(error => console.error('Goal broadcast failed:', error));
        break;
      case NOTIFICATION_UPDATE: {
        const { recipientIds, ...frame } = payload as NotificationUpdatePayload;
        if (!Array.isArray(recipientIds)) break;
        for (const id of new Set(recipientIds)) {
          if (typeof id === 'string') this.io.to(activityUserRoom(id)).emit(NOTIFICATION_UPDATE, frame);
        }
        break;
      }
      case USAGE_UPDATE:
        this.io.to(ACTIVITY_ROOM).emit(USAGE_UPDATE, payload);
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

  private broadcastActivity(domain: ActivityDomain, entityId: string, repository: string | null,
    change: ActivityChange, room = ACTIVITY_ROOM): void {
    this.io.to(room).emit(ACTIVITY_UPDATE, { eventType: ACTIVITY_UPDATE, domain, entityId,
      repository, change, terminal: isTerminalActivityChange(change), occurredAt: new Date().toISOString() });
  }

  private async handleGoalUpdate(payload: GoalUpdatePayload & { ownerId?: string }): Promise<void> {
    if (!this.queueDeps || typeof payload.goalId !== 'string') return;
    const goal = await this.queueDeps.db('goals').where({ goal_id: payload.goalId }).first();
    const ownerId = goal?.owner_id ?? payload.ownerId;
    if (typeof ownerId !== 'string') return;
    const room = activityUserRoom(ownerId);
    const frame: GoalUpdatePayload = { eventType: GOAL_UPDATE, goalId: payload.goalId,
      repository: goal?.repository ?? payload.repository, occurredAt: payload.occurredAt,
      desiredState: goal?.desired_state, resultState: goal?.result_state,
      currentTaskId: goal?.current_task_id };
    this.io.to(room).emit(GOAL_UPDATE, frame);
    const change = goal?.result_state === 'completed' ? 'completed'
      : goal?.result_state === 'failed' ? 'failed'
      : goal?.result_state === 'cancelled' || !goal ? 'cancelled'
      : goal?.desired_state === 'paused' ? 'blocked' : 'progressed';
    this.broadcastActivity('goal', payload.goalId, frame.repository, change, room);
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

  private async handleTaskUpdate(payload: TaskUpdatePayload): Promise<void> {
    const now = Date.now();
    const cachedRevision = this.taskRevisions.get(payload.taskId);
    let latestVersion = readCachedTaskRevision(cachedRevision, now);
    if (cachedRevision && latestVersion === undefined) this.taskRevisions.delete(payload.taskId);
    let allowSeededEquality = false;
    if (latestVersion === undefined && payload.version !== undefined && this.queueDeps) {
      try {
        latestVersion = await loadDurableTaskRevision(
          key => this.queueDeps!.redisClient.get(key),
          payload.taskId,
          this.queueDeps.workerStateOptions,
        );
        allowSeededEquality = latestVersion !== undefined;
      } catch (error) {
        console.error(`[SocketService] Failed to seed task revision for ${payload.taskId}:`, error);
        // A versioned pub/sub event is already self-ordering. Accept it as the
        // live baseline when durable state is transiently unavailable rather
        // than silently dropping the only update clients may receive.
        if (payload.version === undefined) return;
        latestVersion = undefined;
      }
    }
    // During rolling upgrades, legacy events may be accepted until a
    // versioned producer establishes the ordered stream for this task.
    if (!shouldBroadcastTaskUpdate(latestVersion, payload.version, allowSeededEquality)) return;
    if (payload.version !== undefined) {
      const stateExpirySeconds = Math.max(
        1,
        this.queueDeps?.workerStateOptions?.stateExpiry ?? DEFAULT_TASK_STATE_EXPIRY_SECONDS,
      );
      this.taskRevisions.delete(payload.taskId);
      this.taskRevisions.set(payload.taskId, {
        version: payload.version,
        expiresAt: now + stateExpirySeconds * 1000,
      });
      if (this.taskRevisions.size > 10_000) {
        const oldestTaskId = this.taskRevisions.keys().next().value;
        if (oldestTaskId !== undefined) this.taskRevisions.delete(oldestTaskId);
      }
    }
    this.io
      .to(INSTANCE_OPERATIONAL_ROOM)
      .to(taskRoom(payload.taskId))
      .emit(TASK_UPDATE, payload);
    const state = payload.state.toLowerCase();
    const change: ActivityChange = state === 'completed' ? 'completed' : state === 'failed' ? 'failed'
      : state === 'cancelled' ? 'cancelled' : ['action_required', 'blocked', 'paused'].includes(state) ? 'blocked'
      : state === 'pending' ? 'created' : 'started';
    // Goal tasks are private; resolve their owner instead of emitting a public invalidation.
    if (payload.taskId.startsWith('goal-')) {
      const goal = this.queueDeps && await this.queueDeps.db('goals').where({ current_task_id: payload.taskId }).first('goal_id');
      if (goal) await this.handleGoalUpdate({ eventType: GOAL_UPDATE, goalId: goal.goal_id,
        repository: payload.repository ?? null, occurredAt: payload.timestamp });
    } else if (payload.state !== payload.previousState || payload.metadata?.issueRefUpdated) {
      this.broadcastActivity('task', payload.taskId, payload.repository ?? null, change);
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
    this.broadcastActivity('plan', payload.draftId, null,
      payload.draftStatus === 'failed' ? 'failed' : payload.draftStatus === 'merged' ? 'completed'
        : payload.draftStatus === 'review' ? 'blocked' : 'created', activityUserRoom(ownerId));
    console.log(`[SocketService] Broadcasted ${DRAFT_UPDATE} for draft ${payload.draftId}, step: ${payload.step}`);
    if (this.notificationProjection) {
      await this.notificationProjection.projectDraftUpdate(payload);
    }
  }

  private handleIndexingUpdate(payload: IndexingUpdatePayload): void {
    this.io.to(`indexing:${payload.repository}`).emit(INDEXING_UPDATE, payload);
    this.io.to('indexing:updates').emit(INDEXING_UPDATE, payload);
    this.broadcastActivity('indexing', payload.repository, payload.repository, 'progressed');
    console.log(`[SocketService] Broadcasted ${INDEXING_UPDATE} for repository ${payload.repository}, phase: ${payload.phase}`);
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
    this.broadcastActivity('queue', 'queue', null, 'progressed');
    console.log(`[SocketService] Broadcasted ${QUEUE_STATS_UPDATE}`);
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
    this.io.to('queue:stats').emit(QUEUE_STATS_UPDATE, payload);
    this.broadcastActivity('queue', 'queue', null, 'progressed');
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
