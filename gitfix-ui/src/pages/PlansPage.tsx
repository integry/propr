// CI trigger: 2026-02-01
import React, { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { getDrafts, deleteDraft, abortGeneration, DraftListItem } from '../api/gitfixApi';
import { Filter, Search, X } from 'lucide-react';
import { EmptyState, PlansTable } from './PlansPageComponents';

const DEFAULT_PAGE_SIZE = 50;

const PlansPage: React.FC = () => {
  useDocumentTitle('Plans');
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

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

  // Fetch all repositories for the filter dropdown (without any filters applied)
  const loadAllRepositories = useCallback(async () => {
    try {
      const data = await getDrafts({ limit: 1000 });
      const repoCounts: Record<string, number> = {};
      data.drafts.forEach(draft => {
        const repo = draft.repository;
        repoCounts[repo] = (repoCounts[repo] || 0) + 1;
      });
      const repos = Object.entries(repoCounts)
        .map(([repo, count]) => ({ repo, count }))
        .sort((a, b) => a.repo.localeCompare(b.repo));
      setAllRepositories(repos);
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

  // Auto-polling every 5 seconds for silent refresh
  useEffect(() => {
    const intervalId = setInterval(() => {
      loadDrafts(currentPage, repoFilter, statusFilter, false);
    }, 5000);
    return () => clearInterval(intervalId);
  }, [currentPage, repoFilter, statusFilter, loadDrafts]);

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
      await loadDrafts(currentPage, repoFilter, statusFilter);
    } catch (err) {
      setError((err as Error).message || 'Failed to stop generation');
    } finally {
      setAbortingId(null);
    }
  };

  if (loading && drafts.length === 0 && totalAllDrafts === 0) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold text-gray-800 mb-6">Implementation Plans</h1>
        <div className="text-gray-500">Loading plans...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold text-gray-800 mb-6">Implementation Plans</h1>
        <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-red-700">{error}</div>
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
        currentPage={currentPage}
        totalPages={totalPages}
        totalDrafts={totalDrafts}
        pageSize={DEFAULT_PAGE_SIZE}
        hasMore={hasMore}
        loading={loading}
        onPageChange={handlePageChange}
      />
    );
  };

  return (
    <div className="p-6">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold text-gray-800">Implementation Plans</h1>
        <div className="flex items-center gap-4">
          <div className="relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search plans..."
              className="pl-9 pr-8 py-2 w-64 border border-gray-300 rounded-md text-sm bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
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
          <div className="flex items-center gap-2">
            <Filter size={16} className="text-gray-500" />
            <select
              value={statusFilter}
              onChange={(e) => handleStatusFilterChange(e.target.value)}
              className="px-3 py-2 border border-gray-300 rounded-md text-sm bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
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
          </div>
          {allRepositories.length > 1 && (
            <div className="flex items-center gap-2">
              <select
                value={repoFilter}
                onChange={(e) => handleFilterChange(e.target.value)}
                className="px-3 py-2 border border-gray-300 rounded-md text-sm bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
              >
                <option value="all">All Repositories ({totalAllDrafts})</option>
                {allRepositories.map(({ repo, count }) => (
                  <option key={repo} value={repo}>
                    {repo} ({count})
                  </option>
                ))}
              </select>
            </div>
          )}
          <button
            onClick={handleNewPlan}
            className="px-4 py-2 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 transition-colors"
          >
            + New Plan
          </button>
        </div>
      </div>

      {renderContent()}
    </div>
  );
};

export default PlansPage;
