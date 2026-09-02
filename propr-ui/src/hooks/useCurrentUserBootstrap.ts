import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { CurrentUser } from '../api/proprTypes';
import { getCurrentUser, INSTANCE_AUTHORIZATION_CHANGED_EVENT } from '../api/proprApi';
import {
  getDesktopConnectionScope,
  getDesktopSocketConfigurationKey,
  subscribeDesktopConnectionScope,
} from '../api/apiClient';
import { currentUiPathname, isDesktopRuntime } from '../config/runtimeMode';

const AUTHORIZATION_REFRESH_INTERVAL_MS = 60_000;

interface CurrentUserBootstrapOptions {
  isDemoMode: boolean;
  isDemoModeLoading: boolean;
}

interface CurrentUserBootstrapResult {
  currentUser: CurrentUser | null;
  currentUserAbsent: boolean;
  currentUserLoading: boolean;
  isInitialLoading: boolean;
  refreshCurrentUser: () => Promise<void>;
}

interface RefreshRequest {
  configurationKey: string;
  promise: Promise<void>;
}

/**
 * Binds authenticated renderer state to the desktop scope that was actually
 * validated. Scope publication can supersede one pre-activation request, while
 * same-scope callers share exactly one validation request.
 */
export const useCurrentUserBootstrap = ({
  isDemoMode,
  isDemoModeLoading,
}: CurrentUserBootstrapOptions): CurrentUserBootstrapResult => {
  const desktopRuntime = isDesktopRuntime();
  const socketConfigurationKey = useSyncExternalStore(
    subscribeDesktopConnectionScope,
    getDesktopSocketConfigurationKey,
    getDesktopSocketConfigurationKey,
  );
  const currentConfigurationKey = desktopRuntime ? socketConfigurationKey : 'browser';
  const currentConfigurationKeyRef = useRef(currentConfigurationKey);
  currentConfigurationKeyRef.current = currentConfigurationKey;

  const [isInitialLoading, setIsInitialLoading] = useState(currentUiPathname() !== '/login');
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const [validatedConfigurationKey, setValidatedConfigurationKey] = useState<string | null>(null);
  const [refreshingConfigurationKey, setRefreshingConfigurationKey] = useState<string | null>(null);
  const refreshRequestRef = useRef<RefreshRequest | null>(null);

  const refreshCurrentUser = useCallback((): Promise<void> => {
    const configurationKey = currentConfigurationKeyRef.current;
    const existing = refreshRequestRef.current;
    if (existing?.configurationKey === configurationKey) return existing.promise;

    setRefreshingConfigurationKey(configurationKey);
    const request = Promise.resolve()
      .then(() => getCurrentUser())
      .then(user => {
        if (currentConfigurationKeyRef.current !== configurationKey) return;
        setCurrentUser(user);
        setValidatedConfigurationKey(configurationKey);
      })
      .catch(error => {
        if (currentConfigurationKeyRef.current === configurationKey) {
          setCurrentUser(null);
          setValidatedConfigurationKey(null);
        }
        throw error;
      })
      .finally(() => {
        if (refreshRequestRef.current?.promise === request) refreshRequestRef.current = null;
        setRefreshingConfigurationKey(current => current === configurationKey ? null : current);
      });
    refreshRequestRef.current = { configurationKey, promise: request };
    return request;
  }, []);

  useEffect(() => {
    if (isDemoModeLoading) return;

    const checkSession = async () => {
      if (currentUiPathname() === '/login') {
        setIsInitialLoading(false);
        return;
      }

      try {
        await refreshCurrentUser();
        setIsInitialLoading(false);
      } catch (error) {
        // Browser authentication redirects remain responsible for releasing
        // their own loading surface. Desktop authentication has no redirect.
        if (error instanceof Error && error.message !== 'Authentication required') {
          setIsInitialLoading(false);
        }
      }
    };

    void checkSession();
  }, [isDemoModeLoading, refreshCurrentUser]);

  useEffect(() => {
    if (!desktopRuntime || !getDesktopConnectionScope()) return;
    void refreshCurrentUser().catch(error => {
      console.error('Failed to validate the activated desktop connection:', error);
    });
  }, [currentConfigurationKey, desktopRuntime, refreshCurrentUser]);

  useEffect(() => {
    const handleAuthorizationChanged = () => {
      void refreshCurrentUser().catch(error => {
        console.error('Failed to refresh instance authorization:', error);
      });
    };
    window.addEventListener(INSTANCE_AUTHORIZATION_CHANGED_EVENT, handleAuthorizationChanged);
    return () => window.removeEventListener(INSTANCE_AUTHORIZATION_CHANGED_EVENT, handleAuthorizationChanged);
  }, [refreshCurrentUser]);

  useEffect(() => {
    if (isDemoMode || currentUiPathname() === '/login') return;
    const refreshAuthorization = () => {
      if (document.visibilityState === 'hidden') return;
      void refreshCurrentUser().catch(error => {
        console.error('Failed to synchronize instance authorization:', error);
      });
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') refreshAuthorization();
    };
    const interval = window.setInterval(refreshAuthorization, AUTHORIZATION_REFRESH_INTERVAL_MS);
    window.addEventListener('focus', refreshAuthorization);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', refreshAuthorization);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [isDemoMode, refreshCurrentUser]);

  const validatedCurrentUser = validatedConfigurationKey === currentConfigurationKey ? currentUser : null;
  const currentUserLoading = validatedCurrentUser === null
    && (isInitialLoading || refreshingConfigurationKey === currentConfigurationKey);

  return {
    currentUser: validatedCurrentUser,
    currentUserAbsent: validatedCurrentUser === null && !currentUserLoading,
    currentUserLoading,
    isInitialLoading,
    refreshCurrentUser,
  };
};
