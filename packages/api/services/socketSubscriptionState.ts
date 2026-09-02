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
  onJoined?: () => void | Promise<void>;
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
