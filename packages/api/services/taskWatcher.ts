import { Server as SocketIOServer } from 'socket.io';
import { RedisClientType } from 'redis';
import { Knex } from 'knex';
import * as chokidar from 'chokidar';
import path from 'path';
import os from 'os';
import fs from 'fs-extra';
import { TASK_LIVE_UPDATE, type TaskLiveUpdatePayload } from '@propr/shared';
import { parseConversationFile } from './conversationParser.js';

/** Active task watcher info */
export interface TaskWatcherInfo {
  watcher: chokidar.FSWatcher;
  sessionId: string;
  taskId: string;
  lastSize: number;
  subscriberCount: number;
  /** Number of events last sent - used to track which events have been broadcast */
  lastSentEventCount: number;
}

/** Dependencies for task watching */
export interface TaskWatcherDeps {
  redisClient: RedisClientType;
  db: Knex;
}

/**
 * TaskWatcherManager handles watching Claude log files and broadcasting updates.
 */
export class TaskWatcherManager {
  private io: SocketIOServer;
  private taskWatchers: Map<string, TaskWatcherInfo> = new Map();
  private deps: TaskWatcherDeps | null = null;

  constructor(io: SocketIOServer) {
    this.io = io;
  }

  /**
   * Set dependencies for session ID lookup
   */
  setDeps(deps: TaskWatcherDeps): void {
    this.deps = deps;
  }

  /**
   * Start watching a task's Claude log file for changes
   */
  async startTaskWatcher(taskId: string): Promise<void> {
    // Check if already watching
    const existing = this.taskWatchers.get(taskId);
    if (existing) {
      existing.subscriberCount++;
      return;
    }

    // Find the session ID for this task
    const sessionId = await this.findSessionIdForTask(taskId);
    if (!sessionId) {
      console.log(`[TaskWatcher] No session found for task ${taskId}, cannot start watcher`);
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
      console.log(`[TaskWatcher] Claude log file not found for task ${taskId}: ${conversationPath}`);
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
      console.error(`[TaskWatcher] Watcher error for task ${taskId}:`, error);
    });

    this.taskWatchers.set(taskId, {
      watcher,
      sessionId,
      taskId,
      lastSize: initialSize,
      subscriberCount: 1,
      lastSentEventCount: 0
    });

    console.log(`[TaskWatcher] Started watching Claude log for task ${taskId}`);
  }

  /**
   * Stop watching a task's log file if no more subscribers
   */
  async stopTaskWatcherIfEmpty(taskId: string): Promise<void> {
    const watcher = this.taskWatchers.get(taskId);
    if (!watcher) return;

    watcher.subscriberCount--;

    // Check if there are still clients in the room
    const room = this.io.sockets.adapter.rooms.get(`task:live:${taskId}`);
    const hasClients = room && room.size > 0;

    if (watcher.subscriberCount <= 0 && !hasClients) {
      await watcher.watcher.close();
      this.taskWatchers.delete(taskId);
      console.log(`[TaskWatcher] Stopped watching Claude log for task ${taskId}`);
    }
  }

  /**
   * Send live task update to subscribed clients.
   * On initial subscription, sends full state. On subsequent calls, sends only new events.
   * @param taskId - Task identifier
   * @param isInitial - If true, sends full event history (used for initial subscription)
   */
  async sendTaskLiveUpdate(taskId: string, isInitial = false): Promise<void> {
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

      const result = await parseConversationFile(conversationPath);

      // Determine which events to send
      let eventsToSend = result.events;

      if (isInitial) {
        // Initial subscription: send full event history (already limited by parser)
        console.log(`[TaskWatcher] Initial subscription for task ${taskId}: sending ${result.events.length} events`);
      } else {
        // Incremental update: only send new events since last broadcast
        const lastSentCount = watcherInfo.lastSentEventCount;
        const totalCount = result.totalEventCount;

        if (totalCount <= lastSentCount) {
          // No new events to send (might be metadata-only update like todos)
          // Still send update for todos/currentTask changes
          eventsToSend = [];
        } else {
          // Calculate new events: we want events from lastSentCount to totalCount
          // Since result.events might be limited, we need to be careful
          const newEventCount = totalCount - lastSentCount;
          eventsToSend = result.events.slice(-newEventCount);
          console.log(`[TaskWatcher] Incremental update for task ${taskId}: sending ${eventsToSend.length} new events (${lastSentCount} -> ${totalCount})`);
        }
      }

      // Update last sent count to current total
      watcherInfo.lastSentEventCount = result.totalEventCount;

      const payload: TaskLiveUpdatePayload = {
        eventType: TASK_LIVE_UPDATE,
        taskId,
        events: eventsToSend,
        todos: result.todos,
        currentTask: result.currentTask,
        tokenUsage: result.tokenUsage,
        timestamp: new Date().toISOString()
      };

      // Emit directly to the room
      this.io.to(`task:live:${taskId}`).emit(TASK_LIVE_UPDATE, payload);
    } catch (error) {
      console.error(`[TaskWatcher] Error sending live update for task ${taskId}:`, error);
    }
  }

  /**
   * Find the session ID for a task from Redis or database
   */
  private async findSessionIdForTask(taskId: string): Promise<string | null> {
    if (!this.deps) {
      console.log('[TaskWatcher] Deps not initialized, cannot find session ID');
      return null;
    }

    const { redisClient, db } = this.deps;
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
      console.error('[TaskWatcher] Error fetching from Redis:', error);
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
      console.error('[TaskWatcher] Error fetching from database:', error);
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
   * Close all task watchers
   */
  async closeAll(): Promise<void> {
    for (const [taskId, watcher] of this.taskWatchers) {
      await watcher.watcher.close();
      console.log(`[TaskWatcher] Closed watcher for task ${taskId}`);
    }
    this.taskWatchers.clear();
  }
}
