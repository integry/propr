import type { Socket } from 'socket.io';
import {
  MAX_RESOURCE_ROOMS_PER_SOCKET, RESOURCE_ROOM_PREFIXES,
} from './socketSubscriptionResources.js';

interface PendingSubscriptionState {
  generation: symbol;
  pendingCount: number;
}

export type SocketSubscriptionErrorCode =
  'INVALID_RESOURCE' | 'FORBIDDEN' | 'SUBSCRIPTION_LIMIT' | 'CURSOR_EXPIRED' | 'RECONNECT_REQUIRED';

export interface SocketSubscriptionRequest {
  event: string;
  room: string;
  authorize: () => boolean | Promise<boolean>;
  authorizationError?: SocketSubscriptionErrorCode;
  onJoined?: (isCurrent: () => boolean) => void | Promise<void>;
}

export class SocketSubscriptionState {
  private readonly pending = new WeakMap<Socket, Map<string, PendingSubscriptionState>>();

  canJoin(socket: Socket, room: string): boolean {
    if (socket.rooms.has(room)) return true;
    const resourceRoomCount = [...socket.rooms]
      .filter(existingRoom => RESOURCE_ROOM_PREFIXES.some(prefix => existingRoom.startsWith(prefix)))
      .length;
    const pendingCount = [...(this.pending.get(socket)?.entries() ?? [])]
      .filter(([pendingRoom]) => !socket.rooms.has(pendingRoom))
      .reduce((count, [, state]) => count + state.pendingCount, 0);
    return resourceRoomCount + Math.max(pendingCount, 1) <= MAX_RESOURCE_ROOMS_PER_SOCKET;
  }

  begin(socket: Socket, room: string): symbol {
    let subscriptions = this.pending.get(socket);
    if (!subscriptions) {
      subscriptions = new Map();
      this.pending.set(socket, subscriptions);
    }
    let state = subscriptions.get(room);
    if (!state) {
      state = { generation: Symbol(), pendingCount: 0 };
      subscriptions.set(room, state);
    }
    // The newest request owns the room. Older delayed authorization/join work
    // must observe a stale generation and unwind.
    state.generation = Symbol();
    state.pendingCount += 1;
    return state.generation;
  }

  cancel(socket: Socket, room: string): void {
    const state = this.pending.get(socket)?.get(room);
    if (state) state.generation = Symbol();
  }

  current(socket: Socket, room: string, generation: symbol): boolean {
    return this.pending.get(socket)?.get(room)?.generation === generation;
  }

  finish(socket: Socket, room: string): void {
    const subscriptions = this.pending.get(socket);
    const state = subscriptions?.get(room);
    if (!subscriptions || !state) return;
    state.pendingCount -= 1;
    if (state.pendingCount > 0) return;
    subscriptions.delete(room);
    if (subscriptions.size === 0) this.pending.delete(socket);
  }
}

/** Serializes same-room joins so delayed authorization cannot revive an older request. */
export class SocketJoinSerializer {
  private readonly locks = new WeakMap<Socket, Map<string, Promise<void>>>();

  async run<T>(socket: Socket, room: string, operation: () => Promise<T>): Promise<T> {
    let socketLocks = this.locks.get(socket);
    if (!socketLocks) {
      socketLocks = new Map();
      this.locks.set(socket, socketLocks);
    }
    const previous = socketLocks.get(room) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.catch(() => undefined).then(() => gate);
    socketLocks.set(room, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (socketLocks.get(room) === tail) socketLocks.delete(room);
      if (socketLocks.size === 0) this.locks.delete(socket);
    }
  }

  clear(socket: Socket): void {
    this.locks.delete(socket);
  }
}
