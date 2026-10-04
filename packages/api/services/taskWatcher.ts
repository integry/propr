/* eslint-disable max-lines */
import { Server as SocketIOServer } from 'socket.io';
import { RedisClientType } from 'redis';
import { Knex } from 'knex';
import * as chokidar from 'chokidar';
import path from 'path';
import os from 'os';
import fs from 'fs-extra';
import { TASK_LIVE_UPDATE, type TaskLiveUpdatePayload } from '@propr/shared';
import { parseConversationFile } from './conversationParser.js';
import { withStableLiveEventIds } from './liveEventIds.js';
import { selectLiveEvents } from './liveEventSelection.js';
import { projectLiveOutputRead, readLiveOutput, type LiveOutputProjector, type LiveOutputRead, type LiveOutputRedis } from './liveOutputStream.js';
import { resolveConfigPath } from '@propr/core';
import { findAgentConfigForTask, findExecutionStartTimestampForTask, findLatestExecutionStartForTask } from './taskWatcherLookup.js';

const LIVE_EXECUTION_STATES = new Set(['claude_execution', 'codex_execution', 'gemini_execution', 'opencode_execution']);

function canContinueProjection(projector: LiveOutputProjector, read: LiveOutputRead): boolean {
  return read.epoch !== 'legacy' && read.epoch === projector.epoch
    && read.start === projector.start && read.from === projector.offset && projector.offset <= read.end;
}

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
  /** Redis watchers: projection of the append-only live output read so far. */
  liveProjector?: LiveOutputProjector;
  /** Exact metadata-free snapshot last projected; legacy writers may replace any byte. */
  lastLegacySnapshot?: string;
  liveReadPromise?: Promise<void>;
  /** Last broadcast buffered message and snapshot, so unchanged polls send nothing. */
  lastPendingSignature?: string;
  lastSnapshotSignature?: string;
}

/** Dependencies for task watching */
export interface TaskWatcherDeps {
  redisClient: RedisClientType;
  db: Knex;
}

/** Add a stable ID based on the event's absolute position in the parsed stream. */
export { withStableLiveEventIds } from './liveEventIds.js';

/**
 * TaskWatcherManager handles watching Claude log files and broadcasting updates.
 */
export class TaskWatcherManager {
  private io: SocketIOServer;
  private taskWatchers: Map<string, TaskWatcherInfo> = new Map();
  private deps: TaskWatcherDeps | null = null;
  /** Poll cadence while a file-creation watcher waits for late Redis output. */
  private redisFallbackPollMs = 2000;

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
   * Start watching a task's log for changes (file-based for Claude, Redis-based for agents that stream to Redis)
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

    // Docker-backed agents stream their live output through Redis. Prefer that
    // source when it is already available, even if older task metadata does not
    // identify the agent type reliably.
    if (await this.hasRedisOutput(taskId)) {
      console.log(`[TaskWatcher] Redis output found for task ${taskId}, using Redis watcher`);
      await this.startRedisWatcher(taskId);
      return;
    }

    // Get agent config to find the correct log path
    const agentConfig = await findAgentConfigForTask(taskId, this.deps?.db);
    const agentType = agentConfig?.type || 'claude';
    const agentRoot = agentConfig ? resolveConfigPath(agentConfig.configPath) : path.join(os.homedir(), '.claude');

    let conversationPath: string;
    if (agentType === 'codex' || agentType === 'antigravity' || agentType === 'vibe') {
      console.log(`[TaskWatcher] ${agentType} task detected (root: ${agentRoot}), using Redis watcher for ${taskId}`);
      await this.startRedisWatcher(taskId);
      return;
    } else if (agentType === 'opencode') {
      console.log(`[TaskWatcher] OpenCode task detected (root: ${agentRoot}), using Redis watcher for ${taskId}`);
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

      // The API commonly mounts agent credentials read-only. A missing Claude
      // log directory must not turn a live-view subscription into an unhandled
      // rejection that terminates the API process.
      try {
        await fs.ensureDir(dirPath);
      } catch (error) {
        console.warn(`[TaskWatcher] Cannot prepare Claude log directory for task ${taskId}; falling back to Redis watcher:`, error);
        await this.startRedisWatcher(taskId);
        return;
      }

      // Watch the directory for the file to be created
      // Use polling to avoid EMFILE errors when directory has many files
      const watcher = chokidar.watch(dirPath, {
        persistent: true,
        ignoreInitial: true,
        depth: 0, // Only watch the directory itself, not subdirectories
        usePolling: true,
        interval: 500,
        awaitWriteFinish: {
          stabilityThreshold: 100,
          pollInterval: 50
        }
      });

      watcher.on('add', async (addedPath) => {
        // Check if this is the file we're waiting for
        if (path.basename(addedPath) === fileName) {
          try {
            console.log(`[TaskWatcher] Claude log file created for task ${taskId}, switching to file watcher`);

            // File has been created - switch to watching the file directly
            await this.switchToFileWatcher(taskId, conversationPath, sessionId);

            // Send initial update now that file exists
            await this.sendTaskLiveUpdate(taskId, true);
          } catch (error) {
            console.error(`[TaskWatcher] Failed to switch watcher for task ${taskId}:`, error);
          }
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
        watchingForCreation: true,
        redisPollingInterval: this.startRedisFallbackPolling(taskId)
      });

      console.log(`[TaskWatcher] Started watching directory for Claude log creation for task ${taskId}`);
      return;
    }

    // File exists - watch it directly for changes
    // Use polling to avoid EMFILE errors
    const watcher = chokidar.watch(conversationPath, {
      persistent: true,
      ignoreInitial: true,
      usePolling: true,
      interval: 500,
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

    // Close the directory watcher and the Redis fallback poll that ran with it
    if (existing.watcher) {
      await existing.watcher.close();
    }
    if (existing.redisPollingInterval) {
      clearInterval(existing.redisPollingInterval);
    }

    // Create a new watcher for the file itself
    // Use polling to avoid EMFILE errors
    const watcher = chokidar.watch(conversationPath, {
      persistent: true,
      ignoreInitial: true,
      usePolling: true,
      interval: 500,
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
      const stableEvents = withStableLiveEventIds({
        taskId: this.normalizeTaskId(taskId),
        source: 'conversation',
        events: result.events,
        totalEventCount: result.totalEventCount,
        executionNamespace: watcherInfo.sessionId,
      });
      let eventsToSend = stableEvents;
      let omittedEventCount: number | undefined;
      if (isInitial) {
        ({ events: eventsToSend, omittedEventCount } = selectLiveEvents(stableEvents));
        console.log(`[TaskWatcher] Initial subscription for task ${taskId}: sending ${eventsToSend.length} of ${stableEvents.length} events`);
      } else {
        // Only events past the last broadcast; the parser returns the whole conversation.
        eventsToSend = stableEvents.slice(Math.min(watcherInfo.lastSentEventCount, stableEvents.length));
        if (eventsToSend.length > 0) console.log(`[TaskWatcher] Incremental update for task ${taskId}: sending ${eventsToSend.length} new events`);
      }
      watcherInfo.lastSentEventCount = result.totalEventCount;

      const payload: TaskLiveUpdatePayload = {
        eventType: TASK_LIVE_UPDATE,
        taskId,
        events: eventsToSend,
        todos: result.todos,
        currentTask: result.currentTask,
        tokenUsage: result.tokenUsage,
        timestamp: new Date().toISOString(),
        ...(omittedEventCount !== undefined ? { omittedEventCount } : {}),
      };

      // Emit directly to the room
      this.io.to(`task:live:${taskId}`).emit(TASK_LIVE_UPDATE, payload);
    } catch (error) {
      console.error(`[TaskWatcher] Error sending live update for task ${taskId}:`, error);
    }
  }

  /**
   * Check if task has Redis output (every Docker-backed agent streams there)
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
   * Watch for Redis output appearing after a file-creation watcher started.
   *
   * `claude --no-session-persistence` tasks never write the conversation file
   * that watcher waits for, and a subscription can arrive after onSessionId
   * fired but before the first interval-based Redis flush - so hasRedisOutput
   * was false at dispatch time. Keep re-checking and switch to the Redis
   * watcher once output shows up, instead of leaving the subscriber on a
   * directory watch that will never fire.
   */
  private startRedisFallbackPolling(taskId: string): ReturnType<typeof setInterval> {
    let switching = false;
    const interval = setInterval(async () => {
      if (switching) return;
      const watcherInfo = this.taskWatchers.get(taskId);
      if (!watcherInfo || !watcherInfo.watchingForCreation) {
        clearInterval(interval);
        return;
      }
      if (!(await this.hasRedisOutput(taskId))) return;
      switching = true;
      clearInterval(interval);
      console.log(`[TaskWatcher] Redis output appeared for task ${taskId}, switching from file-creation watcher`);
      try {
        if (watcherInfo.watcher) {
          await watcherInfo.watcher.close();
        }
        this.taskWatchers.delete(taskId);
        await this.startRedisWatcher(taskId, watcherInfo.subscriberCount);
      } catch (error) {
        console.error(`[TaskWatcher] Failed to switch task ${taskId} to Redis watcher:`, error);
      }
    }, this.redisFallbackPollMs);
    return interval;
  }

  /**
   * Start Redis-based watcher for agents that stream output to Redis
   */
  private async startRedisWatcher(taskId: string, subscriberCount = 1): Promise<void> {
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
      subscriberCount,
      lastSentEventCount: 0,
      watchingForCreation: false,
      redisPollingInterval: interval
    });

    // Send initial update
    await this.sendRedisLiveUpdate(taskId, true);
  }

  /**
   * Send live update from Redis output
   */
  private async sendRedisLiveUpdate(taskId: string, isInitial = false): Promise<void> {
    const watcherInfo = this.taskWatchers.get(taskId);
    if (!this.deps || !watcherInfo) return;

    // Serialize polls: an awaited read must not feed bytes already consumed by another poll.
    const run = (watcherInfo.liveReadPromise ?? Promise.resolve()).then(async () => {
      if (this.taskWatchers.get(taskId) !== watcherInfo) return;
      await this.publishRedisLiveUpdate(taskId, watcherInfo, isInitial);
    });
    watcherInfo.liveReadPromise = run;
    await run;
  }

  private async publishRedisLiveUpdate(taskId: string, watcherInfo: TaskWatcherInfo, isInitial: boolean): Promise<void> {
    try {
      const update = await this.readRedisLiveEvents(taskId, watcherInfo, isInitial);
      if (!update || this.taskWatchers.get(taskId) !== watcherInfo) return;
      const { events, omittedEventCount, historyTruncated } = update;
      const snapshot = update.projector.snapshot();
      const liveOutputPosition = update.projector.position();
      const snapshotSignature = JSON.stringify([snapshot.todos, snapshot.currentTask, snapshot.tokenUsage]);
      if (events.length === 0 && omittedEventCount === undefined && snapshotSignature === watcherInfo.lastSnapshotSignature) return;
      watcherInfo.lastSnapshotSignature = snapshotSignature;

      const payload: TaskLiveUpdatePayload = {
        eventType: TASK_LIVE_UPDATE,
        taskId,
        events,
        todos: snapshot.todos as TaskLiveUpdatePayload['todos'],
        currentTask: snapshot.currentTask,
        tokenUsage: snapshot.tokenUsage,
        timestamp: new Date().toISOString(),
        ...(omittedEventCount !== undefined ? { omittedEventCount } : {}),
        ...(historyTruncated ? { historyTruncated } : {}),
        ...(liveOutputPosition ? { liveOutputPosition } : {}),
      };
      this.io.to(`task:live:${taskId}`).emit(TASK_LIVE_UPDATE, payload);
    } catch (error) {
      console.error(`[TaskWatcher] Error sending Redis live update for task ${taskId}:`, error);
    }
  }

  /**
   * Events to broadcast from the task's append-only live output. After the
   * first read only output past the last read is fetched and parsed; a new
   * execution, or output trimmed past what was read, starts over from the top
   * and is sent as full state (with `omittedEventCount`, and `historyTruncated`
   * once output of the execution was discarded). Legacy replacement
   * writers are compared and projected as complete snapshots on every change.
   */
  private async readRedisLiveEvents(
    taskId: string,
    watcherInfo: TaskWatcherInfo,
    isInitial: boolean,
  ): Promise<{ events: TaskLiveUpdatePayload['events']; omittedEventCount?: number; historyTruncated?: boolean; projector: LiveOutputProjector } | null> {
    const redis = this.deps!.redisClient as unknown as LiveOutputRedis;
    const projector = isInitial ? undefined : watcherInfo.liveProjector;
    const read = await readLiveOutput(redis, taskId, projector?.offset ?? 0);
    if (this.taskWatchers.get(taskId) !== watcherInfo) return null;
    if (!read) return null;
    if (!isInitial && read.epoch === 'legacy' && read.text === watcherInfo.lastLegacySnapshot) return null;
    if (projector && canContinueProjection(projector, read)) {
      return this.continueRedisProjection(taskId, watcherInfo, projector, read);
    }
    const executionStart = await this.findExecutionStartTimestampForTask(taskId);
    if (this.taskWatchers.get(taskId) !== watcherInfo) return null;
    // Incremental reads that need resync may begin after the retained prefix.
    const fullRead = read.epoch === 'legacy' || read.from === read.base ? read : await readLiveOutput(redis, taskId);
    if (!fullRead || this.taskWatchers.get(taskId) !== watcherInfo) return null;
    // Metadata-free output repeats epoch `legacy` in every execution; scope its IDs as HTTP reads do.
    const legacyExecution = fullRead.epoch === 'legacy' && this.deps
      ? await findLatestExecutionStartForTask(this.deps, this.normalizeTaskId(taskId))
      : null;
    if (this.taskWatchers.get(taskId) !== watcherInfo) return null;
    const full = projectLiveOutputRead(fullRead, taskId, executionStart, { legacyExecution });
    watcherInfo.lastLegacySnapshot = fullRead.epoch === 'legacy' ? fullRead.text : undefined;
    watcherInfo.liveProjector = full.projector;
    console.log(`[TaskWatcher] Full Redis update for task ${taskId}: sending ${full.events.length} events (${full.omittedEventCount} raw events omitted, earlier output discarded: ${full.truncated})`);
    return { events: full.events, omittedEventCount: full.omittedEventCount, historyTruncated: full.truncated, projector: full.projector };
  }


  private continueRedisProjection(taskId: string, watcherInfo: TaskWatcherInfo, projector: LiveOutputProjector, read: LiveOutputRead) {
    const events = projector.feed(read.text, read.from);
    const pending = projector.pending();
    const pendingSignature = pending ? `${pending.id}:${String((pending as { content?: unknown }).content ?? '').length}` : '';
    if (pending && pendingSignature !== watcherInfo.lastPendingSignature) events.push(pending);
    watcherInfo.lastPendingSignature = pendingSignature;
    if (events.length > 0) console.log(`[TaskWatcher] Redis update for task ${taskId}: sending ${events.length} new events`);
    return { events, projector };
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
        const entry = [...state.history].reverse().find(
          h => LIVE_EXECUTION_STATES.has(h.state) && h.metadata?.sessionId
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

  private async findExecutionStartTimestampForTask(taskId: string): Promise<string | null> {
    if (!this.deps) return null;
    return findExecutionStartTimestampForTask(this.deps, this.normalizeTaskId(taskId));
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
