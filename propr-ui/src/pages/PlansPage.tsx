// CI trigger: 2026-02-01
import React, { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { getDrafts, deleteDraft, abortGeneration, DraftListItem, getDraftRepositories } from '../api/proprApi';
import { Filter, Search, X } from 'lucide-react';
import { RepositorySelector, type RepoOption } from '../components/RepositorySelector';
import { EmptyState, PlansTable, PaginationControls } from './PlansPageComponents';
import { useSocket } from '../contexts/useSocket';
import type { DraftUpdatePayload } from '@propr/shared';

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
  const [error, setError] = useState<string | null>(null);

  // Pagination state
  const [totalDrafts, setTotalDrafts] = useState(0);
  const [hasMore, setHasMore] = useState(false);

  // All repositories for filter dropdown (fetched once without filters)
  const [allRepositories, setAllRepositories] = useState<{ repo: string; count: number }[]>([]);
  const [totalAllDrafts, setTotalAllDrafts] = useState(0);

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
    try {
      const data = await getDraftRepositories();
      setAllRepositories(data.repositories);
      setTotalAllDrafts(data.total);
    } catch (err) {
      console.error('Failed to load repositories:', err);
    }
  }, []);

  // Fetch drafts with pagination, filtering, and search
  const loadDrafts = useCallback(async (page: number, repository: string, status: string, showLoading = true) => {
    if (showLoading) {
      setLoading(true);
    }
    try {
      const data = await getDrafts({
        page,
        limit: DEFAULT_PAGE_SIZE,
        repository: repository === 'all' ? undefined : repository,
        search: debouncedSearch || undefined,
        status: status === 'all' ? undefined : status
      });
      setDrafts(data.drafts);
      setTotalDrafts(data.total);
      setHasMore(data.hasMore);
    } catch (err) {
      if (showLoading) {
        setError((err as Error).message || 'Failed to load plans');
      } else {
        console.error('Silent refresh failed:', err);
      }
    } finally {
      if (showLoading) {
        setLoading(false);
      }
    }
  }, [debouncedSearch]);

  // Initial load of all repositories for filter dropdown
  useEffect(() => {
    loadAllRepositories();
  }, [loadAllRepositories]);

  // Load drafts when page, filter, or search changes
  useEffect(() => {
    loadDrafts(currentPage, repoFilter, statusFilter);
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
  const handleDraftUpdate = useCallback(async (payload: DraftUpdatePayload) => {
    // Skip step-level churn during generation, but allow the initial transition into generating
    if (payload.draftStatus === 'generating') {
      const existingDraft = drafts.find(d => d.draft_id === payload.draftId);
      if (!existingDraft || existingDraft.status === 'generating') return;
    }

    const currentPageDraft = drafts.find(d => d.draft_id === payload.draftId);
    const isOnCurrentPage = Boolean(currentPageDraft);
    const matchesStatusFilter = statusFilter === 'all' || payload.draftStatus === statusFilter;
    const matchesRepositoryFilter = repoFilter === 'all' || currentPageDraft?.repository === repoFilter;
    const couldAffectCurrentView = repoFilter === 'all' && !isOnCurrentPage && !!payload.draftStatus && matchesStatusFilter;

    if ((isOnCurrentPage && matchesRepositoryFilter) || couldAffectCurrentView) {
      await Promise.all([
        loadDrafts(currentPage, repoFilter, statusFilter, false),
        payload.draftStatus ? loadAllRepositories() : Promise.resolve(),
      ]);
    }
  }, [currentPage, repoFilter, statusFilter, drafts, loadAllRepositories, loadDrafts]);

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
      await loadDrafts(currentPage, repoFilter, statusFilter);
    } catch (err) {
      setError((err as Error).message || 'Failed to delete plan');
      await loadDrafts(currentPage, repoFilter, statusFilter);
    }
  };

  const handleAbort = async (id: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setAbortingId(id);
    try {
      await abortGeneration(id);
      await Promise.all([
        loadDrafts(currentPage, repoFilter, statusFilter),
        loadAllRepositories(),
      ]);
    } catch (err) {
      setError((err as Error).message || 'Failed to stop generation');
    } finally {
      setAbortingId(null);
    }
  };

  if (loading && drafts.length === 0 && totalAllDrafts === 0) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex-shrink-0 bg-slate-50 border-b border-gray-200 px-4 sm:px-6 py-2 sm:py-4">
          <h1 className="text-xl sm:text-2xl font-bold text-gray-800">Implementation Plans</h1>
        </div>
        <div className="flex-1 overflow-auto px-4 sm:px-6 py-4 sm:py-6">
          <div className="text-gray-500">Loading plans...</div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex-shrink-0 bg-slate-50 border-b border-gray-200 px-4 sm:px-6 py-2 sm:py-4">
          <h1 className="text-xl sm:text-2xl font-bold text-gray-800">Implementation Plans</h1>
        </div>
        <div className="flex-1 overflow-auto px-4 sm:px-6 py-4 sm:py-6">
          <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-red-700">{error}</div>
        </div>
      </div>
    );
  }

  const renderContent = () => {
    if (totalAllDrafts === 0 && !loading && !debouncedSearch) {
      return (
        <EmptyState
          type="no-plans"
          onCreatePlan={handleNewPlan}
        />
      );
    }

    if (drafts.length === 0 && !loading && debouncedSearch) {
      return (
        <EmptyState
          type="no-search-results"
          searchQuery={debouncedSearch}
          onCreatePlan={handleNewPlan}
          onClearSearch={handleSearchClear}
        />
      );
    }

    if (drafts.length === 0 && !loading) {
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
        drafts={drafts}
        abortingId={abortingId}
        onDelete={handleDelete}
        onAbort={handleAbort}
      />
    );
  };

  return (
    <div className="flex flex-col h-full">
      {/* Anchored Header - compact on mobile */}
      <div className="flex-shrink-0 bg-slate-50 border-b border-gray-200 px-4 sm:px-6 py-2 sm:py-4">
        <div className="flex items-center justify-between gap-2 sm:gap-4">
          <h1 className="text-lg sm:text-2xl font-bold text-gray-800 flex-shrink-0">Plans</h1>
          <div className="flex items-center gap-2 sm:gap-4 flex-1 justify-end">
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
            <div className="flex items-center gap-2">
              <Filter size={16} className="text-gray-500 hidden sm:block" />
              <select
                value={statusFilter}
                onChange={(e) => handleStatusFilterChange(e.target.value)}
                className="px-2 sm:px-3 py-1.5 sm:py-2 border border-gray-300 rounded-md text-sm bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-teal-500"
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
                  className="w-[220px] sm:w-[320px]"
                />
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Scrollable Content Area */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden px-4 sm:px-6 w-full max-w-full">
        {renderContent()}
      </div>

      {/* Anchored Footer */}
      {drafts.length > 0 && totalPages > 1 && (
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
