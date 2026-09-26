import { TASK_UPDATE } from '@propr/shared';
import type { DesktopTaskTransition } from '../../../apps/desktop/src/shared/contract';

/**
 * Shared renderer boundary for desktop consumers such as notifications and the tray.
 * It deliberately projects the existing authenticated SocketProvider event instead
 * of allowing desktop features to open their own transport or forward metadata.
 */
// The validation is intentionally exhaustive because this is the native IPC projection boundary.
// eslint-disable-next-line complexity
export const normalizeScopedDesktopTaskTransition = (payload: unknown): DesktopTaskTransition | null => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const event = payload as Record<string, unknown>;
  if (event.eventType !== TASK_UPDATE
    || typeof event.taskId !== 'string' || event.taskId.length < 1 || event.taskId.length > 512
    || typeof event.state !== 'string' || event.state.length < 1 || event.state.length > 64
    || typeof event.previousState !== 'string' || event.previousState.length < 1
    || event.previousState.length > 64
    || typeof event.timestamp !== 'string' || Number.isNaN(Date.parse(event.timestamp))) return null;
  if (event.repository !== undefined && (
    typeof event.repository !== 'string' || event.repository.length > 201
    || !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(event.repository)
  )) return null;
  if (event.issueNumber !== undefined && (
    typeof event.issueNumber !== 'number'
    || !Number.isSafeInteger(event.issueNumber) || event.issueNumber < 1
  )) return null;
  if (event.version !== undefined && (
    typeof event.version !== 'number'
    || !Number.isSafeInteger(event.version) || event.version < 0
  )) return null;
  return {
    taskId: event.taskId,
    state: event.state,
    previousState: event.previousState,
    timestamp: event.timestamp,
    ...(event.repository === undefined ? {} : { repository: event.repository }),
    ...(event.issueNumber === undefined ? {} : { issueNumber: event.issueNumber }),
    ...(event.version === undefined ? {} : { version: event.version }),
  };
};
