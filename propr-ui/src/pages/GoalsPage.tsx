import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Filter, Search, Target, X } from 'lucide-react';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useDemoMode } from '../contexts/DemoModeContext';
import { EmptyGoalsState, GoalsList, GoalsPagination } from './GoalsPageComponents';
import { GOAL_STATE_OPTIONS } from './goalsPageUtils';
import { useGoalsList } from './useGoalsList';

const GoalsPage = () => {
  useDocumentTitle('Goals');
  const navigate = useNavigate();
  const { isDemoMode } = useDemoMode();
  const list = useGoalsList();

  const handleNewGoal = useCallback(() => {
    if (!isDemoMode) navigate(list.newGoalPath);
  }, [isDemoMode, list.newGoalPath, navigate]);

  const renderContent = () => {
    if (list.loading && list.goals.length === 0) {
      return <div role="status" className="text-sm text-gray-500">Loading goals…</div>;
    }
    if (list.error && list.goals.length === 0) {
      return <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">{list.error}</div>;
    }
    if (list.goals.length === 0 && !list.appliedSearch && list.stateFilter === 'all' && !list.repositoryFilter && !list.hasPrevious) {
      return <EmptyGoalsState type="no-goals" onCreateGoal={handleNewGoal} createDisabled={isDemoMode} />;
    }
    if (list.goals.length === 0 && list.appliedSearch) {
      return <EmptyGoalsState type="no-search-results" searchQuery={list.appliedSearch} onCreateGoal={handleNewGoal} onClearSearch={list.clearSearch} />;
    }
    if (list.goals.length === 0) {
      return <EmptyGoalsState type="no-filter-results" onCreateGoal={handleNewGoal} onClearFilter={list.clearFilters} />;
    }
    return <GoalsList goals={list.goals} returnTarget={list.detailReturnTarget} />;
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex-shrink-0 border-b border-gray-200 bg-slate-50 px-4 py-3 sm:px-6 sm:py-4">
        <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap sm:gap-4">
          <h1 className="mr-auto flex-shrink-0 text-lg font-bold text-gray-800 sm:text-2xl">Goals</h1>
          <div className="order-3 w-full sm:order-none sm:w-auto">
            <div className="relative">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" aria-hidden="true" />
              <input
                type="search"
                value={list.searchQuery}
                onChange={event => list.setSearchQuery(event.target.value)}
                placeholder="Search goals…"
                aria-label="Search goals"
                className="w-full rounded-md border border-gray-300 bg-white py-2 pl-9 pr-8 text-sm text-gray-700 focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-500 sm:w-64"
              />
              {list.searchQuery && (
                <button type="button" onClick={list.clearSearch} className="absolute right-2 top-1/2 -translate-y-1/2 rounded text-gray-400 hover:text-gray-600" aria-label="Clear search">
                  <X size={16} aria-hidden="true" />
                </button>
              )}
            </div>
          </div>
          <div className="flex min-w-0 items-center gap-2">
            <Filter size={16} className="hidden text-gray-500 sm:block" aria-hidden="true" />
            <select
              value={list.stateFilter}
              onChange={event => list.setStateFilter(event.target.value)}
              aria-label="Filter by state"
              className="rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-700 focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-500 sm:px-3 sm:py-2"
            >
              {GOAL_STATE_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </div>
          <button
            type="button"
            onClick={handleNewGoal}
            disabled={isDemoMode}
            title={isDemoMode ? 'Goal creation is disabled in demo mode' : 'Create a new goal'}
            aria-label="New Goal"
            className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-md bg-teal-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-teal-700 disabled:cursor-not-allowed disabled:opacity-50 sm:px-4 sm:py-2"
          >
            <Target className="h-4 w-4" aria-hidden="true" />
            <span className="hidden sm:inline">New Goal</span>
          </button>
        </div>
        {isDemoMode && <p className="mt-2 text-xs text-amber-700">Demo mode is read-only. You can inspect goals, but you cannot create or change them.</p>}
      </header>

      {!list.isConnected && (
        <div role="status" className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800 sm:px-6">
          Goal updates are disconnected. Showing the last loaded data while the connection recovers.
        </div>
      )}
      {list.error && list.goals.length > 0 && (
        <div role="alert" className="border-b border-red-200 bg-red-50 px-4 py-2 text-xs text-red-700 sm:px-6">{list.error}</div>
      )}

      <div className="flex-1 overflow-x-hidden overflow-y-auto px-4 sm:px-6">
        <div className="py-4">
          {list.loading && list.goals.length > 0 && <span className="sr-only" role="status">Refreshing goals…</span>}
          {renderContent()}
        </div>
      </div>

      {(list.hasPrevious || list.hasNext) && (
        <div className="flex-shrink-0 border-t border-gray-200 bg-slate-50">
          <GoalsPagination
            currentPage={list.currentPage}
            hasPrevious={list.hasPrevious}
            hasNext={list.hasNext}
            loading={list.loading}
            onPrevious={list.previousPage}
            onNext={list.nextPage}
          />
        </div>
      )}
    </div>
  );
};

export default GoalsPage;
