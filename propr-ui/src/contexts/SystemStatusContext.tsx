/* eslint-disable react-refresh/only-export-components */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useLocation } from 'react-router-dom';
import { getSystemStatus, INSTANCE_AUTHORIZATION_CHANGED_EVENT } from '../api/proprApi';
import type { SystemStatus } from '../api/proprTypes';
import {
  getDesktopSocketConfigurationKey,
  subscribeDesktopConnectionScope,
} from '../api/apiClient';
import { useCurrentUser } from './AuthContext';
import { useOptionalSocket } from './useSocket';

/** Fallback cadence, armed only while the websocket is unavailable. */
const DISCONNECTED_FALLBACK_INTERVAL_MS = 30_000;

interface SharedSystemStatus {
  status?: SystemStatus;
  isLoading: boolean;
  error: Error | null;
  /** Reuse the current scoped value, fetching only when this scope has none. */
  getStatus: () => Promise<SystemStatus>;
  /** Always request fresh data, while still sharing an identical pending read. */
  refreshStatus: () => Promise<SystemStatus>;
}

const directStatus: SharedSystemStatus = {
  isLoading: false,
  error: null,
  getStatus: () => getSystemStatus(),
  refreshStatus: () => getSystemStatus(),
};

const SystemStatusContext = createContext<SharedSystemStatus>(directStatus);

interface ScopedStatusState {
  scopeKey: string;
  status?: SystemStatus;
  isLoading: boolean;
  error: Error | null;
}

export const SystemStatusProvider: React.FC<{
  children: React.ReactNode;
  disabled?: boolean;
}> = ({ children, disabled = false }) => {
  const user = useCurrentUser();
  const location = useLocation();
  const socket = useOptionalSocket();
  const isConnected = socket?.isConnected ?? false;
  const desktopConfigurationKey = useSyncExternalStore(
    subscribeDesktopConnectionScope,
    getDesktopSocketConfigurationKey,
    getDesktopSocketConfigurationKey,
  );
  const params = new URLSearchParams(location.search);
  const scopeKey = `${desktopConfigurationKey}\0${user?.id ?? 'anonymous'}\0${params.get('flow') ?? ''}\0${params.get('tunnel') ?? ''}`;
  const currentScopeRef = useRef(scopeKey);
  const previousConnectedRef = useRef<boolean | null>(null);
  currentScopeRef.current = scopeKey;
  const mountedRef = useRef(true);
  const [state, setState] = useState<ScopedStatusState>({
    scopeKey,
    isLoading: !disabled,
    error: null,
  });
  const stateRef = useRef(state);
  stateRef.current = state;

  const refreshStatus = useCallback(async (): Promise<SystemStatus> => {
    const requestScope = scopeKey;
    setState(current => current.scopeKey === requestScope
      ? { ...current, isLoading: true, error: null }
      : { scopeKey: requestScope, isLoading: true, error: null });
    try {
      const status = await getSystemStatus();
      if (mountedRef.current && currentScopeRef.current === requestScope) {
        setState({ scopeKey: requestScope, status, isLoading: false, error: null });
      }
      return status;
    } catch (error) {
      if (mountedRef.current && currentScopeRef.current === requestScope) {
        setState({
          scopeKey: requestScope,
          isLoading: false,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
      throw error;
    }
  }, [scopeKey]);

  const getStatus = useCallback((): Promise<SystemStatus> => {
    const current = stateRef.current;
    if (current.scopeKey === scopeKey && current.status) return Promise.resolve(current.status);
    return refreshStatus();
  }, [refreshStatus, scopeKey]);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    setState({ scopeKey, isLoading: !disabled, error: null });
    if (!disabled) void refreshStatus().catch(() => undefined);
  }, [disabled, refreshStatus, scopeKey]);

  useEffect(() => {
    if (disabled) return;
    const refreshWhenVisible = () => {
      if (document.visibilityState !== 'hidden') void refreshStatus().catch(() => undefined);
    };
    window.addEventListener('focus', refreshWhenVisible);
    return () => { window.removeEventListener('focus', refreshWhenVisible); };
  }, [disabled, refreshStatus]);

  useEffect(() => {
    // Reconnect reconciliation: health may have moved while the socket was
    // down. Exactly one read per transition; the scope effect above covers a
    // session that was connected when it mounted.
    const previous = previousConnectedRef.current;
    previousConnectedRef.current = isConnected;
    if (disabled || !isConnected || previous !== false) return;
    void refreshStatus().catch(() => undefined);
  }, [disabled, isConnected, refreshStatus]);

  useEffect(() => {
    if (disabled || !socket?.isConnected) return;
    // Instance health moves with the health snapshot itself, with indexing and
    // with capacity, not with individual runs, so those are the only pushed
    // changes worth a read here. A worker or the daemon stopping produces no run
    // activity, so the `health` domain is what keeps this from holding a stale
    // healthy snapshot while the socket stays connected.
    const refreshWhenVisible = () => {
      if (document.visibilityState !== 'hidden') void refreshStatus().catch(() => undefined);
    };
    const unsubscribeActivity = socket.onActivityUpdate(payload => {
      // Per-file indexing progress does not change what the health rows say,
      // so only a run starting, finishing or failing is worth a read.
      if (payload.change === 'progress') return;
      if (payload.domain === 'health'
        || payload.domain === 'indexing'
        || payload.domain === 'usage') refreshWhenVisible();
    });
    const unsubscribeUsage = socket.onUsageUpdate(refreshWhenVisible);
    return () => { unsubscribeActivity(); unsubscribeUsage(); };
  }, [disabled, refreshStatus, socket]);

  useEffect(() => {
    // Fallback polling only while the websocket is unavailable: the scope
    // effect above already reads once per connect, and a client with a socket
    // is told when this changes.
    if (disabled || isConnected) return;
    const interval = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') void refreshStatus().catch(() => undefined);
    }, DISCONNECTED_FALLBACK_INTERVAL_MS);
    return () => { window.clearInterval(interval); };
  }, [disabled, isConnected, refreshStatus]);

  useEffect(() => {
    if (disabled) return;
    const handleAuthorizationChange = () => {
      setState({ scopeKey, isLoading: true, error: null });
      void refreshStatus().catch(() => undefined);
    };
    window.addEventListener(INSTANCE_AUTHORIZATION_CHANGED_EVENT, handleAuthorizationChange);
    return () => window.removeEventListener(INSTANCE_AUTHORIZATION_CHANGED_EVENT, handleAuthorizationChange);
  }, [disabled, refreshStatus, scopeKey]);

  const activeState = state.scopeKey === scopeKey
    ? state
    : { scopeKey, isLoading: !disabled, error: null };
  const value = useMemo<SharedSystemStatus>(() => ({
    status: activeState.status,
    isLoading: activeState.isLoading,
    error: activeState.error,
    getStatus,
    refreshStatus,
  }), [activeState.error, activeState.isLoading, activeState.status, getStatus, refreshStatus]);

  return <SystemStatusContext.Provider value={value}>{children}</SystemStatusContext.Provider>;
};

export const useSharedSystemStatus = (): SharedSystemStatus => useContext(SystemStatusContext);
