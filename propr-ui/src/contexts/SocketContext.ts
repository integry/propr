import { createContext } from 'react';
import type { Socket } from '@propr/client';
import {
  TaskUpdatePayload,
  DraftUpdatePayload,
  IndexingUpdatePayload,
  QueueStatsUpdatePayload,
  TaskLiveUpdatePayload,
  ActivityUpdatePayload,
  GoalUpdatePayload,
} from '@propr/shared';

export interface SocketContextValue {
  socket: Socket | null;
  isConnected: boolean;
  subscribeToTask: (taskId: string) => void;
  unsubscribeFromTask: (taskId: string) => void;
  subscribeToDraft: (draftId: string) => void;
  unsubscribeFromDraft: (draftId: string) => void;
  subscribeToIndexing: (repository: string) => void;
  unsubscribeFromIndexing: (repository: string) => void;
  subscribeToIndexingUpdates: () => void;
  unsubscribeFromIndexingUpdates: () => void;
  subscribeToQueueStats: () => void;
  unsubscribeFromQueueStats: () => void;
  subscribeToTaskLive: (taskId: string) => void;
  unsubscribeFromTaskLive: (taskId: string) => void;
  /**
   * Instance-wide activity is opt-in and reference-counted in the provider:
   * many components subscribe, and only the last unsubscribe leaves the room.
   * A socket that only watches one task's output therefore does not receive
   * every frame on the instance.
   */
  subscribeToActivity: () => void;
  unsubscribeFromActivity: () => void;
  onTaskUpdate: (callback: (payload: TaskUpdatePayload) => void) => () => void;
  onDraftUpdate: (callback: (payload: DraftUpdatePayload) => void) => () => void;
  onIndexingUpdate: (callback: (payload: IndexingUpdatePayload) => void) => () => void;
  onQueueStatsUpdate: (callback: (payload: QueueStatsUpdatePayload) => void) => () => void;
  onTaskLiveUpdate: (callback: (payload: TaskLiveUpdatePayload) => void) => () => void;
  /** The general envelope: "domain X changed in way Y, in repository Z". */
  onActivityUpdate: (callback: (payload: ActivityUpdatePayload) => void) => () => void;
  /** A goal's own transition, which no task update reports. */
  onGoalUpdate: (callback: (payload: GoalUpdatePayload) => void) => () => void;
}

export const SocketContext = createContext<SocketContextValue | null>(null);
