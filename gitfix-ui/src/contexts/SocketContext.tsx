import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { TASK_UPDATE, DRAFT_UPDATE, TaskUpdatePayload, DraftUpdatePayload } from '@gitfix/shared';

interface SocketContextValue {
  socket: Socket | null;
  isConnected: boolean;
  subscribeToTask: (taskId: string) => void;
  unsubscribeFromTask: (taskId: string) => void;
  subscribeToDraft: (draftId: string) => void;
  unsubscribeFromDraft: (draftId: string) => void;
  onTaskUpdate: (callback: (payload: TaskUpdatePayload) => void) => () => void;
  onDraftUpdate: (callback: (payload: DraftUpdatePayload) => void) => () => void;
}

const SocketContext = createContext<SocketContextValue | null>(null);

interface SocketProviderProps {
  children: React.ReactNode;
}

export const SocketProvider: React.FC<SocketProviderProps> = ({ children }) => {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const taskUpdateCallbacksRef = useRef<Set<(payload: TaskUpdatePayload) => void>>(new Set());
  const draftUpdateCallbacksRef = useRef<Set<(payload: DraftUpdatePayload) => void>>(new Set());

  useEffect(() => {
    // Connect to the backend WebSocket server
    // The socket.io-client will automatically use the same origin as the page
    // unless we specify a different URL
    const socketUrl = import.meta.env.VITE_API_URL || window.location.origin;

    const newSocket = io(socketUrl, {
      transports: ['websocket', 'polling'],
      withCredentials: true,
      autoConnect: true,
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

  const value: SocketContextValue = {
    socket,
    isConnected,
    subscribeToTask,
    unsubscribeFromTask,
    subscribeToDraft,
    unsubscribeFromDraft,
    onTaskUpdate,
    onDraftUpdate,
  };

  return (
    <SocketContext.Provider value={value}>
      {children}
    </SocketContext.Provider>
  );
};

/**
 * Hook to access the socket context
 * Must be used within a SocketProvider
 */
export const useSocket = (): SocketContextValue => {
  const context = useContext(SocketContext);
  if (!context) {
    throw new Error('useSocket must be used within a SocketProvider');
  }
  return context;
};
