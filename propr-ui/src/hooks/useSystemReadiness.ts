import { useState, useEffect, useSyncExternalStore } from 'react';
import { getInstanceCatalog, getReadinessTaskExistence } from '../api/proprApi';
import { getDesktopConnectionScope, getDesktopSocketConfigurationKey, subscribeDesktopConnectionScope } from '../api/apiClient';
import { isDesktopRuntime } from '../config/runtimeMode';

/**
 * System readiness state for onboarding guidance
 * Tracks whether the user has completed initial setup (adding an AI agent, monitoring a repository, and creating tasks)
 */
export interface SystemReadinessState {
  /** Whether at least one enabled agent is configured */
  hasAgents: boolean;
  /** Whether at least one enabled agent has a default model configured */
  hasDefaultModel: boolean;
  /** Whether at least one repository is configured for monitoring */
  hasRepos: boolean;
  /** Whether at least one task exists (GitHub issues with ProPR processing labels or created via Plans) */
  hasTasks: boolean;
  /** Whether data is currently being loaded */
  isLoading: boolean;
  /** Error message if fetching failed, null otherwise */
  error: string | null;
}

export function useSystemReadiness(): SystemReadinessState {
  const configurationKey = useSyncExternalStore(
    subscribeDesktopConnectionScope, getDesktopSocketConfigurationKey, getDesktopSocketConfigurationKey,
  );
  const [stateConfigurationKey, setStateConfigurationKey] = useState(configurationKey);
  const canLoad = !isDesktopRuntime() || getDesktopConnectionScope() !== null;
  const [hasAgents, setHasAgents] = useState<boolean>(false);
  const [hasDefaultModel, setHasDefaultModel] = useState<boolean>(false);
  const [hasRepos, setHasRepos] = useState<boolean>(false);
  const [hasTasks, setHasTasks] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // Each effect owns its continuations, including across StrictMode remounts.
  useEffect(() => {
    let active = true;
    const requestScope = getDesktopConnectionScope();
    setStateConfigurationKey(configurationKey);
    const isCurrent = () => active && configurationKey === getDesktopSocketConfigurationKey()
      && (!isDesktopRuntime() || requestScope === getDesktopConnectionScope());
    setHasAgents(false);
    setHasDefaultModel(false);
    setHasRepos(false);
    setHasTasks(false);
    setIsLoading(canLoad);
    setError(null);
    if (!canLoad || (isDesktopRuntime() && !requestScope)) return () => { active = false; };

    const load = async () => {
      try {
        // The catalog deliberately omits administrator-only configuration such as
        // credential paths, environment variables, and disabled repositories.
        const [catalog, tasksResponse] = await Promise.all([
          getInstanceCatalog(),
          getReadinessTaskExistence(),
        ]);

        if (!isCurrent()) return;

        // Check if at least one enabled agent exists
        const enabledAgents = catalog.agents;
        setHasAgents(enabledAgents.length > 0);

        // Check if at least one enabled agent has a default model configured
        setHasDefaultModel(enabledAgents.some((agent) => !!agent.defaultModel));

        // Check if at least one repository is configured
        setHasRepos(catalog.repositories.length > 0);

        // Check if at least one task exists
        const tasks = (tasksResponse as { total?: number }).total || 0;
        setHasTasks(tasks > 0);
      } catch (err) {
        if (!isCurrent()) return;
        console.error('Failed to fetch system readiness:', err);
        setError((err as Error).message);
      } finally {
        if (isCurrent()) {
          setIsLoading(false);
        }
      }
    };
    void load();
    return () => { active = false; };
  }, [configurationKey, canLoad]);

  const visible = canLoad && stateConfigurationKey === configurationKey;
  return {
    hasAgents: visible && hasAgents,
    hasDefaultModel: visible && hasDefaultModel,
    hasRepos: visible && hasRepos,
    hasTasks: visible && hasTasks,
    isLoading: canLoad && (!visible || isLoading),
    error: visible ? error : null,
  };
}
