import { Server as SocketIOServer } from 'socket.io';
import { RedisClientType } from 'redis';
import { Knex } from 'knex';
import * as chokidar from 'chokidar';
import path from 'path';
import os from 'os';
import fs from 'fs-extra';
import { TASK_LIVE_UPDATE, type TaskLiveUpdatePayload } from '@propr/shared';
import { parseConversationFile } from './conversationParser.js';
import { parseRedisOutput } from './redisOutputParser.js';
import { loadAgents, resolveConfigPath, type AgentConfig } from '@propr/core';

/** Active task watcher info */
export interface TaskWatcherInfo {
  watcher: chokidar.FSWatcher | null;
  sessionId: string;
  taskId: string;
  lastSize: number;
  subscriberCount: number;
  /** Number of events last sent - used to track which events have been broadcast */
  lastSentEventCount: number;
  /** Whether we're watching for file creation (true) or file changes (false) */
  watchingForCreation: boolean;
  /** Polling interval for Redis-based streaming (Codex) */
  redisPollingInterval?: ReturnType<typeof setInterval>;
  /** Last content length from Redis (for change detection) */
  lastRedisLength?: number;
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
   * Start watching a task's log for changes (file-based for Claude, Redis-based for Codex)
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
      console.log(`[TaskWatcher] No session found for task ${taskId}, trying Redis watcher`);
      await this.startRedisWatcher(taskId);
      return;
    }

    // Get agent config to find the correct log path
    const agentConfig = await this.findAgentConfigForTask(taskId);
    const agentType = agentConfig?.type || 'claude';
    const agentRoot = agentConfig ? resolveConfigPath(agentConfig.configPath) : path.join(os.homedir(), '.claude');

    let conversationPath: string;
    if (agentType === 'codex') {
      // Codex streams to Redis, use Redis watcher
      console.log(`[TaskWatcher] Codex task detected (root: ${agentRoot}), using Redis watcher for ${taskId}`);
      await this.startRedisWatcher(taskId);
      return;
    } else if (agentType === 'gemini') {
      // Gemini streams to Redis, use Redis watcher
      console.log(`[TaskWatcher] Gemini task detected (root: ${agentRoot}), using Redis watcher for ${taskId}`);
      await this.startRedisWatcher(taskId);
      return;
    } else {
      // Claude logs are at {agentRoot}/projects/-home-node-workspace/SESSIONID.jsonl
      conversationPath = path.join(
        agentRoot,
        'projects',
        '-home-node-workspace',
        `${sessionId}.jsonl`
      );
    }

    // Check if file exists
    const exists = await fs.pathExists(conversationPath);

    if (!exists) {
      // File doesn't exist yet - watch the directory for file creation
      console.log(`[TaskWatcher] Claude log file not found for task ${taskId}, watching for creation: ${conversationPath}`);

      const dirPath = path.dirname(conversationPath);
      const fileName = path.basename(conversationPath);

      // Ensure directory exists
      await fs.ensureDir(dirPath);

      // Watch the directory for the file to be created
      const watcher = chokidar.watch(dirPath, {
        persistent: true,
        ignoreInitial: true,
        depth: 0, // Only watch the directory itself, not subdirectories
        awaitWriteFinish: {
          stabilityThreshold: 100,
          pollInterval: 50
        }
      });

      watcher.on('add', async (addedPath) => {
        // Check if this is the file we're waiting for
        if (path.basename(addedPath) === fileName) {
          console.log(`[TaskWatcher] Claude log file created for task ${taskId}, switching to file watcher`);

          // File has been created - switch to watching the file directly
          await this.switchToFileWatcher(taskId, conversationPath, sessionId);

          // Send initial update now that file exists
          await this.sendTaskLiveUpdate(taskId, true);
        }
      });

      watcher.on('error', (error) => {
        console.error(`[TaskWatcher] Directory watcher error for task ${taskId}:`, error);
      });

      this.taskWatchers.set(taskId, {
        watcher,
        sessionId,
        taskId,
        lastSize: 0,
        subscriberCount: 1,
        lastSentEventCount: 0,
        watchingForCreation: true
      });

      console.log(`[TaskWatcher] Started watching directory for Claude log creation for task ${taskId}`);
      return;
    }

    // File exists - watch it directly for changes
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
      lastSentEventCount: 0,
      watchingForCreation: false
    });

    console.log(`[TaskWatcher] Started watching Claude log for task ${taskId}`);
  }

  /**
   * Switch from watching directory (for file creation) to watching the file directly.
   * Called when the file is created after we started watching for it.
   */
  private async switchToFileWatcher(taskId: string, conversationPath: string, sessionId: string): Promise<void> {
    const existing = this.taskWatchers.get(taskId);
    if (!existing) return;

    // Close the directory watcher
    if (existing.watcher) {
      await existing.watcher.close();
    }

    // Create a new watcher for the file itself
    const watcher = chokidar.watch(conversationPath, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 100,
        pollInterval: 50
      }
    });

    watcher.on('change', async () => {
      await this.sendTaskLiveUpdate(taskId);
    });

    watcher.on('error', (error) => {
      console.error(`[TaskWatcher] Watcher error for task ${taskId}:`, error);
    });

    // Update the watcher info
    this.taskWatchers.set(taskId, {
      watcher,
      sessionId,
      taskId,
      lastSize: 0,
      subscriberCount: existing.subscriberCount,
      lastSentEventCount: 0,
      watchingForCreation: false
    });

    console.log(`[TaskWatcher] Switched to file watcher for task ${taskId}`);
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
      if (watcher.watcher) {
        await watcher.watcher.close();
      }
      if (watcher.redisPollingInterval) {
        clearInterval(watcher.redisPollingInterval);
      }
      this.taskWatchers.delete(taskId);
      console.log(`[TaskWatcher] Stopped watching for task ${taskId}`);
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
   * Check if task has Redis output (indicates Codex/non-Claude agent)
   */
  private async hasRedisOutput(taskId: string): Promise<boolean> {
    if (!this.deps) return false;
    try {
      const output = await this.deps.redisClient.get(`agent:output:${taskId}`);
      return output !== null && output.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Start Redis-based watcher for Codex tasks
   */
  private async startRedisWatcher(taskId: string): Promise<void> {
    console.log(`[TaskWatcher] Starting Redis watcher for task ${taskId}`);

    // Poll Redis every 2 seconds for output changes
    const interval = setInterval(async () => {
      await this.sendRedisLiveUpdate(taskId);
    }, 2000);

    this.taskWatchers.set(taskId, {
      watcher: null,
      sessionId: taskId, // Use taskId as identifier
      taskId,
      lastSize: 0,
      subscriberCount: 1,
      lastSentEventCount: 0,
      watchingForCreation: false,
      redisPollingInterval: interval,
      lastRedisLength: 0
    });

    // Send initial update
    await this.sendRedisLiveUpdate(taskId, true);
  }

  /**
   * Send live update from Redis output (for Codex tasks)
   */
  private async sendRedisLiveUpdate(taskId: string, isInitial = false): Promise<void> {
    if (!this.deps) return;

    const watcherInfo = this.taskWatchers.get(taskId);
    if (!watcherInfo) return;

    try {
      const output = await this.deps.redisClient.get(`agent:output:${taskId}`);
      if (!output) return;

      // Check if content changed
      if (!isInitial && output.length === watcherInfo.lastRedisLength) {
        return; // No change
      }
      watcherInfo.lastRedisLength = output.length;

      // Parse the output using the Redis output parser
      const lines = output.trim().split('\n').filter((line: string) => line.trim());
      const result = parseRedisOutput(lines);

      // Determine which events to send
      let eventsToSend = result.events;
      if (!isInitial) {
        const lastSentCount = watcherInfo.lastSentEventCount;
        const totalCount = result.totalEventCount;
        if (totalCount > lastSentCount) {
          const newEventCount = totalCount - lastSentCount;
          eventsToSend = result.events.slice(-newEventCount);
          console.log(`[TaskWatcher] Redis update for task ${taskId}: sending ${eventsToSend.length} new events`);
        } else {
          eventsToSend = [];
        }
      } else {
        console.log(`[TaskWatcher] Initial Redis update for task ${taskId}: sending ${result.events.length} events`);
      }

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

      this.io.to(`task:live:${taskId}`).emit(TASK_LIVE_UPDATE, payload);
    } catch (error) {
      console.error(`[TaskWatcher] Error sending Redis live update for task ${taskId}:`, error);
    }
  }

  /**
   * Find the agent config for a task based on agent alias in task ID
   */
  private async findAgentConfigForTask(taskId: string): Promise<AgentConfig | null> {
    try {
      const agents = await loadAgents();
      // Extract agent alias from task ID (e.g., "integry-propr-test-48-codex-gpt-5.2-xxx" -> "codex")
      for (const agent of agents) {
        if (taskId.includes(`-${agent.alias}-`)) {
          return agent;
        }
      }
      // Fallback: check by type
      for (const agent of agents) {
        if (taskId.includes(`-${agent.type}-`)) {
          return agent;
        }
      }
      return null;
    } catch (error) {
      console.error('[TaskWatcher] Error loading agent config:', error);
      return null;
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
      if (watcher.watcher) {
        await watcher.watcher.close();
      }
      if (watcher.redisPollingInterval) {
        clearInterval(watcher.redisPollingInterval);
      }
      console.log(`[TaskWatcher] Closed watcher for task ${taskId}`);
    }
    this.taskWatchers.clear();
  }
}
