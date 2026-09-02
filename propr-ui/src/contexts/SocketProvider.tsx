import React, { useEffect, useState, useCallback, useRef, useSyncExternalStore } from 'react';
import type { Socket } from '@propr/client';
import { DESKTOP_TRANSPORT_SCOPE_QUERY, TASK_UPDATE, DRAFT_UPDATE, INDEXING_UPDATE, QUEUE_STATS_UPDATE, TASK_LIVE_UPDATE, TaskUpdatePayload, DraftUpdatePayload, IndexingUpdatePayload, QueueStatsUpdatePayload, TaskLiveUpdatePayload } from '@propr/shared';
import { SocketContext, SocketContextValue } from './SocketContext';
import {
  getDesktopConnectionScope,
  getDesktopSocketConfigurationKey,
  handleDesktopAccessCode,
  proprClient,
  subscribeDesktopConnectionScope,
} from '../api/apiClient';
import { isDesktopRuntime } from '../config/runtimeMode';
import {
  reportPackagedAcceptanceRendererLifecycle,
  reportPackagedAcceptanceSocketConnectInvocation,
  reportPackagedAcceptanceSocketConstructed,
  reportPackagedAcceptanceSocketConstructionInvocation,
} from '../desktop/packagedAcceptanceRendererLifecycle';

interface SocketProviderProps {
  children: React.ReactNode;
  disabled?: boolean;
  disableReasons?: SocketProviderDisableReasons;
}

export interface SocketProviderDisableReasons {
  demoModeLoading: boolean;
  demoMode: boolean;
  currentUserLoading: boolean;
  currentUserAbsent: boolean;
}

const noDisableReasons: SocketProviderDisableReasons = {
  demoModeLoading: false,
  demoMode: false,
  currentUserLoading: false,
  currentUserAbsent: false,
};

export const SocketProvider: React.FC<SocketProviderProps> = ({
  children,
  disabled = false,
  disableReasons = noDisableReasons,
}) => {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const taskUpdateCallbacksRef = useRef<Set<(payload: TaskUpdatePayload) => void>>(new Set());
  const draftUpdateCallbacksRef = useRef<Set<(payload: DraftUpdatePayload) => void>>(new Set());
  const indexingUpdateCallbacksRef = useRef<Set<(payload: IndexingUpdatePayload) => void>>(new Set());
  const queueStatsUpdateCallbacksRef = useRef<Set<(payload: QueueStatsUpdatePayload) => void>>(new Set());
  const taskLiveUpdateCallbacksRef = useRef<Set<(payload: TaskLiveUpdatePayload) => void>>(new Set());
  const socketConfigurationKey = useSyncExternalStore(
    subscribeDesktopConnectionScope,
    getDesktopSocketConfigurationKey,
    getDesktopSocketConfigurationKey,
  );
  const {
    demoModeLoading,
    demoMode,
    currentUserLoading,
    currentUserAbsent,
  } = disableReasons;
  useEffect(() => {
    reportPackagedAcceptanceRendererLifecycle('socket-provider-mounted', {
      socketProviderMounted: true,
    });
  }, []);

  useEffect(() => {
    const disableReasonEvidence = {
      disabledByDemoModeLoading: demoModeLoading,
      disabledByDemoMode: demoMode,
      disabledByCurrentUserLoading: currentUserLoading,
      disabledByCurrentUserAbsent: currentUserAbsent,
    };
    if (disabled) {
      reportPackagedAcceptanceRendererLifecycle('socket-effect-disabled', {
        providerDisabled: true,
        desktopRuntime: Boolean(isDesktopRuntime()),
        ...disableReasonEvidence,
      });
      setSocket(null);
      setIsConnected(false);
      return;
    }

    const desktopScope = getDesktopConnectionScope();
    if (isDesktopRuntime() && !desktopScope) {
      reportPackagedAcceptanceRendererLifecycle('socket-effect-scope-unavailable', {
        providerDisabled: false,
        desktopRuntime: true,
        connectionScope: 'unavailable',
        ...disableReasonEvidence,
      });
      setSocket(null);
      setIsConnected(false);
      return;
    }
    setIsConnected(false);
    reportPackagedAcceptanceRendererLifecycle('socket-effect-ready', {
      providerDisabled: false,
      desktopRuntime: Boolean(isDesktopRuntime()),
      connectionScope: desktopScope ? 'available' : 'unavailable',
      ...disableReasonEvidence,
    });
    reportPackagedAcceptanceSocketConstructionInvocation();
    const newSocket = proprClient.connectSocket({
      transports: ['websocket'],
      autoConnect: false,
      path: '/socket.io/',
      forceNew: true,
      ...(desktopScope ? {
        // The renderer contributes only the opaque binding query. Browser
        // cookies and Socket.IO auth payloads are never desktop credentials;
        // Electron main adds the active bearer to the exact WS upgrade.
        withCredentials: false,
        query: { [DESKTOP_TRANSPORT_SCOPE_QUERY]: desktopScope.transportScope },
      } : {}),
    });
    reportPackagedAcceptanceSocketConstructed();
    let disposed = false;
    const isCurrentScope = (): boolean => {
      if (disposed) return false;
      const current = getDesktopConnectionScope();
      return current?.profileId === desktopScope?.profileId
        && current?.transportScope === desktopScope?.transportScope;
    };
    const handleAuthenticationCode = (code: string | undefined, reconnect = false): void => {
      if (!isCurrentScope()) return;
      void handleDesktopAccessCode(code, desktopScope).then(classification => {
        if (!isCurrentScope()) return;
        if (classification === 'authorization-changed' && reconnect) {
          newSocket.disconnect();
          if (!isCurrentScope()) return;
          newSocket.connect();
        }
      });
    };

    const connected = () => {
      if (!isCurrentScope()) return;
      console.log('[SocketContext] Connected to WebSocket server');
      setIsConnected(true);
    };

    const disconnected = (reason: string) => {
      if (!isCurrentScope()) return;
      console.log('[SocketContext] Disconnected from WebSocket server:', reason);
      setIsConnected(false);
    };

    const connectionError = (error: Error) => {
      if (!isCurrentScope()) return;
      setIsConnected(false);
      console.error('[SocketContext] Connection error:', error.message);
      const code = (error as Error & { data?: { code?: string } }).data?.code;
      handleAuthenticationCode(code);
    };

    const authenticationError = (value: { code?: string } | undefined) => {
      handleAuthenticationCode(value?.code, true);
    };

    newSocket.on('connect', connected);
    newSocket.on('disconnect', disconnected);
    newSocket.on('connect_error', connectionError);
    newSocket.on('authentication:error', authenticationError);

    const taskUpdated = (payload: TaskUpdatePayload) => {
      if (!isCurrentScope()) return;
      console.log('[SocketContext] Received task update:', payload);
      taskUpdateCallbacksRef.current.forEach((callback) => callback(payload));
    };

    const draftUpdated = (payload: DraftUpdatePayload) => {
      if (!isCurrentScope()) return;
      console.log('[SocketContext] Received draft update:', payload);
      draftUpdateCallbacksRef.current.forEach((callback) => callback(payload));
    };

    const indexingUpdated = (payload: IndexingUpdatePayload) => {
      if (!isCurrentScope()) return;
      console.log('[SocketContext] Received indexing update:', payload);
      indexingUpdateCallbacksRef.current.forEach((callback) => callback(payload));
    };

    const queueStatsUpdated = (payload: QueueStatsUpdatePayload) => {
      if (!isCurrentScope()) return;
      console.log('[SocketContext] Received queue stats update:', payload);
      queueStatsUpdateCallbacksRef.current.forEach((callback) => callback(payload));
    };

    const taskLiveUpdated = (payload: TaskLiveUpdatePayload) => {
      if (!isCurrentScope()) return;
      console.log('[SocketContext] Received task live update:', payload);
      taskLiveUpdateCallbacksRef.current.forEach((callback) => callback(payload));
    };

    newSocket.on(TASK_UPDATE, taskUpdated);
    newSocket.on(DRAFT_UPDATE, draftUpdated);
    newSocket.on(INDEXING_UPDATE, indexingUpdated);
    newSocket.on(QUEUE_STATS_UPDATE, queueStatsUpdated);
    newSocket.on(TASK_LIVE_UPDATE, taskLiveUpdated);

    setSocket(newSocket);
    reportPackagedAcceptanceRendererLifecycle('socket-constructed', {
      providerDisabled: false,
      desktopRuntime: Boolean(isDesktopRuntime()),
      connectionScope: desktopScope ? 'available' : 'unavailable',
      ...disableReasonEvidence,
    });
    reportPackagedAcceptanceSocketConnectInvocation();
    newSocket.connect();

    return () => {
      console.log('[SocketContext] Cleaning up socket connection');
      setIsConnected(false);
      disposed = true;
      newSocket.off('connect', connected);
      newSocket.off('disconnect', disconnected);
      newSocket.off('connect_error', connectionError);
      newSocket.off('authentication:error', authenticationError);
      newSocket.off(TASK_UPDATE, taskUpdated);
      newSocket.off(DRAFT_UPDATE, draftUpdated);
      newSocket.off(INDEXING_UPDATE, indexingUpdated);
      newSocket.off(QUEUE_STATS_UPDATE, queueStatsUpdated);
      newSocket.off(TASK_LIVE_UPDATE, taskLiveUpdated);
      newSocket.disconnect();
    };
  }, [
    currentUserAbsent,
    currentUserLoading,
    demoMode,
    demoModeLoading,
    disabled,
    socketConfigurationKey,
  ]);

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
