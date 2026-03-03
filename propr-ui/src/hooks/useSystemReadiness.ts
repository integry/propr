import { useState, useEffect, useCallback, useRef } from 'react';
import { getAgents, getRepoConfig, AgentConfig, MonitoredRepo } from '../api/proprApi';

/**
 * System readiness state for onboarding guidance
 * Tracks whether the user has completed initial setup (adding an AI agent and monitoring a repository)
 */
export interface SystemReadinessState {
  /** Whether at least one enabled agent is configured */
  hasAgents: boolean;
  /** Whether at least one repository is configured for monitoring */
  hasRepos: boolean;
  /** Whether data is currently being loaded */
  isLoading: boolean;
  /** Error message if fetching failed, null otherwise */
  error: string | null;
}

export function useSystemReadiness(): SystemReadinessState {
  const [hasAgents, setHasAgents] = useState<boolean>(false);
  const [hasRepos, setHasRepos] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // Track if component is mounted to prevent state updates after unmount
  const isMountedRef = useRef(true);

  // Fetch system readiness data
  const fetchReadiness = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);

      // Fetch agents and repos configuration in parallel
      const [agentsResponse, repoConfigResponse] = await Promise.all([
        getAgents(),
        getRepoConfig(),
      ]);

      if (!isMountedRef.current) return;

      // Check if at least one enabled agent exists
      const agents: AgentConfig[] = agentsResponse.agents || [];
      const enabledAgents = agents.filter((agent) => agent.enabled);
      setHasAgents(enabledAgents.length > 0);

      // Check if at least one repository is configured
      const repos: MonitoredRepo[] = repoConfigResponse.repos_to_monitor || [];
      setHasRepos(repos.length > 0);
    } catch (err) {
      if (!isMountedRef.current) return;
      console.error('Failed to fetch system readiness:', err);
      setError((err as Error).message);
    } finally {
      if (isMountedRef.current) {
        setIsLoading(false);
      }
    }
  }, []);

  // Initial load on mount
  useEffect(() => {
    isMountedRef.current = true;

    fetchReadiness();

    return () => {
      isMountedRef.current = false;
    };
  }, [fetchReadiness]);

  return {
    hasAgents,
    hasRepos,
    isLoading,
    error,
  };
}
