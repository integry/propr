import { createContext } from 'react';
import { Socket } from 'socket.io-client';
import { TaskUpdatePayload, DraftUpdatePayload } from '@gitfix/shared';

export interface SocketContextValue {
  socket: Socket | null;
  isConnected: boolean;
  subscribeToTask: (taskId: string) => void;
  unsubscribeFromTask: (taskId: string) => void;
  subscribeToDraft: (draftId: string) => void;
  unsubscribeFromDraft: (draftId: string) => void;
  onTaskUpdate: (callback: (payload: TaskUpdatePayload) => void) => () => void;
  onDraftUpdate: (callback: (payload: DraftUpdatePayload) => void) => () => void;
}

export const SocketContext = createContext<SocketContextValue | null>(null);
