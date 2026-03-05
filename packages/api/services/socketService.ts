import { Server as SocketIOServer, Socket } from 'socket.io';
import { Server as HttpServer } from 'http';
import { Redis } from 'ioredis';
import { Queue } from 'bullmq';
import { RedisClientType } from 'redis';
import { Knex } from 'knex';
import {
  REDIS_CHANNELS,
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

/** CORS origin validation function type compatible with Socket.IO */
type CorsOriginCallback = (err: Error | null, allow?: boolean) => void;
type CorsOriginFunction = (origin: string | undefined, callback: CorsOriginCallback) => void;

/** Dependencies for queue stats broadcasting */
export interface QueueDependencies {
  taskQueue: Queue;
  redisClient: RedisClientType;
  db: Knex;
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
  private queueBroadcaster: QueueBroadcaster | null = null;
  private taskWatcherManager: TaskWatcherManager;
  private queueDeps: QueueDependencies | null = null;

  constructor(httpServer: HttpServer, corsOrigins: string | string[] | CorsOriginFunction) {
    // Initialize Socket.IO server with CORS configuration
    this.io = new SocketIOServer(httpServer, {
      cors: {
        origin: corsOrigins as string | string[] | ((origin: string | undefined, callback: CorsOriginCallback) => void),
        credentials: true
      },
      // Use WebSocket transport primarily, with polling fallback
      transports: ['websocket', 'polling']
    });

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

    this.setupConnectionHandlers();
    this.setupRedisSubscription();
  }

  /**
   * Initialize queue-related features (BullMQ event listeners, queue stats broadcasting).
   * Must be called after the service is created with the queue dependencies.
   */
  initQueueFeatures(deps: QueueDependencies): void {
    this.queueDeps = deps;
    this.taskWatcherManager.setDeps({ redisClient: deps.redisClient, db: deps.db });
    this.queueBroadcaster = new QueueBroadcaster(this.io, deps.taskQueue);
    this.queueBroadcaster.init();
    console.log('[SocketService] Queue features initialized');
  }

  /**
   * Set up Socket.IO connection handlers
   */
  private setupConnectionHandlers(): void {
    this.io.on('connection', (socket: Socket) => {
      console.log(`[SocketService] Client connected: ${socket.id}`);
      this.setupTaskHandlers(socket);
      this.setupDraftHandlers(socket);
      this.setupIndexingHandlers(socket);
      this.setupQueueStatsHandlers(socket);
      this.setupDisconnectHandler(socket);
    });
  }

  private setupTaskHandlers(socket: Socket): void {
    socket.on('subscribe:task', (taskId: string) => {
      socket.join(`task:${taskId}`);
      console.log(`[SocketService] Client ${socket.id} subscribed to task:${taskId}`);
    });

    socket.on('unsubscribe:task', (taskId: string) => {
      socket.leave(`task:${taskId}`);
      console.log(`[SocketService] Client ${socket.id} unsubscribed from task:${taskId}`);
    });

    socket.on('subscribe:task:live', async (taskId: string) => {
      socket.join(`task:live:${taskId}`);
      console.log(`[SocketService] Client ${socket.id} subscribed to task:live:${taskId}`);
      await this.taskWatcherManager.startTaskWatcher(taskId);
      await this.taskWatcherManager.sendTaskLiveUpdate(taskId);
    });

    socket.on('unsubscribe:task:live', async (taskId: string) => {
      socket.leave(`task:live:${taskId}`);
      console.log(`[SocketService] Client ${socket.id} unsubscribed from task:live:${taskId}`);
      await this.taskWatcherManager.stopTaskWatcherIfEmpty(taskId);
    });
  }

  private setupDraftHandlers(socket: Socket): void {
    socket.on('subscribe:draft', (draftId: string) => {
      socket.join(`draft:${draftId}`);
      console.log(`[SocketService] Client ${socket.id} subscribed to draft:${draftId}`);
    });

    socket.on('unsubscribe:draft', (draftId: string) => {
      socket.leave(`draft:${draftId}`);
      console.log(`[SocketService] Client ${socket.id} unsubscribed from draft:${draftId}`);
    });
  }

  private setupIndexingHandlers(socket: Socket): void {
    socket.on('subscribe:indexing', (repository: string) => {
      socket.join(`indexing:${repository}`);
      console.log(`[SocketService] Client ${socket.id} subscribed to indexing:${repository}`);
    });

    socket.on('unsubscribe:indexing', (repository: string) => {
      socket.leave(`indexing:${repository}`);
      console.log(`[SocketService] Client ${socket.id} unsubscribed from indexing:${repository}`);
    });

    socket.on('subscribe:indexing:updates', () => {
      socket.join('indexing:updates');
      console.log(`[SocketService] Client ${socket.id} subscribed to indexing:updates`);
    });

    socket.on('unsubscribe:indexing:updates', () => {
      socket.leave('indexing:updates');
      console.log(`[SocketService] Client ${socket.id} unsubscribed from indexing:updates`);
    });
  }

  private setupQueueStatsHandlers(socket: Socket): void {
    socket.on('subscribe:queue:stats', async () => {
      socket.join('queue:stats');
      console.log(`[SocketService] Client ${socket.id} subscribed to queue:stats`);
      if (this.queueBroadcaster) {
        await this.queueBroadcaster.broadcastQueueStats();
      }
    });

    socket.on('unsubscribe:queue:stats', () => {
      socket.leave('queue:stats');
      console.log(`[SocketService] Client ${socket.id} unsubscribed from queue:stats`);
    });
  }

  private setupDisconnectHandler(socket: Socket): void {
    socket.on('disconnect', (reason: string) => {
      console.log(`[SocketService] Client disconnected: ${socket.id}, reason: ${reason}`);
    });
  }

  /**
   * Set up Redis pub/sub subscription to receive events
   */
  private async setupRedisSubscription(): Promise<void> {
    if (this.isSubscribed) return;

    try {
      await this.subscriber.subscribe(
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
      case TASK_UPDATE:
        this.handleTaskUpdate(payload as TaskUpdatePayload);
        break;
      case DRAFT_UPDATE:
        this.handleDraftUpdate(payload as DraftUpdatePayload);
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
        this.io.emit(payload.eventType, payload);
        console.log(`[SocketService] Broadcasted event ${payload.eventType}`);
    }
  }

  private handleTaskUpdate(payload: TaskUpdatePayload): void {
    this.io.to(`task:${payload.taskId}`).emit(TASK_UPDATE, payload);
    this.io.emit(TASK_UPDATE, payload);
    console.log(`[SocketService] Broadcasted ${TASK_UPDATE} for task ${payload.taskId}`);
  }

  private handleDraftUpdate(payload: DraftUpdatePayload): void {
    this.io.to(`draft:${payload.draftId}`).emit(DRAFT_UPDATE, payload);
    this.io.emit(DRAFT_UPDATE, payload);
    console.log(`[SocketService] Broadcasted ${DRAFT_UPDATE} for draft ${payload.draftId}, step: ${payload.step}`);
  }

  private handleIndexingUpdate(payload: IndexingUpdatePayload): void {
    this.io.to(`indexing:${payload.repository}`).emit(INDEXING_UPDATE, payload);
    this.io.to('indexing:updates').emit(INDEXING_UPDATE, payload);
    console.log(`[SocketService] Broadcasted ${INDEXING_UPDATE} for repository ${payload.repository}, phase: ${payload.phase}`);
  }

  private handleTaskLiveUpdate(payload: TaskLiveUpdatePayload): void {
    this.io.to(`task:live:${payload.taskId}`).emit(TASK_LIVE_UPDATE, payload);
    console.log(`[SocketService] Broadcasted ${TASK_LIVE_UPDATE} for task ${payload.taskId}`);
  }

  private handleQueueStatsUpdate(payload: QueueStatsUpdatePayload): void {
    this.io.to('queue:stats').emit(QUEUE_STATS_UPDATE, payload);
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
  corsOrigins: string | string[] | CorsOriginFunction
): SocketService {
  if (socketServiceInstance) {
    console.warn('[SocketService] Service already initialized, returning existing instance');
    return socketServiceInstance;
  }
  socketServiceInstance = new SocketService(httpServer, corsOrigins);
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
