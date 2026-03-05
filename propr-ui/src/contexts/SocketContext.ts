import { createContext } from 'react';
import { Socket } from 'socket.io-client';
import { TaskUpdatePayload, DraftUpdatePayload, IndexingUpdatePayload, QueueStatsUpdatePayload, TaskLiveUpdatePayload } from '@propr/shared';

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
  onTaskUpdate: (callback: (payload: TaskUpdatePayload) => void) => () => void;
  onDraftUpdate: (callback: (payload: DraftUpdatePayload) => void) => () => void;
  onIndexingUpdate: (callback: (payload: IndexingUpdatePayload) => void) => () => void;
  onQueueStatsUpdate: (callback: (payload: QueueStatsUpdatePayload) => void) => () => void;
  onTaskLiveUpdate: (callback: (payload: TaskLiveUpdatePayload) => void) => () => void;
}

export const SocketContext = createContext<SocketContextValue | null>(null);
