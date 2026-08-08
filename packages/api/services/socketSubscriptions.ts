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

export class SocketSubscriptionManager {
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
    event: string,
    room: string,
    authorize: () => boolean | Promise<boolean>,
  ): Promise<boolean> {
    if (!await revalidateSocketAuthentication(socket)) return false;
    if (!await authorize()) {
      this.reject(socket, event, 'FORBIDDEN');
      return false;
    }
    if (!socket.connected) return false;
    if (!this.canJoin(socket, room)) {
      this.reject(socket, event, 'SUBSCRIPTION_LIMIT');
      return false;
    }
    await socket.join(room);
    return true;
  }

  private setupTaskHandlers(socket: Socket): void {
    socket.on('subscribe:task', async (rawTaskId: unknown) => {
      const taskId = normalizeSocketResourceId(rawTaskId);
      if (!taskId) return this.reject(socket, 'subscribe:task', 'INVALID_RESOURCE');
      if (!await this.join(socket, 'subscribe:task', `task:${taskId}`, () => this.taskExists(taskId))) return;
      console.log(`[SocketService] Client ${socket.id} subscribed to task:${taskId}`);
    });

    socket.on('unsubscribe:task', async (rawTaskId: unknown) => {
      const taskId = normalizeSocketResourceId(rawTaskId);
      if (taskId) await socket.leave(`task:${taskId}`);
    });

    socket.on('subscribe:task:live', async (rawTaskId: unknown) => {
      const taskId = normalizeSocketResourceId(rawTaskId);
      if (!taskId) return this.reject(socket, 'subscribe:task:live', 'INVALID_RESOURCE');
      try {
        if (!await this.join(socket, 'subscribe:task:live', `task:live:${taskId}`, () => this.taskExists(taskId))) return;
        await this.dependencies.taskWatcherManager.startTaskWatcher(taskId);
        await this.dependencies.taskWatcherManager.sendTaskLiveUpdate(taskId, true);
      } catch (error) {
        console.error(`[SocketService] Failed to start live task subscription for ${taskId}:`, error);
      }
    });

    socket.on('unsubscribe:task:live', async (rawTaskId: unknown) => {
      const taskId = normalizeSocketResourceId(rawTaskId);
      if (!taskId) return;
      try {
        await socket.leave(`task:live:${taskId}`);
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
      if (!await this.join(socket, 'subscribe:draft', `draft:${draftId}`, () => this.ownsDraft(socket, draftId))) return;
      console.log(`[SocketService] Client ${socket.id} subscribed to draft:${draftId}`);
    });

    socket.on('unsubscribe:draft', async (rawDraftId: unknown) => {
      const draftId = normalizeSocketResourceId(rawDraftId);
      if (draftId) await socket.leave(`draft:${draftId}`);
    });
  }

  private setupIndexingHandlers(socket: Socket): void {
    socket.on('subscribe:indexing', async (rawRepository: unknown) => {
      const repository = normalizeRepositorySubscription(rawRepository);
      if (!repository) return this.reject(socket, 'subscribe:indexing', 'INVALID_RESOURCE');
      await this.join(
        socket,
        'subscribe:indexing',
        `indexing:${repository}`,
        () => this.canAccessRepositoryIndexing(socket, repository),
      );
    });
    socket.on('unsubscribe:indexing', async (rawRepository: unknown) => {
      const repository = normalizeRepositorySubscription(rawRepository);
      if (repository) await socket.leave(`indexing:${repository}`);
    });
    socket.on('subscribe:indexing:updates', async () => {
      await this.join(
        socket,
        'subscribe:indexing:updates',
        'indexing:updates',
        () => this.canAccessAllRepositoryIndexing(socket),
      );
    });
    socket.on('unsubscribe:indexing:updates', async () => {
      await socket.leave('indexing:updates');
    });
  }

  private setupQueueStatsHandlers(socket: Socket): void {
    socket.on('subscribe:queue:stats', async () => {
      if (!await this.join(socket, 'subscribe:queue:stats', 'queue:stats', () => true)) return;
      await this.dependencies.getQueueBroadcaster()?.broadcastQueueStats();
    });
    socket.on('unsubscribe:queue:stats', async () => {
      await socket.leave('queue:stats');
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
