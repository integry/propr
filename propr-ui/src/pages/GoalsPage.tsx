import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Filter, Search, Target, X } from 'lucide-react';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { getGoals, GOAL_STATES, type GoalListItem, type GoalState } from '../api/goalsApi';
import { useDemoMode } from '../contexts/DemoModeContext';
import { useSocket } from '../contexts/useSocket';
import { EmptyGoalsState, GoalsList, GoalsPagination } from './GoalsPageComponents';
import { DEFAULT_GOALS_PAGE_SIZE, GOAL_STATE_OPTIONS } from './goalsPageUtils';

const GoalsPage: React.FC = () => {
  useDocumentTitle('Goals');
  const navigate = useNavigate();
  const { isDemoMode } = useDemoMode();
  const { isConnected, onTaskUpdate } = useSocket();
  const [searchParams, setSearchParams] = useSearchParams();
  const isInitialMount = useRef(true);

  const requestedState = searchParams.get('state');
  const stateFilter: GoalState | 'all' = requestedState && GOAL_STATES.includes(requestedState as GoalState)
    ? requestedState as GoalState
    : 'all';
  const repoFilter = searchParams.get('repository') || '';
  const urlSearch = searchParams.get('search') || '';
  const currentPage = Math.max(1, parseInt(searchParams.get('page') || '1', 10));

  const [searchQuery, setSearchQuery] = useState(urlSearch);
  const [debouncedSearch, setDebouncedSearch] = useState(urlSearch);

  const [goals, setGoals] = useState<GoalListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [totalGoals, setTotalGoals] = useState(0);
  const [hasMore, setHasMore] = useState(false);

  const totalPages = useMemo(
    () => Math.ceil(totalGoals / DEFAULT_GOALS_PAGE_SIZE),
    [totalGoals]
  );

  const loadGoals = useCallback(
    async (page: number, state: GoalState | 'all', repository: string, showLoading = true) => {
      if (showLoading) setLoading(true);
      setError(null);
      try {
        const data = await getGoals({
          page,
          limit: DEFAULT_GOALS_PAGE_SIZE,
          state: state === 'all' ? undefined : state,
          repository: repository || undefined,
          search: debouncedSearch || undefined,
        });
        setGoals(data.goals);
        setTotalGoals(data.total);
        setHasMore(data.hasMore);
      } catch (err) {
        if (showLoading) {
          setError((err as Error).message || 'Failed to load goals');
        } else {
          console.error('Goals silent refresh failed:', err);
        }
      } finally {
        if (showLoading) setLoading(false);
      }
    },
    [debouncedSearch]
  );

  // Sync URL search on initial mount
  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      setSearchQuery(urlSearch);
      setDebouncedSearch(urlSearch);
    }
  }, [urlSearch]);

  // Debounce search → URL
  useEffect(() => {
    const timer = setTimeout(() => {
      if (searchQuery !== debouncedSearch) {
        setDebouncedSearch(searchQuery);
        setSearchParams(
          prev => {
            const next = new URLSearchParams(prev);
            if (searchQuery) next.set('search', searchQuery);
            else next.delete('search');
            next.set('page', '1');
            return next;
          },
          { replace: true }
        );
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery, debouncedSearch, setSearchParams]);

  useEffect(() => {
    loadGoals(currentPage, stateFilter, repoFilter);
  }, [currentPage, stateFilter, repoFilter, debouncedSearch, loadGoals]);

  useEffect(() => {
    if (!isConnected) return;
    return onTaskUpdate(() => {
      void loadGoals(currentPage, stateFilter, repoFilter, false);
    });
  }, [currentPage, isConnected, loadGoals, onTaskUpdate, repoFilter, stateFilter]);

  const updateSearchParams = useCallback(
    (updates: Record<string, string | null>) => {
      setSearchParams(
        prev => {
          const next = new URLSearchParams(prev);
          Object.entries(updates).forEach(([key, value]) => {
            if (value === null || value === 'all' || value === '') next.delete(key);
            else next.set(key, value);
          });
          return next;
        },
        { replace: true }
      );
    },
    [setSearchParams]
  );

  const handleStateFilterChange = (value: string) =>
    updateSearchParams({ state: value, page: '1' });

  const handleSearchClear = () => {
    setSearchQuery('');
    setDebouncedSearch('');
    updateSearchParams({ search: null, page: '1' });
  };

  const handleNewGoal = useCallback(() => {
    if (!isDemoMode) navigate('/goals/new');
  }, [isDemoMode, navigate]);

  const handlePageChange = (page: number) =>
    updateSearchParams({ page: String(page) });

  // ── Loading skeleton ──────────────────────────────────────────────────────
  if (loading && goals.length === 0) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex-shrink-0 bg-slate-50 border-b border-gray-200 px-4 sm:px-6 py-2 sm:py-4">
          <h1 className="text-xl sm:text-2xl font-bold text-gray-800">Goals</h1>
        </div>
        <div className="flex-1 overflow-auto px-4 sm:px-6 py-4">
          <div role="status" className="text-gray-500 text-sm">Loading goals…</div>
        </div>
      </div>
    );
  }

  // ── Error state ────────────────────────────────────────────────────────────
  if (error && goals.length === 0) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex-shrink-0 bg-slate-50 border-b border-gray-200 px-4 sm:px-6 py-2 sm:py-4">
          <h1 className="text-xl sm:text-2xl font-bold text-gray-800">Goals</h1>
        </div>
        <div className="flex-1 overflow-auto px-4 sm:px-6 py-4">
          <div role="alert" className="p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
            {error}
          </div>
        </div>
      </div>
    );
  }

  const renderContent = () => {
    if (goals.length === 0 && !loading && totalGoals === 0 && !debouncedSearch && stateFilter === 'all') {
      return (
        <EmptyGoalsState
          type="no-goals"
          onCreateGoal={handleNewGoal}
          createDisabled={isDemoMode}
        />
      );
    }
    if (goals.length === 0 && !loading && debouncedSearch) {
      return (
        <EmptyGoalsState
          type="no-search-results"
          searchQuery={debouncedSearch}
          onCreateGoal={handleNewGoal}
          onClearSearch={handleSearchClear}
        />
      );
    }
    if (goals.length === 0 && !loading) {
      return (
        <EmptyGoalsState
          type="no-filter-results"
          onCreateGoal={handleNewGoal}
          onClearFilter={() => updateSearchParams({ state: 'all', repository: null, page: '1' })}
        />
      );
    }
    return <GoalsList goals={goals} />;
  };

  return (
    <div className="flex flex-col h-full">
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="flex-shrink-0 bg-slate-50 border-b border-gray-200 px-4 sm:px-6 py-2 sm:py-4">
        <div className="flex items-center justify-between gap-2 sm:gap-4">
          <h1 className="text-lg sm:text-2xl font-bold text-gray-800 flex-shrink-0">Goals</h1>
          <div className="flex items-center gap-2 sm:gap-4 flex-1 min-w-0 justify-end">
            {/* Desktop search */}
            <div className="relative hidden sm:block">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                type="search"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="Search goals…"
                aria-label="Search goals"
                className="pl-9 pr-8 py-2 w-64 border border-gray-300 rounded-md text-sm bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-teal-500"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={handleSearchClear}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                  aria-label="Clear search"
                >
                  <X size={16} />
                </button>
              )}
            </div>

            {/* Filters */}
            <div className="flex items-center gap-2 min-w-0">
              <Filter size={16} className="text-gray-500 hidden sm:block" aria-hidden="true" />
              <select
                value={stateFilter}
                onChange={e => handleStateFilterChange(e.target.value)}
                aria-label="Filter by state"
                className="px-2 sm:px-3 py-1.5 sm:py-2 border border-gray-300 rounded-md text-sm bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-teal-500"
              >
                {GOAL_STATE_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>

            {/* New Goal button */}
            <button
              type="button"
              onClick={handleNewGoal}
              disabled={isDemoMode}
              title={isDemoMode ? 'Goal creation is disabled in demo mode' : 'Create a new goal'}
              className="inline-flex items-center gap-1.5 px-3 sm:px-4 py-1.5 sm:py-2 bg-teal-600 text-white text-sm font-medium rounded-md hover:bg-teal-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex-shrink-0"
            >
              <Target className="w-4 h-4" />
              <span className="hidden sm:inline">New Goal</span>
            </button>
          </div>
        </div>
      </div>

      {/* ── Content ──────────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden px-4 sm:px-6 w-full">
        <div className="py-4">{renderContent()}</div>
      </div>

      {/* ── Pagination ────────────────────────────────────────────────────── */}
      {goals.length > 0 && totalPages > 1 && (
        <div className="flex-shrink-0 bg-slate-50 border-t border-gray-200">
          <GoalsPagination
            currentPage={currentPage}
            totalPages={totalPages}
            totalGoals={totalGoals}
            pageSize={DEFAULT_GOALS_PAGE_SIZE}
            hasMore={hasMore}
            loading={loading}
            onPageChange={handlePageChange}
          />
        </div>
      )}
    </div>
  );
};

export default GoalsPage;
