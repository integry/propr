import React, { useEffect, useState, useCallback, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { TASK_UPDATE, DRAFT_UPDATE, INDEXING_UPDATE, QUEUE_STATS_UPDATE, TASK_LIVE_UPDATE, TaskUpdatePayload, DraftUpdatePayload, IndexingUpdatePayload, QueueStatsUpdatePayload, TaskLiveUpdatePayload } from '@propr/shared';
import { SocketContext, SocketContextValue } from './SocketContext';

interface SocketProviderProps {
  children: React.ReactNode;
}

export const SocketProvider: React.FC<SocketProviderProps> = ({ children }) => {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const taskUpdateCallbacksRef = useRef<Set<(payload: TaskUpdatePayload) => void>>(new Set());
  const draftUpdateCallbacksRef = useRef<Set<(payload: DraftUpdatePayload) => void>>(new Set());
  const indexingUpdateCallbacksRef = useRef<Set<(payload: IndexingUpdatePayload) => void>>(new Set());
  const queueStatsUpdateCallbacksRef = useRef<Set<(payload: QueueStatsUpdatePayload) => void>>(new Set());
  const taskLiveUpdateCallbacksRef = useRef<Set<(payload: TaskLiveUpdatePayload) => void>>(new Set());

  useEffect(() => {
    // Connect to the backend WebSocket server
    // Use the same API base URL as REST API calls
    // When empty or undefined, socket.io-client connects to the same origin
    const socketUrl = import.meta.env.VITE_API_BASE_URL || undefined;

    const newSocket = io(socketUrl, {
      transports: ['websocket', 'polling'],
      withCredentials: true,
      autoConnect: true,
      // Use path for socket.io which is the standard /socket.io/
      path: '/socket.io/',
    });

    newSocket.on('connect', () => {
      console.log('[SocketContext] Connected to WebSocket server');
      setIsConnected(true);
    });

    newSocket.on('disconnect', (reason) => {
      console.log('[SocketContext] Disconnected from WebSocket server:', reason);
      setIsConnected(false);
    });

    newSocket.on('connect_error', (error) => {
      console.error('[SocketContext] Connection error:', error.message);
    });

    // Set up global event listeners
    newSocket.on(TASK_UPDATE, (payload: TaskUpdatePayload) => {
      console.log('[SocketContext] Received task update:', payload);
      taskUpdateCallbacksRef.current.forEach((callback) => callback(payload));
    });

    newSocket.on(DRAFT_UPDATE, (payload: DraftUpdatePayload) => {
      console.log('[SocketContext] Received draft update:', payload);
      draftUpdateCallbacksRef.current.forEach((callback) => callback(payload));
    });

    newSocket.on(INDEXING_UPDATE, (payload: IndexingUpdatePayload) => {
      console.log('[SocketContext] Received indexing update:', payload);
      indexingUpdateCallbacksRef.current.forEach((callback) => callback(payload));
    });

    newSocket.on(QUEUE_STATS_UPDATE, (payload: QueueStatsUpdatePayload) => {
      console.log('[SocketContext] Received queue stats update:', payload);
      queueStatsUpdateCallbacksRef.current.forEach((callback) => callback(payload));
    });

    newSocket.on(TASK_LIVE_UPDATE, (payload: TaskLiveUpdatePayload) => {
      console.log('[SocketContext] Received task live update:', payload);
      taskLiveUpdateCallbacksRef.current.forEach((callback) => callback(payload));
    });

    setSocket(newSocket);

    return () => {
      console.log('[SocketContext] Cleaning up socket connection');
      newSocket.disconnect();
    };
  }, []);

  const subscribeToTask = useCallback((taskId: string) => {
    if (socket && isConnected) {
      socket.emit('subscribe:task', taskId);
      console.log(`[SocketContext] Subscribed to task: ${taskId}`);
    }
  }, [socket, isConnected]);

  const unsubscribeFromTask = useCallback((taskId: string) => {
    if (socket && isConnected) {
      socket.emit('unsubscribe:task', taskId);
      console.log(`[SocketContext] Unsubscribed from task: ${taskId}`);
    }
  }, [socket, isConnected]);

  const subscribeToDraft = useCallback((draftId: string) => {
    if (socket && isConnected) {
      socket.emit('subscribe:draft', draftId);
      console.log(`[SocketContext] Subscribed to draft: ${draftId}`);
    }
  }, [socket, isConnected]);

  const unsubscribeFromDraft = useCallback((draftId: string) => {
    if (socket && isConnected) {
      socket.emit('unsubscribe:draft', draftId);
      console.log(`[SocketContext] Unsubscribed from draft: ${draftId}`);
    }
  }, [socket, isConnected]);

  const subscribeToIndexing = useCallback((repository: string) => {
    if (socket && isConnected) {
      socket.emit('subscribe:indexing', repository);
      console.log(`[SocketContext] Subscribed to indexing: ${repository}`);
    }
  }, [socket, isConnected]);

  const unsubscribeFromIndexing = useCallback((repository: string) => {
    if (socket && isConnected) {
      socket.emit('unsubscribe:indexing', repository);
      console.log(`[SocketContext] Unsubscribed from indexing: ${repository}`);
    }
  }, [socket, isConnected]);

  const subscribeToIndexingUpdates = useCallback(() => {
    if (socket && isConnected) {
      socket.emit('subscribe:indexing:updates');
      console.log('[SocketContext] Subscribed to indexing:updates');
    }
  }, [socket, isConnected]);

  const unsubscribeFromIndexingUpdates = useCallback(() => {
    if (socket && isConnected) {
      socket.emit('unsubscribe:indexing:updates');
      console.log('[SocketContext] Unsubscribed from indexing:updates');
    }
  }, [socket, isConnected]);

  const subscribeToQueueStats = useCallback(() => {
    if (socket && isConnected) {
      socket.emit('subscribe:queue:stats');
      console.log('[SocketContext] Subscribed to queue:stats');
    }
  }, [socket, isConnected]);

  const unsubscribeFromQueueStats = useCallback(() => {
    if (socket && isConnected) {
      socket.emit('unsubscribe:queue:stats');
      console.log('[SocketContext] Unsubscribed from queue:stats');
    }
  }, [socket, isConnected]);

  const subscribeToTaskLive = useCallback((taskId: string) => {
    if (socket && isConnected) {
      socket.emit('subscribe:task:live', taskId);
      console.log(`[SocketContext] Subscribed to task:live:${taskId}`);
    }
  }, [socket, isConnected]);

  const unsubscribeFromTaskLive = useCallback((taskId: string) => {
    if (socket && isConnected) {
      socket.emit('unsubscribe:task:live', taskId);
      console.log(`[SocketContext] Unsubscribed from task:live:${taskId}`);
    }
  }, [socket, isConnected]);

  const onTaskUpdate = useCallback((callback: (payload: TaskUpdatePayload) => void) => {
    taskUpdateCallbacksRef.current.add(callback);
    return () => {
      taskUpdateCallbacksRef.current.delete(callback);
    };
  }, []);

  const onDraftUpdate = useCallback((callback: (payload: DraftUpdatePayload) => void) => {
    draftUpdateCallbacksRef.current.add(callback);
    return () => {
      draftUpdateCallbacksRef.current.delete(callback);
    };
  }, []);

  const onIndexingUpdate = useCallback((callback: (payload: IndexingUpdatePayload) => void) => {
    indexingUpdateCallbacksRef.current.add(callback);
    return () => {
      indexingUpdateCallbacksRef.current.delete(callback);
    };
  }, []);

  const onQueueStatsUpdate = useCallback((callback: (payload: QueueStatsUpdatePayload) => void) => {
    queueStatsUpdateCallbacksRef.current.add(callback);
    return () => {
      queueStatsUpdateCallbacksRef.current.delete(callback);
    };
  }, []);

  const onTaskLiveUpdate = useCallback((callback: (payload: TaskLiveUpdatePayload) => void) => {
    taskLiveUpdateCallbacksRef.current.add(callback);
    return () => {
      taskLiveUpdateCallbacksRef.current.delete(callback);
    };
  }, []);

  const value: SocketContextValue = {
    socket,
    isConnected,
    subscribeToTask,
    unsubscribeFromTask,
    subscribeToDraft,
    unsubscribeFromDraft,
    subscribeToIndexing,
    unsubscribeFromIndexing,
    subscribeToIndexingUpdates,
    unsubscribeFromIndexingUpdates,
    subscribeToQueueStats,
    unsubscribeFromQueueStats,
    subscribeToTaskLive,
    unsubscribeFromTaskLive,
    onTaskUpdate,
    onDraftUpdate,
    onIndexingUpdate,
    onQueueStatsUpdate,
    onTaskLiveUpdate,
  };

  return (
    <SocketContext.Provider value={value}>
      {children}
    </SocketContext.Provider>
  );
};
