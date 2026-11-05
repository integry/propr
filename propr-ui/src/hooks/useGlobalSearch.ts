// CI trigger: 2026-02-18
import { useState, useEffect, useCallback, useRef, useSyncExternalStore } from 'react';
import { getTasks, getInstanceCatalog, MonitoredRepo } from '../api/proprApi';
import { getDrafts, DraftListItem } from '../api/plannerApi';
import { getDesktopConnectionScope, getDesktopSocketConfigurationKey, subscribeDesktopConnectionScope } from '../api/apiClient';
import { isDesktopRuntime } from '../config/runtimeMode';

// Debounce delay in milliseconds
const DEBOUNCE_DELAY = 300;
// Search result limits per category
const RESULTS_LIMIT = 5;

export interface TaskSearchResult {
  id: string;
  title?: string;
  repository?: string;
  status: string;
  createdAt: string;
  // Preview-pane details; the task list API supplies them, older payloads may not.
  subtitle?: string | null;
  prNumber?: number | null;
  issueNumber?: number | null;
  model?: string | null;
  modelName?: string | null;
  score?: number | null;
  failedReason?: string | null;
}

export interface GlobalSearchResults {
  plans: DraftListItem[];
  tasks: TaskSearchResult[];
  repositories: MonitoredRepo[];
}

// Consumers use result identity to reset their selection. Keep the hidden
// results stable while a desktop binding is unavailable or changing.
const EMPTY_SEARCH_RESULTS: GlobalSearchResults = { plans: [], tasks: [], repositories: [] };

export interface GlobalSearchState {
  query: string;
  results: GlobalSearchResults;
  isLoading: boolean;
  isOpen: boolean;
  error: string | null;
}

export interface UseGlobalSearchReturn extends GlobalSearchState {
  setQuery: (query: string) => void;
  clearSearch: () => void;
  setIsOpen: (isOpen: boolean) => void;
  hasResults: boolean;
}

export function useGlobalSearch(): UseGlobalSearchReturn {
  const configurationKey = useSyncExternalStore(
    subscribeDesktopConnectionScope, getDesktopSocketConfigurationKey, getDesktopSocketConfigurationKey,
  );
  const [stateConfigurationKey, setStateConfigurationKey] = useState(configurationKey);
  const canLoad = !isDesktopRuntime() || getDesktopConnectionScope() !== null;
  const [query, setQueryState] = useState('');
  const [results, setResults] = useState<GlobalSearchResults>({
    plans: [],
    tasks: [],
    repositories: [],
  });
  const [isLoading, setIsLoading] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Cache for repositories (they don't change often)
  const repositoriesCache = useRef<MonitoredRepo[]>([]);
  const repositoriesReadyRef = useRef<Promise<void>>(Promise.resolve());
  const repositoriesErrorRef = useRef<unknown>(null);

  // Debounce timer ref
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);

  // API helpers do not currently accept an AbortSignal, so a generation fence
  // prevents late results from a previous query replacing the active query.
  const requestGenerationRef = useRef(0);

  // Reload the cache for each active binding; logout can leave this hook mounted.
  useEffect(() => {
    let active = true;
    const requestScope = getDesktopConnectionScope();
    setStateConfigurationKey(configurationKey);
    const isCurrent = () => active && configurationKey === getDesktopSocketConfigurationKey()
      && (!isDesktopRuntime() || requestScope === getDesktopConnectionScope());
    requestGenerationRef.current += 1;
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    repositoriesCache.current = [];
    repositoriesReadyRef.current = Promise.resolve();
    setQueryState('');
    setResults({ plans: [], tasks: [], repositories: [] });
    setError(null);
    setIsLoading(false);
    setIsOpen(false);
    repositoriesErrorRef.current = null;
    if (!canLoad || (isDesktopRuntime() && !requestScope)) return;
    repositoriesReadyRef.current = getInstanceCatalog()
      .then(catalog => {
        if (!isCurrent()) return;
        repositoriesCache.current = catalog.repositories.map(repository => ({
          ...repository,
          id: `${repository.name}:${repository.baseBranch || ''}`
        }));
      })
      .catch(err => {
        if (!isCurrent()) return;
        repositoriesErrorRef.current = err;
        console.error('Failed to fetch repositories:', err);
      });
    return () => {
      active = false;
    };
  }, [configurationKey, canLoad]);

  // Perform search
  const performSearch = useCallback(async (searchQuery: string, generation: number) => {
    const requestScope = getDesktopConnectionScope();
    const isCurrent = () => generation === requestGenerationRef.current
      && configurationKey === getDesktopSocketConfigurationKey()
      && (!isDesktopRuntime() || (getDesktopConnectionScope() !== null && requestScope === getDesktopConnectionScope()));
    if (!isCurrent()) return;
    if (!searchQuery.trim()) {
      if (isCurrent()) setIsLoading(false);
      return;
    }

    try {
      const normalizedQuery = searchQuery.toLowerCase().trim();

      // Perform parallel API calls for plans and tasks
      const [plansResponse, tasksResponse] = await Promise.all([
        getDrafts({ search: searchQuery, limit: RESULTS_LIMIT }),
        getTasks({ search: searchQuery, limit: RESULTS_LIMIT }),
        repositoriesReadyRef.current,
      ]);
      if (repositoriesErrorRef.current) throw repositoriesErrorRef.current;

      // Filter repositories locally from cache
      const filteredRepositories = repositoriesCache.current
        .filter((repo) => {
          const searchIn = `${repo.name} ${repo.alias || ''}`.toLowerCase();
          return searchIn.includes(normalizedQuery);
        })
        .slice(0, RESULTS_LIMIT);

      // Extract tasks from response
      const tasksData = (tasksResponse as { tasks: TaskSearchResult[] }).tasks || [];

      if (!isCurrent()) return;
      setResults({
        plans: plansResponse.drafts || [],
        tasks: tasksData,
        repositories: filteredRepositories,
      });
    } catch (err) {
      if (!isCurrent()) return;
      console.error('Search failed:', err);
      setError((err as Error).message);
      setResults({ plans: [], tasks: [], repositories: [] });
    } finally {
      if (isCurrent()) setIsLoading(false);
    }
  }, [configurationKey]);

  // Debounced query handler
  const setQuery = useCallback(
    (newQuery: string) => {
      if (isDesktopRuntime() && !getDesktopConnectionScope()) return;
      const generation = ++requestGenerationRef.current;
      setQueryState(newQuery);
      setResults({ plans: [], tasks: [], repositories: [] });
      setError(null);
      setIsLoading(Boolean(newQuery.trim()));

      // Open dropdown when user starts typing
      if (newQuery.trim()) {
        setIsOpen(true);
      }

      // Clear existing debounce timer
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }

      // Set new debounce timer
      debounceTimerRef.current = setTimeout(() => {
        void performSearch(newQuery, generation);
      }, DEBOUNCE_DELAY);
    },
    [performSearch]
  );

  // Clear search
  const clearSearch = useCallback(() => {
    setQueryState('');
    setResults({ plans: [], tasks: [], repositories: [] });
    setIsOpen(false);
    setError(null);
    setIsLoading(false);
    requestGenerationRef.current += 1;

    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
      requestGenerationRef.current += 1;
    };
  }, []);

  // Check if there are any results
  const visible = canLoad && stateConfigurationKey === configurationKey;
  const hasResults = visible && (
    results.plans.length > 0 ||
    results.tasks.length > 0 ||
    results.repositories.length > 0);

  return {
    query: visible ? query : '',
    results: visible ? results : EMPTY_SEARCH_RESULTS,
    isLoading: visible && isLoading,
    isOpen: visible && isOpen,
    error: visible ? error : null,
    setQuery,
    clearSearch,
    setIsOpen,
    hasResults,
  };
}
