import type { Socket } from 'socket.io';
import { GoalError, GoalRepository } from '@propr/core';
import { toPublicGoalEvent } from '../routes/goalRouteDtos.js';
import { revalidateSocketAuthentication } from './socketAuthentication.js';
import { emitGoalEvents, socketGoalErrorCode } from './socketGoalDelivery.js';
import { goalRoom } from './socketSubscriptionResources.js';
import type { QueueDependencies } from './socketService.js';

interface GoalTailDependencies {
  getQueueDependencies: () => QueueDependencies | null;
  goalAcknowledgementTimeoutMs?: number;
}

interface GoalTailPollInput {
  socket: Socket;
  goalId: string;
  cursor: string | null;
  backpressureTicks: number;
  ownsGoal: () => Promise<boolean>;
}

export class SocketGoalTailManager {
  private readonly tails = new WeakMap<Socket, Map<string, ReturnType<typeof setInterval>>>();

  constructor(private readonly dependencies: GoalTailDependencies) {}

  start(
    socket: Socket,
    goalId: string,
    initialCursor: string | null,
    ownsGoal: () => Promise<boolean>,
  ): void {
    this.stop(socket, goalId);
    let socketTails = this.tails.get(socket);
    if (!socketTails) {
      socketTails = new Map();
      this.tails.set(socket, socketTails);
    }
    let cursor = initialCursor;
    let running = false;
    let backpressureTicks = 0;
    const timer = setInterval(() => {
      if (running) return;
      running = true;
      void this.poll({ socket, goalId, cursor, backpressureTicks, ownsGoal })
        .then(result => {
          cursor = result.cursor;
          backpressureTicks = result.backpressureTicks;
        })
        .catch(async error => {
          console.error(`[SocketService] Goal tail failed for ${goalId}:`, error);
          this.stop(socket, goalId);
          await socket.leave(goalRoom(goalId));
          socket.emit('subscription:error', {
            event: 'subscribe:goal', code: socketGoalErrorCode(error),
          });
        })
        .finally(() => { running = false; });
    }, 500);
    timer.unref?.();
    socketTails.set(goalId, timer);
  }

  private async poll(input: GoalTailPollInput): Promise<{
    cursor: string | null;
    backpressureTicks: number;
  }> {
    const { socket, goalId, cursor, backpressureTicks, ownsGoal } = input;
    const room = goalRoom(goalId);
    if (!socket.connected || !socket.rooms.has(room)) {
      this.stop(socket, goalId);
      return { cursor, backpressureTicks };
    }
    if (!socket.conn.transport.writable) {
      const nextTicks = backpressureTicks + 1;
      if (nextTicks >= 10) {
        this.stop(socket, goalId);
        await socket.leave(room);
        socket.emit('subscription:error', { event: 'subscribe:goal', code: 'RECONNECT_REQUIRED' });
      }
      return { cursor, backpressureTicks: nextTicks };
    }
    if (!await revalidateSocketAuthentication(socket) || !await ownsGoal()) {
      throw new GoalError('goal_repository_forbidden', 'Goal delivery authorization changed', 403);
    }
    const database = this.dependencies.getQueueDependencies()?.db;
    if (!database) return { cursor, backpressureTicks: 0 };
    const page = await new GoalRepository(database).readEventPage(goalId, {
      cursor, limit: 100, maxBytes: 256 * 1024,
    });
    if (page.events.length === 0) return { cursor, backpressureTicks: 0 };
    if (!socket.connected || !socket.rooms.has(room) || !socket.conn.transport.writable
      || !await revalidateSocketAuthentication(socket) || !await ownsGoal()) {
      throw new GoalError('goal_repository_forbidden', 'Goal delivery authorization changed', 403);
    }
    await emitGoalEvents(socket, {
      schemaVersion: 1, goalId, events: page.events.map(toPublicGoalEvent),
      cursor: page.lastCursor, asOfSequence: page.asOfSequence,
    }, this.dependencies.goalAcknowledgementTimeoutMs);
    return { cursor: page.lastCursor, backpressureTicks: 0 };
  }

  stop(socket: Socket, goalId: string): void {
    const socketTails = this.tails.get(socket);
    const timer = socketTails?.get(goalId);
    if (timer) clearInterval(timer);
    socketTails?.delete(goalId);
    if (socketTails?.size === 0) this.tails.delete(socket);
  }

  clear(socket: Socket): void {
    const socketTails = this.tails.get(socket);
    if (socketTails) for (const timer of socketTails.values()) clearInterval(timer);
    this.tails.delete(socket);
  }
}
