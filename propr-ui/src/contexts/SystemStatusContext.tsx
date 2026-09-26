import { useLiveInvalidation } from '../hooks/useLiveInvalidation';
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

const STATUS_REFRESH_INTERVAL_MS = 30_000;

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
  const desktopConfigurationKey = useSyncExternalStore(
    subscribeDesktopConnectionScope,
    getDesktopSocketConfigurationKey,
    getDesktopSocketConfigurationKey,
  );
  const params = new URLSearchParams(location.search);
  const scopeKey = `${desktopConfigurationKey}\0${user?.id ?? 'anonymous'}\0${params.get('flow') ?? ''}\0${params.get('tunnel') ?? ''}`;
  const currentScopeRef = useRef(scopeKey);
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
  }, [disabled, refreshStatus, scopeKey]);

  const schedule = useLiveInvalidation({ refresh: refreshStatus, scopeKey, disabled,
    interest: { domains: ['system'], usage: true },
    fallbackPollMs: STATUS_REFRESH_INTERVAL_MS });

  useEffect(() => {
    if (disabled) return;
    const handleAuthorizationChange = () => {
      setState({ scopeKey, isLoading: true, error: null });
      schedule();
    };
    window.addEventListener(INSTANCE_AUTHORIZATION_CHANGED_EVENT, handleAuthorizationChange);
    return () => window.removeEventListener(INSTANCE_AUTHORIZATION_CHANGED_EVENT, handleAuthorizationChange);
  }, [disabled, schedule, scopeKey]);

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
