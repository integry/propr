// CI trigger: 2026-02-18
import { useState, useEffect, useCallback, useRef } from 'react';
import { getTasks, getRepoConfig, MonitoredRepo } from '../api/gitfixApi';
import { getDrafts, DraftListItem } from '../api/plannerApi';

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
}

export interface GlobalSearchResults {
  plans: DraftListItem[];
  tasks: TaskSearchResult[];
  repositories: MonitoredRepo[];
}

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

  // Debounce timer ref
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Abort controller for canceling previous requests
  const abortControllerRef = useRef<AbortController | null>(null);

  // Fetch all repositories once on mount
  useEffect(() => {
    const fetchRepositories = async () => {
      try {
        const config = await getRepoConfig();
        repositoriesCache.current = config.repos_to_monitor.filter(
          (repo) => repo.enabled
        );
      } catch (err) {
        console.error('Failed to fetch repositories:', err);
      }
    };
    fetchRepositories();
  }, []);

  // Perform search
  const performSearch = useCallback(async (searchQuery: string) => {
    if (!searchQuery.trim()) {
      setResults({ plans: [], tasks: [], repositories: [] });
      setIsLoading(false);
      return;
    }

    // Cancel any previous in-flight requests
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();

    setIsLoading(true);
    setError(null);

    try {
      const normalizedQuery = searchQuery.toLowerCase().trim();

      // Perform parallel API calls for plans and tasks
      const [plansResponse, tasksResponse] = await Promise.all([
        getDrafts({ search: searchQuery, limit: RESULTS_LIMIT }),
        getTasks({ search: searchQuery, limit: RESULTS_LIMIT }),
      ]);

      // Filter repositories locally from cache
      const filteredRepositories = repositoriesCache.current
        .filter((repo) => {
          const searchIn = `${repo.name} ${repo.alias || ''}`.toLowerCase();
          return searchIn.includes(normalizedQuery);
        })
        .slice(0, RESULTS_LIMIT);

      // Extract tasks from response
      const tasksData = (tasksResponse as { tasks: TaskSearchResult[] }).tasks || [];

      setResults({
        plans: plansResponse.drafts || [],
        tasks: tasksData,
        repositories: filteredRepositories,
      });
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        // Request was aborted, ignore
        return;
      }
      console.error('Search failed:', err);
      setError((err as Error).message);
      setResults({ plans: [], tasks: [], repositories: [] });
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Debounced query handler
  const setQuery = useCallback(
    (newQuery: string) => {
      setQueryState(newQuery);

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
        performSearch(newQuery);
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

    // Cancel any pending requests
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
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
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  // Check if there are any results
  const hasResults =
    results.plans.length > 0 ||
    results.tasks.length > 0 ||
    results.repositories.length > 0;

  return {
    query,
    results,
    isLoading,
    isOpen,
    error,
    setQuery,
    clearSearch,
    setIsOpen,
    hasResults,
  };
}
