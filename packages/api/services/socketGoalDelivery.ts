import type { Socket } from 'socket.io';
import { GoalError } from '@propr/core';

/** One in-flight page; the cursor advances only after the client acknowledgement. */
export function emitGoalEvents(
  socket: Socket,
  payload: Record<string, unknown>,
  timeoutMs = 5_000
): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.timeout(timeoutMs).emit('goal:events', payload, (error: Error | null) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export function socketGoalErrorCode(error: unknown): 'CURSOR_EXPIRED' | 'RECONNECT_REQUIRED' {
  if (error instanceof GoalError && error.code === 'goal_cursor_expired') return 'CURSOR_EXPIRED';
  return 'RECONNECT_REQUIRED';
}
