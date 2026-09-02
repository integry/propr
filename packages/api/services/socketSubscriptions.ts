import type { Socket } from 'socket.io';
import type { SocketPrincipal } from '../auth.js';
import type { QueueBroadcaster } from './queueBroadcaster.js';
import { revalidateSocketAuthentication } from './socketAuthentication.js';
import type { QueueDependencies } from './socketService.js';
import type { TaskWatcherManager } from './taskWatcher.js';
import { GoalError, GoalRepository, loadMonitoredReposRaw } from '@propr/core';
import { toPublicGoalEvent } from '../routes/goalRouteDtos.js';
import {
  goalRoom, normalizeRepositorySubscription, normalizeSocketResourceId, taskRoom, userRoom,
} from './socketSubscriptionResources.js';
import {
  SocketSubscriptionState,
  type SocketSubscriptionErrorCode,
  type SocketSubscriptionRequest,
} from './socketSubscriptionState.js';
import {
  canAccessRepositoryIndexing as authorizeRepositoryIndexing,
  ownsDraft as authorizeDraft,
  taskExists as authorizeTask,
} from './socketResourceAuthorization.js';
import { emitGoalEvents, socketGoalErrorCode } from './socketGoalDelivery.js';

export {
  goalRoom, normalizeRepositorySubscription, normalizeSocketResourceId, taskRoom, userRoom,
} from './socketSubscriptionResources.js';

export const INSTANCE_OPERATIONAL_ROOM = 'instance:operational';
export const SOCKET_SUBSCRIPTION_ERROR = 'subscription:error';

export interface SocketSubscriptionErrorPayload {
  event: string;
  code: SocketSubscriptionErrorCode;
}

interface SocketSubscriptionDependencies {
  getQueueDependencies: () => QueueDependencies | null;
  getQueueBroadcaster: () => QueueBroadcaster | null;
  taskWatcherManager: TaskWatcherManager;
  isRepositoryEnabled?: (repository: string) => boolean | Promise<boolean>;
  goalAcknowledgementTimeoutMs?: number;
}

export class SocketSubscriptionManager {
  private readonly subscriptionState = new SocketSubscriptionState();
  private readonly goalTails = new WeakMap<Socket, Map<string, ReturnType<typeof setInterval>>>();

  constructor(private readonly dependencies: SocketSubscriptionDependencies) {}

  setup(socket: Socket): void {
    const principal = this.getPrincipal(socket);
    void socket.join(INSTANCE_OPERATIONAL_ROOM);
    void socket.join(userRoom(principal.user.id));
    this.setupTaskHandlers(socket);
    this.setupDraftHandlers(socket);
    this.setupIndexingHandlers(socket);
    this.setupQueueStatsHandlers(socket);
    this.setupGoalHandlers(socket);
    this.setupDisconnectHandler(socket);
  }

  private getPrincipal(socket: Socket): SocketPrincipal {
    const principal = socket.data.principal as SocketPrincipal | undefined;
    if (!principal) throw new Error('Authenticated Socket.IO connection is missing its principal');
    return principal;
  }

  private reject(
    socket: Socket,
    event: string,
    code: SocketSubscriptionErrorPayload['code'],
  ): void {
    socket.emit(SOCKET_SUBSCRIPTION_ERROR, { event, code } satisfies SocketSubscriptionErrorPayload);
  }

  private canJoin(socket: Socket, room: string): boolean {
    return this.subscriptionState.canJoin(socket, room);
  }

  async taskExists(taskId: string): Promise<boolean> {
    return authorizeTask(this.dependencies.getQueueDependencies, taskId);
  }

  async ownsDraft(socket: Socket, draftId: string): Promise<boolean> {
    return authorizeDraft(this.dependencies.getQueueDependencies, this.getPrincipal(socket), draftId);
  }

  async canAccessRepositoryIndexing(socket: Socket, repository: string): Promise<boolean> {
    return authorizeRepositoryIndexing(
      this.dependencies.getQueueDependencies, this.getPrincipal(socket), repository
    );
  }

  private canAccessAllRepositoryIndexing(socket: Socket): boolean {
    return this.getPrincipal(socket).authorization.permissions.includes('instance.manage_settings');
  }

  private async join(
    socket: Socket,
    request: SocketSubscriptionRequest,
  ): Promise<boolean> {
    const { event, room, authorize, authorizationError = 'FORBIDDEN', onJoined } = request;
    const generation = this.subscriptionState.begin(socket, room);
    let joined = false;
    try {
      if (!await revalidateSocketAuthentication(socket)) return false;
      if (!this.subscriptionState.current(socket, room, generation)) return false;
      const authorized = await authorize();
      if (!this.subscriptionState.current(socket, room, generation)) return false;
      if (!authorized) {
        this.reject(socket, event, authorizationError);
        return false;
      }
      if (!socket.connected) return false;
      if (!this.canJoin(socket, room)) {
        this.reject(socket, event, 'SUBSCRIPTION_LIMIT');
        return false;
      }
      if (!this.subscriptionState.current(socket, room, generation)) return false;
      await socket.join(room);
      joined = true;
      if (!this.subscriptionState.current(socket, room, generation)) return false;
      await onJoined?.();
      return true;
    } catch (error) {
      this.subscriptionState.cancel(socket, room);
      if (joined || socket.rooms.has(room)) await socket.leave(room);
      throw error;
    } finally {
      this.subscriptionState.finish(socket, room);
    }
  }

  private setupTaskHandlers(socket: Socket): void {
    socket.on('subscribe:task', async (rawTaskId: unknown) => {
      const taskId = normalizeSocketResourceId(rawTaskId);
      if (!taskId) return this.reject(socket, 'subscribe:task', 'INVALID_RESOURCE');
      if (!await this.join(socket, {
        event: 'subscribe:task',
        room: taskRoom(taskId),
        authorize: () => this.taskExists(taskId),
      })) return;
      console.log(`[SocketService] Client ${socket.id} subscribed to task:${taskId}`);
    });

    socket.on('unsubscribe:task', async (rawTaskId: unknown) => {
      const taskId = normalizeSocketResourceId(rawTaskId);
      if (!taskId) return;
      const room = taskRoom(taskId);
      this.subscriptionState.cancel(socket, room);
      await socket.leave(room);
    });

    socket.on('subscribe:task:live', async (rawTaskId: unknown) => {
      const taskId = normalizeSocketResourceId(rawTaskId);
      if (!taskId) return this.reject(socket, 'subscribe:task:live', 'INVALID_RESOURCE');
      try {
        await this.join(socket, {
          event: 'subscribe:task:live',
          room: `task:live:${taskId}`,
          authorize: () => this.taskExists(taskId),
          onJoined: async () => {
            await this.dependencies.taskWatcherManager.startTaskWatcher(taskId);
            await this.dependencies.taskWatcherManager.sendTaskLiveUpdate(taskId, true);
          },
        });
      } catch (error) {
        console.error(`[SocketService] Failed to start live task subscription for ${taskId}:`, error);
      }
    });

    socket.on('unsubscribe:task:live', async (rawTaskId: unknown) => {
      const taskId = normalizeSocketResourceId(rawTaskId);
      if (!taskId) return;
      try {
        const room = `task:live:${taskId}`;
        this.subscriptionState.cancel(socket, room);
        await socket.leave(room);
        await this.dependencies.taskWatcherManager.stopTaskWatcherIfEmpty(taskId);
      } catch (error) {
        console.error(`[SocketService] Failed to stop live task subscription for ${taskId}:`, error);
      }
    });
  }

  private setupDraftHandlers(socket: Socket): void {
    socket.on('subscribe:draft', async (rawDraftId: unknown) => {
      const draftId = normalizeSocketResourceId(rawDraftId);
      if (!draftId) return this.reject(socket, 'subscribe:draft', 'INVALID_RESOURCE');
      if (!await this.join(socket, {
        event: 'subscribe:draft',
        room: `draft:${draftId}`,
        authorize: () => this.ownsDraft(socket, draftId),
      })) return;
      console.log(`[SocketService] Client ${socket.id} subscribed to draft:${draftId}`);
    });

    socket.on('unsubscribe:draft', async (rawDraftId: unknown) => {
      const draftId = normalizeSocketResourceId(rawDraftId);
      if (!draftId) return;
      const room = `draft:${draftId}`;
      this.subscriptionState.cancel(socket, room);
      await socket.leave(room);
    });
  }

  private setupIndexingHandlers(socket: Socket): void {
    socket.on('subscribe:indexing', async (rawRepository: unknown) => {
      const repository = normalizeRepositorySubscription(rawRepository);
      if (!repository) return this.reject(socket, 'subscribe:indexing', 'INVALID_RESOURCE');
      await this.join(socket, {
        event: 'subscribe:indexing',
        room: `indexing:${repository}`,
        authorize: () => this.canAccessRepositoryIndexing(socket, repository),
      });
    });
    socket.on('unsubscribe:indexing', async (rawRepository: unknown) => {
      const repository = normalizeRepositorySubscription(rawRepository);
      if (!repository) return;
      const room = `indexing:${repository}`;
      this.subscriptionState.cancel(socket, room);
      await socket.leave(room);
    });
    socket.on('subscribe:indexing:updates', async () => {
      await this.join(socket, {
        event: 'subscribe:indexing:updates',
        room: 'indexing:updates',
        authorize: () => this.canAccessAllRepositoryIndexing(socket),
      });
    });
    socket.on('unsubscribe:indexing:updates', async () => {
      const room = 'indexing:updates';
      this.subscriptionState.cancel(socket, room);
      await socket.leave(room);
    });
  }

  private setupQueueStatsHandlers(socket: Socket): void {
    socket.on('subscribe:queue:stats', async () => {
      if (!await this.join(socket, {
        event: 'subscribe:queue:stats',
        room: 'queue:stats',
        authorize: () => true,
      })) return;
      await this.dependencies.getQueueBroadcaster()?.broadcastQueueStats();
    });
    socket.on('unsubscribe:queue:stats', async () => {
      const room = 'queue:stats';
      this.subscriptionState.cancel(socket, room);
      await socket.leave(room);
    });
  }

  private async ownsGoal(socket: Socket, goalId: string): Promise<boolean> {
    const database = this.dependencies.getQueueDependencies()?.db;
    if (!database) return false;
    const goal = await database('goals').where('goal_id', goalId)
      .first('owner_user_id', 'repository') as { owner_user_id?: string; repository?: string } | undefined;
    if (goal?.owner_user_id !== this.getPrincipal(socket).user.id || !goal.repository) return false;
    if (this.dependencies.isRepositoryEnabled) {
      return this.dependencies.isRepositoryEnabled(goal.repository);
    }
    const repositories = await loadMonitoredReposRaw();
    return repositories.some(entry => entry.name === goal.repository && entry.enabled);
  }

  private setupGoalHandlers(socket: Socket): void {
    socket.on('subscribe:goal', async (raw: unknown) => {
      const request = typeof raw === 'string' ? { goalId: raw, cursor: null }
        : raw && typeof raw === 'object' ? raw as { goalId?: unknown; cursor?: unknown }
          : { goalId: null, cursor: null };
      const goalId = normalizeSocketResourceId(request.goalId);
      const cursor = request.cursor === undefined || request.cursor === null
        ? null : typeof request.cursor === 'string' ? request.cursor : undefined;
      if (!goalId || cursor === undefined) return this.reject(socket, 'subscribe:goal', 'INVALID_RESOURCE');
      const room = goalRoom(goalId);
      try {
        await this.join(socket, {
          event: 'subscribe:goal', room,
          authorize: () => this.ownsGoal(socket, goalId),
          authorizationError: 'RECONNECT_REQUIRED',
          onJoined: async () => {
            const database = this.dependencies.getQueueDependencies()?.db;
            if (!database) return;
            const repository = new GoalRepository(database);
            let replayCursor = cursor;
            let pages = 0;
            // Joining precedes the SQL high-watermark read. New writes are
            // therefore either in this replay or in the subsequent SQL tail;
            // Socket.IO delivery is never treated as a durability ack.
            while (pages < 10) {
              if (!await revalidateSocketAuthentication(socket) || !await this.ownsGoal(socket, goalId)) {
                throw new GoalError('goal_repository_forbidden', 'Repository access was revoked', 403);
              }
              const page = await repository.readEventPage(goalId, {
                cursor: replayCursor, limit: 100, maxBytes: 256 * 1024,
              });
              if (page.events.length > 0) {
                if (!await revalidateSocketAuthentication(socket) || !await this.ownsGoal(socket, goalId)) {
                  throw new GoalError('goal_repository_forbidden', 'Repository access was revoked', 403);
                }
                await emitGoalEvents(socket, {
                  schemaVersion: 1, goalId,
                  events: page.events.map(toPublicGoalEvent),
                  cursor: page.lastCursor,
                  asOfSequence: page.asOfSequence,
                }, this.dependencies.goalAcknowledgementTimeoutMs);
              }
              replayCursor = page.lastCursor;
              pages += 1;
              if (!page.nextCursor) break;
            }
            if (pages === 10) {
              socket.emit(SOCKET_SUBSCRIPTION_ERROR, {
                event: 'subscribe:goal', code: 'SUBSCRIPTION_LIMIT',
              } satisfies SocketSubscriptionErrorPayload);
              await socket.leave(room);
              return;
            }
            socket.emit('goal:subscribed', {
              schemaVersion: 1, goalId, cursor: replayCursor,
            });
            this.startGoalTail(socket, goalId, replayCursor);
          },
        });
      } catch (error) {
        console.error(`[SocketService] Failed goal subscription for ${goalId}:`, error);
        this.stopGoalTail(socket, goalId);
        await socket.leave(room);
        this.reject(socket, 'subscribe:goal', socketGoalErrorCode(error));
      }
    });

    socket.on('unsubscribe:goal', async (rawGoalId: unknown) => {
      const goalId = normalizeSocketResourceId(rawGoalId);
      if (!goalId) return;
      const room = goalRoom(goalId);
      this.subscriptionState.cancel(socket, room);
      this.stopGoalTail(socket, goalId);
      await socket.leave(room);
    });
  }

  private startGoalTail(socket: Socket, goalId: string, initialCursor: string | null): void {
    this.stopGoalTail(socket, goalId);
    let tails = this.goalTails.get(socket);
    if (!tails) {
      tails = new Map();
      this.goalTails.set(socket, tails);
    }
    let cursor = initialCursor;
    let running = false;
    let backpressureTicks = 0;
    const timer = setInterval(() => {
      if (running) return;
      running = true;
      void (async () => {
        const room = goalRoom(goalId);
        if (!socket.connected || !socket.rooms.has(room)) return this.stopGoalTail(socket, goalId);
        if (!socket.conn.transport.writable) {
          backpressureTicks += 1;
          if (backpressureTicks >= 10) {
            this.stopGoalTail(socket, goalId);
            await socket.leave(room);
            this.reject(socket, 'subscribe:goal', 'RECONNECT_REQUIRED');
          }
          return;
        }
        backpressureTicks = 0;
        if (!await revalidateSocketAuthentication(socket) || !await this.ownsGoal(socket, goalId)) {
          this.stopGoalTail(socket, goalId);
          await socket.leave(room);
          this.reject(socket, 'subscribe:goal', 'RECONNECT_REQUIRED');
          return;
        }
        const database = this.dependencies.getQueueDependencies()?.db;
        if (!database) return;
        const page = await new GoalRepository(database).readEventPage(goalId, {
          cursor, limit: 100, maxBytes: 256 * 1024,
        });
        if (page.events.length > 0) {
          if (!socket.connected || !socket.rooms.has(room) || !socket.conn.transport.writable
            || !await revalidateSocketAuthentication(socket) || !await this.ownsGoal(socket, goalId)) {
            throw new GoalError('goal_repository_forbidden', 'Goal delivery authorization changed', 403);
          }
          await emitGoalEvents(socket, {
            schemaVersion: 1, goalId, events: page.events.map(toPublicGoalEvent),
            cursor: page.lastCursor, asOfSequence: page.asOfSequence,
          }, this.dependencies.goalAcknowledgementTimeoutMs);
          cursor = page.lastCursor;
        }
      })().catch(async error => {
        console.error(`[SocketService] Goal tail failed for ${goalId}:`, error);
        this.stopGoalTail(socket, goalId);
        await socket.leave(goalRoom(goalId));
        this.reject(socket, 'subscribe:goal', socketGoalErrorCode(error));
      }).finally(() => { running = false; });
    }, 500);
    timer.unref?.();
    tails.set(goalId, timer);
  }

  private stopGoalTail(socket: Socket, goalId: string): void {
    const tails = this.goalTails.get(socket);
    const timer = tails?.get(goalId);
    if (timer) clearInterval(timer);
    tails?.delete(goalId);
    if (tails?.size === 0) this.goalTails.delete(socket);
  }

  private setupDisconnectHandler(socket: Socket): void {
    let liveTaskIds: string[] = [];
    socket.on('disconnecting', () => {
      liveTaskIds = [...socket.rooms]
        .filter(room => room.startsWith('task:live:'))
        .map(room => room.slice('task:live:'.length));
    });
    socket.on('disconnect', (reason: string) => {
      console.log(`[SocketService] Client disconnected: ${socket.id}, reason: ${reason}`);
      for (const taskId of liveTaskIds) {
        void this.dependencies.taskWatcherManager.stopTaskWatcherIfEmpty(taskId).catch(error => {
          console.error(`[SocketService] Failed to stop disconnected live task watcher ${taskId}:`, error);
        });
      }
      const tails = this.goalTails.get(socket);
      if (tails) for (const timer of tails.values()) clearInterval(timer);
      this.goalTails.delete(socket);
    });
  }
}
