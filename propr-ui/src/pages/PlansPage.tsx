// CI trigger: 2026-02-01
import React, { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { getDrafts, deleteDraft, abortGeneration, DraftListItem, getDraftRepositories } from '../api/proprApi';
import { Filter, LoaderCircle, Search, X } from 'lucide-react';
import { RepositorySelector, type RepoOption } from '../components/RepositorySelector';
import { EmptyState, PlansTable, PaginationControls } from './PlansPageComponents';
import { useSocket } from '../contexts/useSocket';
import type { DraftUpdatePayload } from '@propr/shared';
import { useLiveRefreshScheduler } from '../hooks/useLiveRefreshScheduler';

const DEFAULT_PAGE_SIZE = 50;

const PlansPage: React.FC = () => {
  useDocumentTitle('Plans');
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { onDraftUpdate, isConnected } = useSocket();

  // Derive state from URL parameters
  const repoFilter = searchParams.get('repository') || 'all';
  const statusFilter = searchParams.get('status') || 'all';
  const urlSearch = searchParams.get('search') || '';
  const currentPage = Math.max(1, parseInt(searchParams.get('page') || '1', 10));

  // Local state for search input (to handle typing before debounce)
  const [searchQuery, setSearchQuery] = useState<string>(urlSearch);
  const [debouncedSearch, setDebouncedSearch] = useState<string>(urlSearch);
  const isInitialMount = useRef(true);

  const [drafts, setDrafts] = useState<DraftListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadedScope, setLoadedScope] = useState<string | null>(null);
  const [error, setError] = useState<{ scope: string; message: string } | null>(null);

  // Pagination state
  const [totalDrafts, setTotalDrafts] = useState(0);
  const [hasMore, setHasMore] = useState(false);

  // All repositories for filter dropdown (fetched once without filters)
  const [allRepositories, setAllRepositories] = useState<{ repo: string; count: number }[]>([]);
  const [totalAllDrafts, setTotalAllDrafts] = useState(0);
  const liveDraftStatusesRef = useRef<Map<string, string>>(new Map());
  const draftsRequestId = useRef(0);
  const repositoriesRequestId = useRef(0);
  const queryScope = useMemo(
    () => JSON.stringify([currentPage, repoFilter, statusFilter, debouncedSearch]),
    [currentPage, debouncedSearch, repoFilter, statusFilter]
  );

  // Handler to navigate directly to new plan studio
  const handleNewPlan = useCallback(() => {
    navigate('/studio/new');
  }, [navigate]);

  const totalPages = useMemo(() => Math.ceil(totalDrafts / DEFAULT_PAGE_SIZE), [totalDrafts]);

  // Build repo options for the shared RepositorySelector
  const repoFilterOptions: RepoOption[] = useMemo(() => {
    const allOption: RepoOption = {
      name: 'all',
      enabled: true,
      displayName: 'All Repos',
      count: totalAllDrafts,
    };
    const repoOptions: RepoOption[] = [...allRepositories]
      .sort((a, b) => a.repo.localeCompare(b.repo))
      .map(({ repo, count }) => ({
        name: repo,
        enabled: true,
        count,
      }));
    return [allOption, ...repoOptions];
  }, [allRepositories, totalAllDrafts]);

  // Fetch all repositories for the filter dropdown
  const loadAllRepositories = useCallback(async () => {
    const requestId = ++repositoriesRequestId.current;
    try {
      const data = await getDraftRepositories();
      if (requestId !== repositoriesRequestId.current) return;
      setAllRepositories(data.repositories);
      setTotalAllDrafts(data.total);
    } catch (err) {
      console.error('Failed to load repositories:', err);
    }
  }, []);

  // Fetch drafts with pagination, filtering, and search
  const loadDrafts = useCallback(async (
    page: number,
    repository: string,
    status: string,
    search: string,
    showLoading = true
  ) => {
    const requestId = ++draftsRequestId.current;
    if (showLoading) {
      setLoading(true);
    } else {
      setRefreshing(true);
    }
    setError(current => current?.scope === queryScope ? null : current);
    try {
      const data = await getDrafts({
        page,
        limit: DEFAULT_PAGE_SIZE,
        repository: repository === 'all' ? undefined : repository,
        search: search || undefined,
        status: status === 'all' ? undefined : status
      });
      if (requestId !== draftsRequestId.current) return;
      setDrafts(data.drafts);
      setTotalDrafts(data.total);
      setHasMore(data.hasMore);
      setLoadedScope(queryScope);
      setError(null);
    } catch (err) {
      if (requestId !== draftsRequestId.current) return;
      setError({ scope: queryScope, message: (err as Error).message || 'Failed to load plans' });
    } finally {
      if (requestId === draftsRequestId.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [queryScope]);

  useEffect(() => {
    for (const draft of drafts) liveDraftStatusesRef.current.set(draft.draft_id, draft.status);
  }, [drafts]);

  const refreshLiveDrafts = useCallback(async () => {
    await Promise.all([
      loadDrafts(currentPage, repoFilter, statusFilter, debouncedSearch, false),
      loadAllRepositories(),
    ]);
  }, [currentPage, debouncedSearch, loadAllRepositories, loadDrafts, repoFilter, statusFilter]);
  const scheduleLiveRefresh = useLiveRefreshScheduler({
    isConnected,
    refresh: refreshLiveDrafts,
  });

  // Initial load of all repositories for filter dropdown
  useEffect(() => {
    loadAllRepositories();
  }, [loadAllRepositories]);

  // Load drafts when page, filter, or search changes
  useEffect(() => {
    loadDrafts(currentPage, repoFilter, statusFilter, debouncedSearch);
  }, [currentPage, repoFilter, statusFilter, debouncedSearch, loadDrafts]);

  // Sync search input with URL on initial load
  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      setSearchQuery(urlSearch);
      setDebouncedSearch(urlSearch);
    }
  }, [urlSearch]);

  // Debounce search query and update URL
  useEffect(() => {
    const timer = setTimeout(() => {
      if (searchQuery !== debouncedSearch) {
        setDebouncedSearch(searchQuery);
        setSearchParams(prev => {
          const newParams = new URLSearchParams(prev);
          if (searchQuery) {
            newParams.set('search', searchQuery);
          } else {
            newParams.delete('search');
          }
          newParams.set('page', '1');
          return newParams;
        }, { replace: true });
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery, debouncedSearch, setSearchParams]);

  // Handle draft update from WebSocket - skip step-level generation progress events
  const handleDraftUpdate = useCallback((payload: DraftUpdatePayload) => {
    // Skip step-level churn during generation, but allow the initial transition into generating
    if (payload.draftStatus === 'generating') {
      const existingStatus = liveDraftStatusesRef.current.get(payload.draftId);
      if (!existingStatus || existingStatus === 'generating') return;
    }

    const currentPageDraft = drafts.find(d => d.draft_id === payload.draftId);
    const isOnCurrentPage = Boolean(currentPageDraft);
    const matchesStatusFilter = statusFilter === 'all' || payload.draftStatus === statusFilter;
    const matchesRepositoryFilter = repoFilter === 'all' || currentPageDraft?.repository === repoFilter;
    const couldAffectCurrentView = !isOnCurrentPage && !!payload.draftStatus && matchesStatusFilter;

    if ((isOnCurrentPage && matchesRepositoryFilter) || couldAffectCurrentView) {
      if (payload.draftStatus === liveDraftStatusesRef.current.get(payload.draftId)) return;
      if (payload.draftStatus) {
        liveDraftStatusesRef.current.set(payload.draftId, payload.draftStatus);
      }
      scheduleLiveRefresh();
    }
  }, [repoFilter, statusFilter, drafts, scheduleLiveRefresh]);

  // Subscribe to WebSocket events for draft updates
  useEffect(() => {
    if (!isConnected) return;

    // Listen for draft updates (global listener for the plans list)
    const unsubscribe = onDraftUpdate(handleDraftUpdate);

    return () => {
      unsubscribe();
    };
  }, [isConnected, onDraftUpdate, handleDraftUpdate]);

  // Helper to update URL params
  const updateSearchParams = useCallback((updates: Record<string, string | null>) => {
    setSearchParams(prev => {
      const newParams = new URLSearchParams(prev);
      Object.entries(updates).forEach(([key, value]) => {
        if (value === null || value === 'all' || value === '') {
          newParams.delete(key);
        } else {
          newParams.set(key, value);
        }
      });
      return newParams;
    }, { replace: true });
  }, [setSearchParams]);

  const handleFilterChange = (newFilter: string) => {
    updateSearchParams({ repository: newFilter, page: '1' });
  };

  const handleStatusFilterChange = (newStatus: string) => {
    updateSearchParams({ status: newStatus, page: '1' });
  };

  const handleSearchClear = () => {
    setSearchQuery('');
    setDebouncedSearch('');
    updateSearchParams({ search: null, page: '1' });
  };

  const handlePageChange = (newPage: number) => {
    updateSearchParams({ page: newPage.toString() });
  };

  const [abortingId, setAbortingId] = useState<string | null>(null);

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!confirm('Are you sure you want to delete this plan?')) return;

    setDrafts(drafts.filter(d => d.draft_id !== id));
    try {
      await deleteDraft(id);
      await loadAllRepositories();
      await loadDrafts(currentPage, repoFilter, statusFilter, debouncedSearch);
    } catch (err) {
      setError({ scope: queryScope, message: (err as Error).message || 'Failed to delete plan' });
      await loadDrafts(currentPage, repoFilter, statusFilter, debouncedSearch);
    }
  };

  const handleAbort = async (id: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setAbortingId(id);
    try {
      await abortGeneration(id);
      await Promise.all([
        loadDrafts(currentPage, repoFilter, statusFilter, debouncedSearch),
        loadAllRepositories(),
      ]);
    } catch (err) {
      setError({ scope: queryScope, message: (err as Error).message || 'Failed to stop generation' });
    } finally {
      setAbortingId(null);
    }
  };

  const hasCurrentScopeData = loadedScope === queryScope;
  const visibleDrafts = hasCurrentScopeData ? drafts : [];
  const currentError = error?.scope === queryScope ? error.message : null;

  if (!hasCurrentScopeData && !currentError) {
    return (
      <div className="flex h-full w-full min-w-0 flex-col bg-white">
        <div className="flex-shrink-0 bg-slate-50 border-b border-gray-200 px-4 sm:px-6 py-2 sm:py-4">
          <h1 className="text-xl sm:text-2xl font-bold text-gray-800">Plans</h1>
        </div>
        <div className="flex-1 overflow-auto px-4 sm:px-6 py-4 sm:py-6">
          <div role="status" className="flex items-center gap-2 text-gray-500"><LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />Loading plans...</div>
        </div>
      </div>
    );
  }

  if (currentError && visibleDrafts.length === 0) {
    return (
      <div className="flex h-full w-full min-w-0 flex-col bg-white">
        <div className="flex-shrink-0 bg-slate-50 border-b border-gray-200 px-4 sm:px-6 py-2 sm:py-4">
          <h1 className="text-xl sm:text-2xl font-bold text-gray-800">Plans</h1>
        </div>
        <div className="flex-1 overflow-auto px-4 sm:px-6 py-4 sm:py-6">
          <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-red-700">{currentError}</div>
        </div>
      </div>
    );
  }

  const renderContent = () => {
    if (visibleDrafts.length === 0
      && totalDrafts === 0
      && currentPage === 1
      && repoFilter === 'all'
      && statusFilter === 'all'
      && !debouncedSearch) {
      return (
        <EmptyState
          type="no-plans"
          onCreatePlan={handleNewPlan}
        />
      );
    }

    if (visibleDrafts.length === 0 && debouncedSearch) {
      return (
        <EmptyState
          type="no-search-results"
          searchQuery={debouncedSearch}
          onCreatePlan={handleNewPlan}
          onClearSearch={handleSearchClear}
        />
      );
    }

    if (visibleDrafts.length === 0) {
      return (
        <EmptyState
          type="no-filter-results"
          onCreatePlan={handleNewPlan}
          onClearFilter={() => handleFilterChange('all')}
        />
      );
    }

    return (
      <PlansTable
        drafts={visibleDrafts}
        abortingId={abortingId}
        onDelete={handleDelete}
        onAbort={handleAbort}
      />
    );
  };

  return (
    <div className="flex h-full w-full min-w-0 flex-col bg-white">
      {/* Anchored Header - compact on mobile */}
      <div className="flex-shrink-0 bg-slate-50 border-b border-gray-200 px-4 sm:px-6 py-2 sm:py-4">
        <div className="flex items-center justify-between gap-2 sm:gap-4">
          <h1 className="text-lg sm:text-2xl font-bold text-gray-800 flex-shrink-0">Plans</h1>
          <div className="flex items-center gap-2 sm:gap-4 flex-1 min-w-0 justify-end">
            {/* Search input - hidden on mobile, shown on desktop */}
            <div className="relative hidden sm:block">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search plans..."
                className="pl-9 pr-8 py-2 w-64 border border-gray-300 rounded-md text-sm bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-teal-500"
              />
              {searchQuery && (
                <button
                  onClick={handleSearchClear}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                  title="Clear search"
                >
                  <X size={16} />
                </button>
              )}
            </div>
            {/* Filters row - inline on all screen sizes */}
            <div className="flex items-center gap-2 min-w-0">
              <Filter size={16} className="text-gray-500 hidden sm:block" />
              <select
                value={statusFilter}
                onChange={(e) => handleStatusFilterChange(e.target.value)}
                className="w-[120px] sm:w-auto px-2 sm:px-3 py-1.5 sm:py-2 border border-gray-300 rounded-md text-sm bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-teal-500"
              >
                <option value="all">All Statuses</option>
                <option value="draft">Draft</option>
                <option value="review">Ready for Review</option>
                <option value="generating">Generating</option>
                <option value="refining">Refining</option>
                <option value="executed">Issues Created</option>
                <option value="pr_created">PR Created</option>
                <option value="merged">Merged</option>
              </select>
              {allRepositories.length > 0 && (
                <RepositorySelector
                  repos={repoFilterOptions}
                  selectedRepo={repoFilter}
                  onRepoChange={handleFilterChange}
                  variant="default"
                  labelLayout="stacked"
                  className="flex-1 min-w-0 max-w-[220px] sm:flex-none sm:w-[320px] sm:max-w-[320px]"
                />
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Scrollable Content Area */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden w-full max-w-full">
        {currentError && <div className="mx-4 mt-4 border-l-2 border-red-500 bg-red-50 p-3 text-sm text-red-700 sm:mx-6">Couldn’t refresh plans: {currentError}</div>}
        {(loading || refreshing) && <div role="status" className="px-4 pt-3 text-xs text-slate-500 sm:px-6">Refreshing plans…</div>}
        {renderContent()}
      </div>

      {/* Anchored Footer */}
      {visibleDrafts.length > 0 && totalPages > 1 && (
        <div className="flex-shrink-0 bg-slate-50 border-t border-gray-200">
          <PaginationControls
            currentPage={currentPage}
            totalPages={totalPages}
            totalDrafts={totalDrafts}
            pageSize={DEFAULT_PAGE_SIZE}
            hasMore={hasMore}
            loading={loading}
            onPageChange={handlePageChange}
          />
        </div>
      )}
    </div>
  );
};

export default PlansPage;
