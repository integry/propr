import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { CurrentUser } from '../api/proprTypes';
import { getCurrentUser, INSTANCE_AUTHORIZATION_CHANGED_EVENT } from '../api/proprApi';
import {
  getDesktopConnectionScope,
  getDesktopSocketConfigurationKey,
  subscribeDesktopConnectionScope,
} from '../api/apiClient';
import { currentUiPathname, isDesktopRuntime } from '../config/runtimeMode';
import { reportPackagedAcceptanceCurrentUser } from '../desktop/packagedAcceptanceCurrentUserValidation';

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
  scopeGeneration: number;
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
  const scopeGenerationRef = useRef({ configurationKey: currentConfigurationKey, generation: 0 });
  if (scopeGenerationRef.current.configurationKey !== currentConfigurationKey) {
    scopeGenerationRef.current = {
      configurationKey: currentConfigurationKey,
      generation: scopeGenerationRef.current.generation + 1,
    };
  }
  currentConfigurationKeyRef.current = currentConfigurationKey;

  const [isInitialLoading, setIsInitialLoading] = useState(currentUiPathname() !== '/login');
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const [validatedConfigurationKey, setValidatedConfigurationKey] = useState<string | null>(null);
  const [validatedScopeGeneration, setValidatedScopeGeneration] = useState<number | null>(null);
  const [refreshingScope, setRefreshingScope] = useState<{
    configurationKey: string;
    scopeGeneration: number;
  } | null>(null);
  const refreshRequestRef = useRef<RefreshRequest | null>(null);

  const refreshCurrentUser = useCallback((): Promise<void> => {
    const configurationKey = currentConfigurationKeyRef.current;
    const scopeGeneration = scopeGenerationRef.current.generation;
    const activeScopePresent = desktopRuntime && getDesktopConnectionScope() !== null;
    const existing = refreshRequestRef.current;
    if (existing?.configurationKey === configurationKey && existing.scopeGeneration === scopeGeneration) {
      return existing.promise;
    }

    setRefreshingScope({ configurationKey, scopeGeneration });
    if (activeScopePresent) {
      reportPackagedAcceptanceCurrentUser({
        phase: 'request-issued', scopeGeneration, activeScopePresent,
        responseStatus: 0, classification: 'pending', schemaAccepted: false,
      });
    }
    const request = Promise.resolve()
      .then(() => getCurrentUser({ scopeGeneration, activeScopePresent }))
      .then(user => {
        if (currentConfigurationKeyRef.current !== configurationKey
          || scopeGenerationRef.current.generation !== scopeGeneration) {
          if (activeScopePresent) {
            reportPackagedAcceptanceCurrentUser({
              phase: 'stale-scope-rejected', scopeGeneration, activeScopePresent,
              responseStatus: 200, classification: 'success', schemaAccepted: true,
            });
          }
          return;
        }
        setCurrentUser(user);
        setValidatedConfigurationKey(configurationKey);
        setValidatedScopeGeneration(scopeGeneration);
        if (activeScopePresent) {
          reportPackagedAcceptanceCurrentUser({
            phase: 'active-scope-accepted', scopeGeneration, activeScopePresent,
            responseStatus: 200, classification: 'success', schemaAccepted: true,
          });
        }
      })
      .catch(error => {
        const currentScope = currentConfigurationKeyRef.current === configurationKey
          && scopeGenerationRef.current.generation === scopeGeneration;
        if (currentScope) {
          setCurrentUser(null);
          setValidatedConfigurationKey(null);
          setValidatedScopeGeneration(null);
        }
        if (activeScopePresent) {
          reportPackagedAcceptanceCurrentUser({
            phase: currentScope
              ? (getDesktopConnectionScope() === null ? 'revoked-scope-rejected' : 'active-scope-rejected')
              : 'stale-scope-rejected',
            scopeGeneration,
            activeScopePresent,
            responseStatus: 0,
            classification: getDesktopConnectionScope() === null ? 'revoked' : 'network-error',
            schemaAccepted: false,
          });
        }
        throw error;
      })
      .finally(() => {
        if (refreshRequestRef.current?.promise === request) refreshRequestRef.current = null;
        setRefreshingScope(current => current?.configurationKey === configurationKey
          && current.scopeGeneration === scopeGeneration ? null : current);
      });
    refreshRequestRef.current = { configurationKey, scopeGeneration, promise: request };
    return request;
  }, [desktopRuntime]);

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

  const currentScopeGeneration = scopeGenerationRef.current.generation;
  const validatedCurrentUser = validatedConfigurationKey === currentConfigurationKey
    && validatedScopeGeneration === currentScopeGeneration ? currentUser : null;
  const currentUserLoading = validatedCurrentUser === null
    && (isInitialLoading || (refreshingScope?.configurationKey === currentConfigurationKey
      && refreshingScope.scopeGeneration === currentScopeGeneration));

  return {
    currentUser: validatedCurrentUser,
    currentUserAbsent: validatedCurrentUser === null && !currentUserLoading,
    currentUserLoading,
    isInitialLoading,
    refreshCurrentUser,
  };
};
