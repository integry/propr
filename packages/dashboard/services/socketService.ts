import { Server as SocketIOServer, Socket } from 'socket.io';
import { Server as HttpServer } from 'http';
import { Redis } from 'ioredis';
import {
  REDIS_CHANNELS,
  TASK_UPDATE,
  DRAFT_UPDATE,
  INDEXING_UPDATE,
  type EventPayload,
  type TaskUpdatePayload,
  type DraftUpdatePayload,
  type IndexingUpdatePayload
} from '@propr/shared';

/** CORS origin validation function type compatible with Socket.IO */
type CorsOriginCallback = (err: Error | null, allow?: boolean) => void;
type CorsOriginFunction = (origin: string | undefined, callback: CorsOriginCallback) => void;

/**
 * SocketService manages WebSocket connections and Redis pub/sub subscriptions.
 * It subscribes to Redis channels and broadcasts events to connected WebSocket clients.
 */
export class SocketService {
  private io: SocketIOServer;
  private subscriber: InstanceType<typeof Redis>;
  private isSubscribed = false;

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

    this.setupConnectionHandlers();
    this.setupRedisSubscription();
  }

  /**
   * Set up Socket.IO connection handlers
   */
  private setupConnectionHandlers(): void {
    this.io.on('connection', (socket: Socket) => {
      console.log(`[SocketService] Client connected: ${socket.id}`);

      // Allow clients to join specific rooms for targeted updates
      socket.on('subscribe:task', (taskId: string) => {
        socket.join(`task:${taskId}`);
        console.log(`[SocketService] Client ${socket.id} subscribed to task:${taskId}`);
      });

      socket.on('unsubscribe:task', (taskId: string) => {
        socket.leave(`task:${taskId}`);
        console.log(`[SocketService] Client ${socket.id} unsubscribed from task:${taskId}`);
      });

      socket.on('subscribe:draft', (draftId: string) => {
        socket.join(`draft:${draftId}`);
        console.log(`[SocketService] Client ${socket.id} subscribed to draft:${draftId}`);
      });

      socket.on('unsubscribe:draft', (draftId: string) => {
        socket.leave(`draft:${draftId}`);
        console.log(`[SocketService] Client ${socket.id} unsubscribed from draft:${draftId}`);
      });

      socket.on('subscribe:indexing', (repository: string) => {
        socket.join(`indexing:${repository}`);
        console.log(`[SocketService] Client ${socket.id} subscribed to indexing:${repository}`);
      });

      socket.on('unsubscribe:indexing', (repository: string) => {
        socket.leave(`indexing:${repository}`);
        console.log(`[SocketService] Client ${socket.id} unsubscribed from indexing:${repository}`);
      });

      // Allow clients to subscribe to all indexing updates (global room)
      socket.on('subscribe:indexing:updates', () => {
        socket.join('indexing:updates');
        console.log(`[SocketService] Client ${socket.id} subscribed to indexing:updates`);
      });

      socket.on('unsubscribe:indexing:updates', () => {
        socket.leave('indexing:updates');
        console.log(`[SocketService] Client ${socket.id} unsubscribed from indexing:updates`);
      });

      // Handle client disconnect
      socket.on('disconnect', (reason: string) => {
        console.log(`[SocketService] Client disconnected: ${socket.id}, reason: ${reason}`);
      });
    });
  }

  /**
   * Set up Redis pub/sub subscription to receive events
   */
  private async setupRedisSubscription(): Promise<void> {
    if (this.isSubscribed) return;

    try {
      // Subscribe to all event channels
      await this.subscriber.subscribe(
        REDIS_CHANNELS.TASKS,
        REDIS_CHANNELS.DRAFTS,
        REDIS_CHANNELS.INDEXING
      );
      this.isSubscribed = true;
      console.log('[SocketService] Subscribed to Redis channels:', Object.values(REDIS_CHANNELS));

      // Handle incoming messages
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
  private handleEvent(channel: string, payload: EventPayload): void {
    switch (payload.eventType) {
      case TASK_UPDATE: {
        const taskPayload = payload as TaskUpdatePayload;
        // Broadcast to all clients watching this specific task
        this.io.to(`task:${taskPayload.taskId}`).emit(TASK_UPDATE, taskPayload);
        // Also broadcast to the general tasks channel for list views
        this.io.emit(TASK_UPDATE, taskPayload);
        console.log(`[SocketService] Broadcasted ${TASK_UPDATE} for task ${taskPayload.taskId}`);
        break;
      }

      case DRAFT_UPDATE: {
        const draftPayload = payload as DraftUpdatePayload;
        // Broadcast to all clients watching this specific draft
        this.io.to(`draft:${draftPayload.draftId}`).emit(DRAFT_UPDATE, draftPayload);
        // Also broadcast to the general drafts channel
        this.io.emit(DRAFT_UPDATE, draftPayload);
        console.log(`[SocketService] Broadcasted ${DRAFT_UPDATE} for draft ${draftPayload.draftId}, step: ${draftPayload.step}`);
        break;
      }

      case INDEXING_UPDATE: {
        const indexingPayload = payload as IndexingUpdatePayload;
        // Broadcast to clients watching this specific repository's indexing
        this.io.to(`indexing:${indexingPayload.repository}`).emit(INDEXING_UPDATE, indexingPayload);
        // Also broadcast to the general indexing:updates room for global listeners
        this.io.to('indexing:updates').emit(INDEXING_UPDATE, indexingPayload);
        console.log(`[SocketService] Broadcasted ${INDEXING_UPDATE} for repository ${indexingPayload.repository}, phase: ${indexingPayload.phase}`);
        break;
      }

      default:
        // Broadcast unknown events to all clients
        this.io.emit(payload.eventType, payload);
        console.log(`[SocketService] Broadcasted event ${payload.eventType}`);
    }
  }

  /**
   * Get the Socket.IO server instance
   */
  getIO(): SocketIOServer {
    return this.io;
  }

  /**
   * Get the number of connected clients
   */
  async getConnectedClientsCount(): Promise<number> {
    const sockets = await this.io.fetchSockets();
    return sockets.length;
  }

  /**
   * Clean up resources on shutdown
   */
  async close(): Promise<void> {
    try {
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

/**
 * Get the SocketService instance.
 * Returns null if not initialized.
 */
export function getSocketService(): SocketService | null {
  return socketServiceInstance;
}

/**
 * Close the SocketService and clean up resources.
 */
export async function closeSocketService(): Promise<void> {
  if (socketServiceInstance) {
    await socketServiceInstance.close();
    socketServiceInstance = null;
  }
}
