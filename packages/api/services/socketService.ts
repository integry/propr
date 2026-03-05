import { Server as SocketIOServer, Socket } from 'socket.io';
import { Server as HttpServer } from 'http';
import { Redis } from 'ioredis';
import { Queue, QueueEvents } from 'bullmq';
import * as chokidar from 'chokidar';
import path from 'path';
import os from 'os';
import fs from 'fs-extra';
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
  type QueueStatsUpdatePayload,
  type ConversationEvent,
  type TodoItem,
  type TokenUsageInfo,
  type QueueStatsData
} from '@propr/shared';

/** CORS origin validation function type compatible with Socket.IO */
type CorsOriginCallback = (err: Error | null, allow?: boolean) => void;
type CorsOriginFunction = (origin: string | undefined, callback: CorsOriginCallback) => void;

/** Dependencies for queue stats broadcasting */
export interface QueueDependencies {
  taskQueue: Queue;
  redisClient: RedisClientType;
  db: Knex;
}

/** Active task watcher info */
interface TaskWatcher {
  watcher: chokidar.FSWatcher;
  sessionId: string;
  taskId: string;
  lastSize: number;
  subscriberCount: number;
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
  private taskWatchers: Map<string, TaskWatcher> = new Map();
  private queueEvents: QueueEvents | null = null;
  private queueStatsInterval: ReturnType<typeof setInterval> | null = null;
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

    this.setupConnectionHandlers();
    this.setupRedisSubscription();
  }

  /**
   * Initialize queue-related features (BullMQ event listeners, queue stats broadcasting).
   * Must be called after the service is created with the queue dependencies.
   */
  initQueueFeatures(deps: QueueDependencies): void {
    this.queueDeps = deps;
    this.setupQueueEventListeners(deps.taskQueue);
    this.startQueueStatsBroadcast(deps.taskQueue);
    console.log('[SocketService] Queue features initialized');
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

      // Subscribe to live task details (Claude log streaming)
      socket.on('subscribe:task:live', async (taskId: string) => {
        socket.join(`task:live:${taskId}`);
        console.log(`[SocketService] Client ${socket.id} subscribed to task:live:${taskId}`);

        // Start watching the task's log file if not already watching
        await this.startTaskWatcher(taskId);

        // Send initial data immediately
        await this.sendTaskLiveUpdate(taskId);
      });

      socket.on('unsubscribe:task:live', async (taskId: string) => {
        socket.leave(`task:live:${taskId}`);
        console.log(`[SocketService] Client ${socket.id} unsubscribed from task:live:${taskId}`);

        // Stop watching if no more subscribers
        await this.stopTaskWatcherIfEmpty(taskId);
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

      // Subscribe to queue statistics updates
      socket.on('subscribe:queue:stats', async () => {
        socket.join('queue:stats');
        console.log(`[SocketService] Client ${socket.id} subscribed to queue:stats`);

        // Send current stats immediately
        if (this.queueDeps) {
          await this.broadcastQueueStats(this.queueDeps.taskQueue);
        }
      });

      socket.on('unsubscribe:queue:stats', () => {
        socket.leave('queue:stats');
        console.log(`[SocketService] Client ${socket.id} unsubscribed from queue:stats`);
      });

      // Handle client disconnect
      socket.on('disconnect', async (reason: string) => {
        console.log(`[SocketService] Client disconnected: ${socket.id}, reason: ${reason}`);

        // Clean up any task watchers that may have been orphaned
        // Note: Socket.IO rooms are automatically cleaned up on disconnect
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
        REDIS_CHANNELS.INDEXING,
        REDIS_CHANNELS.LIVE_DETAILS,
        REDIS_CHANNELS.QUEUE_STATS
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

      case TASK_LIVE_UPDATE: {
        const livePayload = payload as TaskLiveUpdatePayload;
        // Broadcast to clients watching this specific task's live details
        this.io.to(`task:live:${livePayload.taskId}`).emit(TASK_LIVE_UPDATE, livePayload);
        console.log(`[SocketService] Broadcasted ${TASK_LIVE_UPDATE} for task ${livePayload.taskId}`);
        break;
      }

      case QUEUE_STATS_UPDATE: {
        const statsPayload = payload as QueueStatsUpdatePayload;
        // Broadcast to all clients watching queue stats
        this.io.to('queue:stats').emit(QUEUE_STATS_UPDATE, statsPayload);
        console.log(`[SocketService] Broadcasted ${QUEUE_STATS_UPDATE}`);
        break;
      }

      default:
        // Broadcast unknown events to all clients
        this.io.emit(payload.eventType, payload);
        console.log(`[SocketService] Broadcasted event ${payload.eventType}`);
    }
  }

  /**
   * Set up BullMQ event listeners for real-time queue updates
   */
  private setupQueueEventListeners(queue: Queue): void {
    this.queueEvents = new QueueEvents(queue.name, {
      connection: {
        host: process.env.REDIS_HOST || '127.0.0.1',
        port: parseInt(process.env.REDIS_PORT || '6379', 10)
      }
    });

    // Broadcast queue stats on significant events
    this.queueEvents.on('completed', async () => {
      await this.broadcastQueueStats(queue);
    });

    this.queueEvents.on('failed', async () => {
      await this.broadcastQueueStats(queue);
    });

    this.queueEvents.on('active', async () => {
      await this.broadcastQueueStats(queue);
    });

    this.queueEvents.on('waiting', async () => {
      await this.broadcastQueueStats(queue);
    });

    this.queueEvents.on('delayed', async () => {
      await this.broadcastQueueStats(queue);
    });

    console.log('[SocketService] BullMQ event listeners initialized');
  }

  /**
   * Start periodic queue stats broadcasting
   */
  private startQueueStatsBroadcast(queue: Queue): void {
    // Broadcast queue stats every 5 seconds to ensure UI stays updated
    this.queueStatsInterval = setInterval(async () => {
      const room = this.io.sockets.adapter.rooms.get('queue:stats');
      if (room && room.size > 0) {
        await this.broadcastQueueStats(queue);
      }
    }, 5000);

    console.log('[SocketService] Queue stats periodic broadcast started');
  }

  /**
   * Broadcast current queue statistics to subscribed clients
   */
  private async broadcastQueueStats(queue: Queue): Promise<void> {
    try {
      const [waiting, active, completed, failed, delayed] = await Promise.all([
        queue.getWaitingCount(),
        queue.getActiveCount(),
        queue.getCompletedCount(),
        queue.getFailedCount(),
        queue.getDelayedCount()
      ]);

      const stats: QueueStatsData = {
        waiting,
        active,
        completed,
        failed,
        delayed,
        total: waiting + active + completed + failed + delayed
      };

      const payload: QueueStatsUpdatePayload = {
        eventType: QUEUE_STATS_UPDATE,
        stats,
        timestamp: new Date().toISOString()
      };

      this.io.to('queue:stats').emit(QUEUE_STATS_UPDATE, payload);
    } catch (error) {
      console.error('[SocketService] Failed to broadcast queue stats:', error);
    }
  }

  /**
   * Start watching a task's Claude log file for changes
   */
  private async startTaskWatcher(taskId: string): Promise<void> {
    // Check if already watching
    const existing = this.taskWatchers.get(taskId);
    if (existing) {
      existing.subscriberCount++;
      return;
    }

    // Find the session ID for this task
    const sessionId = await this.findSessionIdForTask(taskId);
    if (!sessionId) {
      console.log(`[SocketService] No session found for task ${taskId}, cannot start watcher`);
      return;
    }

    const conversationPath = path.join(
      os.homedir(),
      '.claude',
      'projects',
      '-home-node-workspace',
      `${sessionId}.jsonl`
    );

    // Check if file exists
    const exists = await fs.pathExists(conversationPath);
    if (!exists) {
      console.log(`[SocketService] Claude log file not found for task ${taskId}: ${conversationPath}`);
      return;
    }

    // Create file watcher using chokidar
    const watcher = chokidar.watch(conversationPath, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 100,
        pollInterval: 50
      }
    });

    // Track initial file size
    const stats = await fs.stat(conversationPath);
    const initialSize = stats.size;

    watcher.on('change', async () => {
      // Debounce and send update
      await this.sendTaskLiveUpdate(taskId);
    });

    watcher.on('error', (error) => {
      console.error(`[SocketService] Watcher error for task ${taskId}:`, error);
    });

    this.taskWatchers.set(taskId, {
      watcher,
      sessionId,
      taskId,
      lastSize: initialSize,
      subscriberCount: 1
    });

    console.log(`[SocketService] Started watching Claude log for task ${taskId}`);
  }

  /**
   * Stop watching a task's log file if no more subscribers
   */
  private async stopTaskWatcherIfEmpty(taskId: string): Promise<void> {
    const watcher = this.taskWatchers.get(taskId);
    if (!watcher) return;

    watcher.subscriberCount--;

    // Check if there are still clients in the room
    const room = this.io.sockets.adapter.rooms.get(`task:live:${taskId}`);
    const hasClients = room && room.size > 0;

    if (watcher.subscriberCount <= 0 && !hasClients) {
      await watcher.watcher.close();
      this.taskWatchers.delete(taskId);
      console.log(`[SocketService] Stopped watching Claude log for task ${taskId}`);
    }
  }

  /**
   * Find the session ID for a task from Redis or database
   */
  private async findSessionIdForTask(taskId: string): Promise<string | null> {
    if (!this.queueDeps) {
      console.log('[SocketService] Queue deps not initialized, cannot find session ID');
      return null;
    }

    const { redisClient, db } = this.queueDeps;
    const normalizedTaskId = this.normalizeTaskId(taskId);

    // Check Redis first for live execution state
    try {
      const stateKey = `worker:state:${normalizedTaskId}`;
      const stateData = await redisClient.get(stateKey);

      if (stateData) {
        const state = JSON.parse(stateData) as {
          history: Array<{ state: string; metadata?: { sessionId?: string } }>
        };
        const entry = state.history.find(
          h => h.state === 'claude_execution' && h.metadata?.sessionId
        );
        if (entry?.metadata?.sessionId) {
          return entry.metadata.sessionId;
        }
      }
    } catch (error) {
      console.error('[SocketService] Error fetching from Redis:', error);
    }

    // Fall back to database
    try {
      const llmExecution = await db('llm_executions')
        .where({ task_id: normalizedTaskId })
        .orderBy('start_time', 'desc')
        .first();

      if (llmExecution?.session_id) {
        return llmExecution.session_id as string;
      }
    } catch (error) {
      console.error('[SocketService] Error fetching from database:', error);
    }

    return null;
  }

  /**
   * Normalize task ID (handle issue- prefix)
   */
  private normalizeTaskId(jobId: string): string {
    if (jobId.startsWith('issue-')) {
      const parts = jobId.replace(/^issue-/, '').split('-');
      parts.pop();
      return parts.join('-');
    }
    return jobId;
  }

  /**
   * Parse and send live task update to subscribed clients
   */
  private async sendTaskLiveUpdate(taskId: string): Promise<void> {
    const watcherInfo = this.taskWatchers.get(taskId);
    if (!watcherInfo) return;

    try {
      const conversationPath = path.join(
        os.homedir(),
        '.claude',
        'projects',
        '-home-node-workspace',
        `${watcherInfo.sessionId}.jsonl`
      );

      const exists = await fs.pathExists(conversationPath);
      if (!exists) {
        return;
      }

      const result = await this.parseConversationFile(conversationPath);

      const payload: TaskLiveUpdatePayload = {
        eventType: TASK_LIVE_UPDATE,
        taskId,
        events: result.events,
        todos: result.todos,
        currentTask: result.currentTask,
        tokenUsage: result.tokenUsage,
        timestamp: new Date().toISOString()
      };

      // Emit directly to the room
      this.io.to(`task:live:${taskId}`).emit(TASK_LIVE_UPDATE, payload);
    } catch (error) {
      console.error(`[SocketService] Error sending live update for task ${taskId}:`, error);
    }
  }

  /**
   * Parse Claude conversation file (JSONL format)
   */
  private async parseConversationFile(conversationPath: string): Promise<{
    events: ConversationEvent[];
    todos: TodoItem[];
    currentTask: string | null;
    tokenUsage: TokenUsageInfo | null;
  }> {
    const conversationContent = await fs.readFile(conversationPath, 'utf8');
    const lines = conversationContent.trim().split('\n').filter(line => line.trim());

    const events: ConversationEvent[] = [];
    let todos: TodoItem[] = [];
    const tokenUsage: TokenUsageInfo = {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0
    };
    const pendingSubagents: Map<string, {
      toolUseId: string;
      subagentType: string;
      description: string;
      startTimestamp: string;
    }> = new Map();

    for (const line of lines) {
      try {
        const message = JSON.parse(line) as {
          type?: string;
          timestamp?: string;
          message?: {
            content?: Array<{
              type: string;
              text?: string;
              name?: string;
              input?: { todos?: TodoItem[]; subagent_type?: string; description?: string };
              id?: string;
              tool_use_id?: string;
              content?: unknown;
              is_error?: boolean;
            }>;
            usage?: {
              input_tokens?: number;
              output_tokens?: number;
              cache_creation_input_tokens?: number;
              cache_read_input_tokens?: number;
            };
          };
          usage?: {
            input_tokens?: number;
            output_tokens?: number;
            cache_creation_input_tokens?: number;
            cache_read_input_tokens?: number;
          };
        };
        const timestamp = message.timestamp || new Date().toISOString();

        if (message.type === 'assistant' && message.message?.content) {
          for (const content of message.message.content) {
            if (content.type === 'text') {
              events.push({ type: 'thought', content: content.text, timestamp });
            } else if (content.type === 'tool_use') {
              events.push({
                type: 'tool_use',
                toolName: content.name,
                input: content.input as Record<string, unknown>,
                id: content.id,
                timestamp
              });
              if (content.name === 'TodoWrite' && content.input?.todos) {
                todos = content.input.todos;
              }
              if (content.name === 'Task' && content.id) {
                pendingSubagents.set(content.id, {
                  toolUseId: content.id,
                  subagentType: content.input?.subagent_type || 'unknown',
                  description: content.input?.description || '',
                  startTimestamp: timestamp
                });
              }
            }
          }
        }

        if (message.type === 'user' && message.message?.content) {
          for (const content of message.message.content) {
            if (content.type === 'tool_result') {
              events.push({
                type: 'tool_result',
                toolUseId: content.tool_use_id,
                result: content.content as unknown,
                isError: content.is_error || false,
                timestamp
              });

              if (content.tool_use_id && pendingSubagents.has(content.tool_use_id)) {
                const subagent = pendingSubagents.get(content.tool_use_id)!;
                const durationMs = new Date(timestamp).getTime() - new Date(subagent.startTimestamp).getTime();
                const durationSecs = Math.round(durationMs / 1000);

                const icon = this.getSubagentIcon(subagent.subagentType);
                events.push({
                  type: 'thought',
                  content: `${icon} **${subagent.subagentType}** subagent completed in ${durationSecs}s: ${subagent.description}`,
                  timestamp,
                  isSubagentSummary: true
                });

                pendingSubagents.delete(content.tool_use_id);
              }
            }
          }
        }

        const usage = message.usage || message.message?.usage;
        if (usage) {
          tokenUsage.input_tokens += usage.input_tokens ?? 0;
          tokenUsage.output_tokens += usage.output_tokens ?? 0;
          tokenUsage.cache_creation_input_tokens += usage.cache_creation_input_tokens ?? 0;
          tokenUsage.cache_read_input_tokens += usage.cache_read_input_tokens ?? 0;
        }
      } catch (error) {
        console.error('[SocketService] Error parsing conversation line:', error);
      }
    }

    const inProgressTask = todos.find(t => t.status === 'in_progress');
    const currentTask = inProgressTask ? inProgressTask.content : null;

    const hasTokens = tokenUsage.input_tokens > 0 || tokenUsage.output_tokens > 0 ||
      tokenUsage.cache_creation_input_tokens > 0 || tokenUsage.cache_read_input_tokens > 0;

    return {
      events,
      todos,
      currentTask,
      tokenUsage: hasTokens ? tokenUsage : null
    };
  }

  /**
   * Get icon for subagent type
   */
  private getSubagentIcon(subagentType: string): string {
    switch (subagentType.toLowerCase()) {
      case 'explore':
        return '🔍';
      case 'plan':
        return '📋';
      case 'bash':
        return '⚡';
      default:
        return '🤖';
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
   * Broadcast a task live update (can be called externally)
   */
  async emitTaskLiveUpdate(taskId: string, payload: TaskLiveUpdatePayload): Promise<void> {
    this.io.to(`task:live:${taskId}`).emit(TASK_LIVE_UPDATE, payload);
  }

  /**
   * Broadcast queue stats update (can be called externally)
   */
  async emitQueueStatsUpdate(payload: QueueStatsUpdatePayload): Promise<void> {
    this.io.to('queue:stats').emit(QUEUE_STATS_UPDATE, payload);
  }

  /**
   * Check if there are clients subscribed to a specific task's live updates
   */
  hasTaskLiveSubscribers(taskId: string): boolean {
    const room = this.io.sockets.adapter.rooms.get(`task:live:${taskId}`);
    return room !== undefined && room.size > 0;
  }

  /**
   * Check if there are clients subscribed to queue stats
   */
  hasQueueStatsSubscribers(): boolean {
    const room = this.io.sockets.adapter.rooms.get('queue:stats');
    return room !== undefined && room.size > 0;
  }

  /**
   * Clean up resources on shutdown
   */
  async close(): Promise<void> {
    try {
      // Stop queue stats interval
      if (this.queueStatsInterval) {
        clearInterval(this.queueStatsInterval);
        this.queueStatsInterval = null;
      }

      // Close queue events listener
      if (this.queueEvents) {
        await this.queueEvents.close();
        this.queueEvents = null;
      }

      // Close all task watchers
      for (const [taskId, watcher] of this.taskWatchers) {
        await watcher.watcher.close();
        console.log(`[SocketService] Closed watcher for task ${taskId}`);
      }
      this.taskWatchers.clear();

      // Unsubscribe from Redis
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
