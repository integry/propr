// CI trigger: 2026-02-01
import React, { useEffect, useState, useMemo, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useNewPlanForm } from '../hooks/useNewPlanForm';
import { getDrafts, deleteDraft, abortGeneration, DraftListItem } from '../api/gitfixApi';
import { Filter, ChevronLeft, ChevronRight, Search, X } from 'lucide-react';
import {
  getEffectiveStatus,
  formatRelativeTime,
  getStatusBadge,
  getStatusLabel,
  getStatusIcon,
  renderIssueSummary
} from './PlansPageUtils';
import { NewPlanForm } from '../components/Dashboard/index';

const DEFAULT_PAGE_SIZE = 10;

const PlansPage: React.FC = () => {
  useDocumentTitle('Plans');
  const [drafts, setDrafts] = useState<DraftListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [repoFilter, setRepoFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [debouncedSearch, setDebouncedSearch] = useState<string>('');

  // Pagination state
  const [currentPage, setCurrentPage] = useState(1);
  const [totalDrafts, setTotalDrafts] = useState(0);
  const [hasMore, setHasMore] = useState(false);

  // All repositories for filter dropdown (fetched once without filters)
  const [allRepositories, setAllRepositories] = useState<{ repo: string; count: number }[]>([]);
  const [totalAllDrafts, setTotalAllDrafts] = useState(0);

  // NewPlanForm hook
  const newPlanForm = useNewPlanForm();

  const totalPages = useMemo(() => Math.ceil(totalDrafts / DEFAULT_PAGE_SIZE), [totalDrafts]);

  // Fetch all repositories for the filter dropdown (without any filters applied)
  const loadAllRepositories = useCallback(async () => {
    try {
      // Fetch all drafts to get repository counts (with high limit to get all)
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
  const loadDrafts = useCallback(async (page: number, repository: string, status: string) => {
    setLoading(true);
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
      setError((err as Error).message || 'Failed to load plans');
    } finally {
      setLoading(false);
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

  // Debounce search query
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchQuery);
      setCurrentPage(1); // Reset to first page when search changes
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // Reset to first page when filter changes
  const handleFilterChange = (newFilter: string) => {
    setRepoFilter(newFilter);
    setCurrentPage(1);
  };

  const handleStatusFilterChange = (newStatus: string) => {
    setStatusFilter(newStatus);
    setCurrentPage(1);
  };

  const handleSearchClear = () => {
    setSearchQuery('');
    setDebouncedSearch('');
    setCurrentPage(1);
  };

  const [abortingId, setAbortingId] = useState<string | null>(null);

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!confirm('Are you sure you want to delete this plan?')) return;

    setDrafts(drafts.filter(d => d.draft_id !== id));
    try {
      await deleteDraft(id);
      // Refresh repository counts and current page
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
      // Refresh the list to show updated status
      await loadDrafts(currentPage, repoFilter);
    } catch (err) {
      setError((err as Error).message || 'Failed to stop generation');
    } finally {
      setAbortingId(null);
    }
  };

  // Only show full-page loading on initial load (when no data yet)
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

  return (
    <div className="p-6">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold text-gray-800">Implementation Plans</h1>
        <div className="flex items-center gap-4">
          {/* Search input */}
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
            onClick={newPlanForm.toggleFormExpanded}
            className="px-4 py-2 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 transition-colors"
          >
            + New Plan
          </button>
        </div>
      </div>

      {/* NewPlanForm - shown when expanded */}
      {newPlanForm.isFormExpanded && (
        <div className="mb-6">
          <NewPlanForm
            repos={newPlanForm.repos}
            selectedRepo={newPlanForm.selectedRepo}
            onRepoChange={newPlanForm.setSelectedRepo}
            prompt={newPlanForm.prompt}
            onPromptChange={newPlanForm.setPrompt}
            onPaste={newPlanForm.handlePaste}
            selectedFiles={newPlanForm.selectedFiles}
            onRemoveFile={newPlanForm.handleRemoveFile}
            onFileSelect={newPlanForm.handleFileSelect}
            fileInputRef={newPlanForm.fileInputRef}
            isPastingImage={newPlanForm.isPastingImage}
            error={newPlanForm.formError}
            isCreating={newPlanForm.isCreating}
            onStartPlanning={newPlanForm.handleStartPlanning}
            isExpanded={newPlanForm.isFormExpanded}
            onExpandChange={newPlanForm.setIsFormExpanded}
          />
        </div>
      )}

      {totalAllDrafts === 0 && !loading && !debouncedSearch ? (
        <div className="text-center py-20 bg-gray-50 rounded-lg border border-dashed border-gray-300">
          <div className="mb-4">
            <svg className="w-16 h-16 mx-auto text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
          </div>
          <p className="text-gray-500 mb-4">No plans found. Create your first plan!</p>
          <button
            onClick={() => newPlanForm.setIsFormExpanded(true)}
            className="inline-block px-4 py-2 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 transition-colors"
          >
            Create Your First Plan
          </button>
        </div>
      ) : drafts.length === 0 && !loading && debouncedSearch ? (
        <div className="text-center py-20 bg-gray-50 rounded-lg border border-dashed border-gray-300">
          <div className="mb-4">
            <Search className="w-16 h-16 mx-auto text-gray-400" />
          </div>
          <p className="text-gray-500 mb-4">No plans found matching "{debouncedSearch}"</p>
          <button
            onClick={handleSearchClear}
            className="inline-block px-4 py-2 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 transition-colors"
          >
            Clear Search
          </button>
        </div>
      ) : drafts.length === 0 && !loading ? (
        <div className="text-center py-20 bg-gray-50 rounded-lg border border-dashed border-gray-300">
          <div className="mb-4">
            <Filter className="w-16 h-16 mx-auto text-gray-400" />
          </div>
          <p className="text-gray-500 mb-4">No plans found for the selected repository.</p>
          <button
            onClick={() => handleFilterChange('all')}
            className="inline-block px-4 py-2 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 transition-colors"
          >
            Show All Plans
          </button>
        </div>
      ) : (
        <div className="bg-white shadow rounded-lg overflow-hidden">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Repository / Prompt
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Status
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Issues
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Last Updated
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {drafts.map((draft) => (
                <tr key={draft.draft_id} className="hover:bg-gray-50 group">
                  <td className="px-6 py-4">
                    <Link to={`/tasks/plan/${draft.draft_id}`} className="block">
                      <div className="text-sm font-medium text-indigo-600">{draft.repository}</div>
                      <div className="text-sm text-gray-500 truncate max-w-md">
                        {draft.name || draft.initial_prompt}
                      </div>
                    </Link>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    {(() => {
                      const effectiveStatus = getEffectiveStatus(draft.status, draft.issue_summary);
                      return (
                        <span className={`px-2 inline-flex items-center gap-1 text-xs leading-5 font-semibold rounded-full ${getStatusBadge(effectiveStatus)}`}>
                          {getStatusIcon(effectiveStatus)}
                          {getStatusLabel(effectiveStatus)}
                        </span>
                      );
                    })()}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    {renderIssueSummary(draft.issue_summary)}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                    {formatRelativeTime(draft.updated_at)}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                    <Link
                      to={`/tasks/plan/${draft.draft_id}`}
                      className="text-indigo-600 hover:text-indigo-900 mr-4"
                    >
                      {draft.status === 'executed' || draft.status === 'merged' || getEffectiveStatus(draft.status, draft.issue_summary) === 'merged' ? 'Manage' : 'Resume'}
                    </Link>
                    {draft.status === 'generating' && (
                      <button
                        onClick={(e) => handleAbort(draft.draft_id, e)}
                        disabled={abortingId === draft.draft_id}
                        className="text-orange-600 hover:text-orange-900 mr-4 disabled:opacity-50"
                      >
                        {abortingId === draft.draft_id ? 'Stopping...' : 'Stop'}
                      </button>
                    )}
                    <button
                      onClick={(e) => handleDelete(draft.draft_id, e)}
                      className="text-red-600 hover:text-red-900 opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Pagination controls */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between px-6 py-4 border-t border-gray-200 bg-gray-50">
              <span className="text-sm text-gray-600">
                Showing {(currentPage - 1) * DEFAULT_PAGE_SIZE + 1}-{Math.min(currentPage * DEFAULT_PAGE_SIZE, totalDrafts)} of {totalDrafts} plans
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                  disabled={currentPage === 1 || loading}
                  className="inline-flex items-center gap-1 px-3 py-1.5 text-sm font-medium rounded-md border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  <ChevronLeft size={16} />
                  Previous
                </button>
                <span className="text-sm text-gray-600 px-2">
                  Page {currentPage} of {totalPages}
                </span>
                <button
                  onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                  disabled={!hasMore || loading}
                  className="inline-flex items-center gap-1 px-3 py-1.5 text-sm font-medium rounded-md border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  Next
                  <ChevronRight size={16} />
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default PlansPage;
