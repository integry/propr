import React, { useEffect, useState, useCallback, useRef, useSyncExternalStore } from 'react';
import type { Socket } from '@propr/client';
import { DESKTOP_TRANSPORT_SCOPE_QUERY, TASK_UPDATE, DRAFT_UPDATE, INDEXING_UPDATE, QUEUE_STATS_UPDATE, TASK_LIVE_UPDATE, ACTIVITY_UPDATE, GOAL_UPDATE, isActivityUpdatePayload, TaskUpdatePayload, DraftUpdatePayload, IndexingUpdatePayload, QueueStatsUpdatePayload, TaskLiveUpdatePayload, ActivityUpdatePayload, GoalUpdatePayload } from '@propr/shared';
import { SocketContext, SocketContextValue } from './SocketContext';
import {
  getDesktopConnectionScope,
  getDesktopSocketConfigurationKey,
  getProprClient,
  handleDesktopAccessCode,
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

const refreshDesktopActiveWork = (): void => {
  void window.proprDesktop?.app.refreshActiveWork().catch(() => undefined);
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
  const activityUpdateCallbacksRef = useRef<Set<(payload: ActivityUpdatePayload) => void>>(new Set());
  const goalUpdateCallbacksRef = useRef<Set<(payload: GoalUpdatePayload) => void>>(new Set());
  /**
   * How many components currently want instance-wide activity. Socket.IO rooms
   * are not reference-counted, so without this the first consumer to unmount
   * would silently unsubscribe the others.
   */
  const activitySubscribersRef = useRef(0);
  /*
    The activity room's subscribe/unsubscribe pair must keep a stable identity:
    consumers call it from an effect, and a callback that changed whenever the
    socket state changed would make every consumer leave and rejoin the room on
    each connection flap. The current socket is therefore read through refs.
  */
  const socketRef = useRef<Socket | null>(null);
  const connectedRef = useRef(false);
  const socketConfigurationKey = useSyncExternalStore(
    subscribeDesktopConnectionScope,
    getDesktopSocketConfigurationKey,
    getDesktopSocketConfigurationKey,
  );
  const { demoModeLoading, demoMode, currentUserLoading, currentUserAbsent } = disableReasons;
  socketRef.current = socket;
  connectedRef.current = isConnected;

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
    const newSocket = getProprClient().connectSocket({
      transports: ['websocket'],
      autoConnect: true,
      path: '/socket.io/',
      forceNew: true,
      ...(desktopScope ? {
        auth: { [DESKTOP_TRANSPORT_SCOPE_QUERY]: desktopScope.transportScope },
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
      refreshDesktopActiveWork();
    };

    const disconnected = (reason: string) => {
      if (!isCurrentScope()) return;
      console.log('[SocketContext] Disconnected from WebSocket server:', reason);
      setIsConnected(false);
      refreshDesktopActiveWork();
    };

    const connectionError = (error: Error) => {
      if (!isCurrentScope()) return;
      setIsConnected(false);
      refreshDesktopActiveWork();
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

    // Set up global event listeners
    const taskUpdated = (payload: TaskUpdatePayload) => {
      if (!isCurrentScope()) return;
      console.log('[SocketContext] Received task update:', payload);
      taskUpdateCallbacksRef.current.forEach((callback) => callback(payload));
      refreshDesktopActiveWork();
    };

    const draftUpdated = (payload: DraftUpdatePayload) => {
      if (!isCurrentScope()) return;
      console.log('[SocketContext] Received draft update:', payload);
      draftUpdateCallbacksRef.current.forEach((callback) => callback(payload));
      refreshDesktopActiveWork();
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
      refreshDesktopActiveWork();
    };

    const taskLiveUpdated = (payload: TaskLiveUpdatePayload) => {
      if (!isCurrentScope()) return;
      // Live payloads can contain large command outputs. Logging the object
      // makes Chromium retain and inspect that data on its main thread for
      // every incremental event, competing with rendering and HTTP callbacks.
      console.log(`[SocketContext] Received task live update: ${payload.events.length} event(s)`);
      taskLiveUpdateCallbacksRef.current.forEach((callback) => callback(payload));
    };

    const activityUpdated = (payload: ActivityUpdatePayload) => {
      // A frame that does not carry the envelope cannot be filtered by domain or
      // change, so it is dropped rather than woken every consumer on the page.
      if (!isCurrentScope() || !isActivityUpdatePayload(payload)) return;
      // Activity frames are frequent, so only the envelope's shape is logged:
      // the identifiers are enough to explain a refresh in a console trace.
      console.log(`[SocketContext] Received activity update: ${payload.domain}/${payload.change}`);
      activityUpdateCallbacksRef.current.forEach((callback) => callback(payload));
    };

    const goalUpdated = (payload: GoalUpdatePayload) => {
      if (!isCurrentScope()) return;
      console.log(`[SocketContext] Received goal update: ${payload.goalId}`);
      goalUpdateCallbacksRef.current.forEach((callback) => callback(payload));
      refreshDesktopActiveWork();
    };

    newSocket.on(TASK_UPDATE, taskUpdated);
    newSocket.on(DRAFT_UPDATE, draftUpdated);
    newSocket.on(INDEXING_UPDATE, indexingUpdated);
    newSocket.on(QUEUE_STATS_UPDATE, queueStatsUpdated);
    newSocket.on(TASK_LIVE_UPDATE, taskLiveUpdated);
    newSocket.on(ACTIVITY_UPDATE, activityUpdated);
    newSocket.on(GOAL_UPDATE, goalUpdated);

    setSocket(newSocket);
    reportPackagedAcceptanceRendererLifecycle('socket-constructed', {
      providerDisabled: false,
      desktopRuntime: Boolean(isDesktopRuntime()),
      connectionScope: desktopScope ? 'available' : 'unavailable',
      ...disableReasonEvidence,
    });
    // connectSocket's current transport contract uses autoConnect. Record that
    // one invocation without changing its authentication/query semantics.
    reportPackagedAcceptanceSocketConnectInvocation();

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
      newSocket.off(ACTIVITY_UPDATE, activityUpdated);
      newSocket.off(GOAL_UPDATE, goalUpdated);
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

  const subscribeToActivity = useCallback(() => {
    // Emit only on the 0 -> 1 transition: a second subscriber must not send a
    // duplicate join, and the count is what lets the last leave be correct.
    activitySubscribersRef.current += 1;
    if (activitySubscribersRef.current === 1 && connectedRef.current) socketRef.current?.emit('subscribe:activity');
  }, []);

  const unsubscribeFromActivity = useCallback(() => {
    activitySubscribersRef.current = Math.max(0, activitySubscribersRef.current - 1);
    if (activitySubscribersRef.current === 0 && connectedRef.current) socketRef.current?.emit('unsubscribe:activity');
  }, []);

  useEffect(() => {
    // Room membership does not survive a reconnect, and a component can
    // subscribe before the socket is up. Either way the join is (re-)sent once
    // the connection exists, or the page would go permanently quiet and fall
    // back to polling forever.
    if (socket && isConnected && activitySubscribersRef.current > 0) socket.emit('subscribe:activity');
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

  const onActivityUpdate = useCallback((callback: (payload: ActivityUpdatePayload) => void) => {
    activityUpdateCallbacksRef.current.add(callback);
    return () => {
      activityUpdateCallbacksRef.current.delete(callback);
    };
  }, []);

  const onGoalUpdate = useCallback((callback: (payload: GoalUpdatePayload) => void) => {
    goalUpdateCallbacksRef.current.add(callback);
    return () => {
      goalUpdateCallbacksRef.current.delete(callback);
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
    subscribeToActivity,
    unsubscribeFromActivity,
    onTaskUpdate,
    onDraftUpdate,
    onIndexingUpdate,
    onQueueStatsUpdate,
    onTaskLiveUpdate,
    onActivityUpdate,
    onGoalUpdate,
  };

  return (
    <SocketContext.Provider value={value}>
      {children}
    </SocketContext.Provider>
  );
};
