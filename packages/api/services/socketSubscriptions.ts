import type { Socket } from 'socket.io';
import type { SocketPrincipal } from '../auth.js';
import type { QueueBroadcaster } from './queueBroadcaster.js';
import { revalidateSocketAuthentication } from './socketAuthentication.js';
import type { QueueDependencies } from './socketService.js';
import type { TaskWatcherManager } from './taskWatcher.js';

export const INSTANCE_OPERATIONAL_ROOM = 'instance:operational';
const USER_ROOM_PREFIX = 'user:';
const MAX_RESOURCE_ID_LENGTH = 512;
const MAX_RESOURCE_ROOMS_PER_SOCKET = 100;
const RESOURCE_ROOM_PREFIXES = ['task:', 'task:live:', 'draft:', 'indexing:'];
export const SOCKET_SUBSCRIPTION_ERROR = 'subscription:error';

export interface SocketSubscriptionErrorPayload {
  event: string;
  code: 'INVALID_RESOURCE' | 'FORBIDDEN' | 'SUBSCRIPTION_LIMIT';
}

interface SocketSubscriptionDependencies {
  getQueueDependencies: () => QueueDependencies | null;
  getQueueBroadcaster: () => QueueBroadcaster | null;
  taskWatcherManager: TaskWatcherManager;
}

interface PendingSubscriptionState {
  generation: symbol;
  pendingCount: number;
}

interface SocketSubscriptionRequest {
  event: string;
  room: string;
  authorize: () => boolean | Promise<boolean>;
  onJoined?: () => void | Promise<void>;
}

export function normalizeSocketResourceId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_RESOURCE_ID_LENGTH) return null;
  for (const char of normalized) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint <= 31 || codePoint === 127) return null;
  }
  return normalized;
}

export function normalizeRepositorySubscription(value: unknown): string | null {
  const normalized = normalizeSocketResourceId(value);
  if (!normalized || !/^[^/\s]+\/[^/\s]+$/.test(normalized)) return null;
  return normalized;
}

export function userRoom(userId: string): string {
  return `${USER_ROOM_PREFIX}${userId}`;
}

export function taskRoom(taskId: string): string {
  return `task:${encodeURIComponent(taskId)}`;
}

export class SocketSubscriptionManager {
  private readonly pendingSubscriptions = new WeakMap<Socket, Map<string, PendingSubscriptionState>>();

  constructor(private readonly dependencies: SocketSubscriptionDependencies) {}

  setup(socket: Socket): void {
    const principal = this.getPrincipal(socket);
    void socket.join(INSTANCE_OPERATIONAL_ROOM);
    void socket.join(userRoom(principal.user.id));
    this.setupTaskHandlers(socket);
    this.setupDraftHandlers(socket);
    this.setupIndexingHandlers(socket);
    this.setupQueueStatsHandlers(socket);
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
    if (socket.rooms.has(room)) return true;
    const resourceRoomCount = [...socket.rooms]
      .filter(existingRoom => RESOURCE_ROOM_PREFIXES.some(prefix => existingRoom.startsWith(prefix)))
      .length;
    return resourceRoomCount < MAX_RESOURCE_ROOMS_PER_SOCKET;
  }

  private beginPendingSubscription(socket: Socket, room: string): symbol {
    let socketSubscriptions = this.pendingSubscriptions.get(socket);
    if (!socketSubscriptions) {
      socketSubscriptions = new Map();
      this.pendingSubscriptions.set(socket, socketSubscriptions);
    }
    let state = socketSubscriptions.get(room);
    if (!state) {
      state = { generation: Symbol(), pendingCount: 0 };
      socketSubscriptions.set(room, state);
    }
    state.pendingCount += 1;
    return state.generation;
  }

  private cancelPendingSubscription(socket: Socket, room: string): void {
    const state = this.pendingSubscriptions.get(socket)?.get(room);
    if (state) state.generation = Symbol();
  }

  private isPendingSubscriptionCurrent(socket: Socket, room: string, generation: symbol): boolean {
    return this.pendingSubscriptions.get(socket)?.get(room)?.generation === generation;
  }

  private finishPendingSubscription(socket: Socket, room: string): void {
    const socketSubscriptions = this.pendingSubscriptions.get(socket);
    const state = socketSubscriptions?.get(room);
    if (!socketSubscriptions || !state) return;
    state.pendingCount -= 1;
    if (state.pendingCount > 0) return;
    socketSubscriptions.delete(room);
    if (socketSubscriptions.size === 0) this.pendingSubscriptions.delete(socket);
  }

  async taskExists(taskId: string): Promise<boolean> {
    const queueDependencies = this.dependencies.getQueueDependencies();
    if (!queueDependencies) return false;
    try {
      const stateKey = `${queueDependencies.workerStateOptions?.keyPrefix ?? 'worker:state:'}${taskId}`;
      if (await queueDependencies.redisClient.get(stateKey)) return true;
      const task = await queueDependencies.db('tasks')
        .select('task_id')
        .where({ task_id: taskId })
        .first();
      return Boolean(task);
    } catch (error) {
      console.error(`[SocketService] Failed to authorize task subscription for ${taskId}:`, error);
      return false;
    }
  }

  async ownsDraft(socket: Socket, draftId: string): Promise<boolean> {
    const queueDependencies = this.dependencies.getQueueDependencies();
    if (!queueDependencies) return false;
    try {
      const draft = await queueDependencies.db('task_drafts')
        .select('user_id')
        .where({ draft_id: draftId })
        .first() as { user_id?: string } | undefined;
      return draft?.user_id === this.getPrincipal(socket).user.id;
    } catch (error) {
      console.error(`[SocketService] Failed to authorize draft subscription for ${draftId}:`, error);
      return false;
    }
  }

  async canAccessRepositoryIndexing(socket: Socket, repository: string): Promise<boolean> {
    if (!this.canAccessAllRepositoryIndexing(socket)) return false;
    try {
      const queueDependencies = this.dependencies.getQueueDependencies();
      if (!queueDependencies) return false;
      const existingRepository = await queueDependencies.db('repositories')
        .select('full_name')
        .where({ full_name: repository })
        .first();
      return Boolean(existingRepository);
    } catch (error) {
      console.error(`[SocketService] Failed to authorize indexing subscription for ${repository}:`, error);
      return false;
    }
  }

  private canAccessAllRepositoryIndexing(socket: Socket): boolean {
    return this.getPrincipal(socket).authorization.permissions.includes('instance.manage_settings');
  }

  private async join(
    socket: Socket,
    request: SocketSubscriptionRequest,
  ): Promise<boolean> {
    const { event, room, authorize, onJoined } = request;
    const generation = this.beginPendingSubscription(socket, room);
    try {
      if (!await revalidateSocketAuthentication(socket)) return false;
      if (!this.isPendingSubscriptionCurrent(socket, room, generation)) return false;
      const authorized = await authorize();
      if (!this.isPendingSubscriptionCurrent(socket, room, generation)) return false;
      if (!authorized) {
        this.reject(socket, event, 'FORBIDDEN');
        return false;
      }
      if (!socket.connected) return false;
      if (!this.canJoin(socket, room)) {
        this.reject(socket, event, 'SUBSCRIPTION_LIMIT');
        return false;
      }
      if (!this.isPendingSubscriptionCurrent(socket, room, generation)) return false;
      await socket.join(room);
      if (!this.isPendingSubscriptionCurrent(socket, room, generation)) return false;
      await onJoined?.();
      return true;
    } finally {
      this.finishPendingSubscription(socket, room);
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
      this.cancelPendingSubscription(socket, room);
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
        this.cancelPendingSubscription(socket, room);
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
      this.cancelPendingSubscription(socket, room);
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
      this.cancelPendingSubscription(socket, room);
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
      this.cancelPendingSubscription(socket, room);
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
      this.cancelPendingSubscription(socket, room);
      await socket.leave(room);
    });
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
    });
  }
}
