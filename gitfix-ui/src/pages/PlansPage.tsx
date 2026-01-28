import React, { useEffect, useState, useMemo, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { getDrafts, deleteDraft, DraftListItem, IssueSummary } from '../api/gitfixApi';
import { CheckCircle, Clock, Loader2, GitPullRequest, XCircle, AlertCircle, Play, Settings2, Filter, ChevronLeft, ChevronRight } from 'lucide-react';

const DEFAULT_PAGE_SIZE = 10;

const formatRelativeTime = (dateString: string): string => {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSeconds = Math.floor(diffMs / 1000);
  const diffMinutes = Math.floor(diffSeconds / 60);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSeconds < 60) return 'just now';
  if (diffMinutes < 60) return `${diffMinutes} minute${diffMinutes === 1 ? '' : 's'} ago`;
  if (diffHours < 24) return `${diffHours} hour${diffHours === 1 ? '' : 's'} ago`;
  if (diffDays < 30) return `${diffDays} day${diffDays === 1 ? '' : 's'} ago`;
  return date.toLocaleDateString();
};

const PlansPage: React.FC = () => {
  useDocumentTitle('Plans');
  const [drafts, setDrafts] = useState<DraftListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [repoFilter, setRepoFilter] = useState<string>('all');

  // Pagination state
  const [currentPage, setCurrentPage] = useState(1);
  const [totalDrafts, setTotalDrafts] = useState(0);
  const [hasMore, setHasMore] = useState(false);

  // All repositories for filter dropdown (fetched once without filters)
  const [allRepositories, setAllRepositories] = useState<{ repo: string; count: number }[]>([]);
  const [totalAllDrafts, setTotalAllDrafts] = useState(0);

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

  // Fetch drafts with pagination and filtering
  const loadDrafts = useCallback(async (page: number, repository: string) => {
    setLoading(true);
    try {
      const data = await getDrafts({
        page,
        limit: DEFAULT_PAGE_SIZE,
        repository: repository === 'all' ? undefined : repository
      });
      setDrafts(data.drafts);
      setTotalDrafts(data.total);
      setHasMore(data.hasMore);
    } catch (err) {
      setError((err as Error).message || 'Failed to load plans');
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load of all repositories for filter dropdown
  useEffect(() => {
    loadAllRepositories();
  }, [loadAllRepositories]);

  // Load drafts when page or filter changes
  useEffect(() => {
    loadDrafts(currentPage, repoFilter);
  }, [currentPage, repoFilter, loadDrafts]);

  // Reset to first page when filter changes
  const handleFilterChange = (newFilter: string) => {
    setRepoFilter(newFilter);
    setCurrentPage(1);
  };

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!confirm('Are you sure you want to delete this plan?')) return;

    setDrafts(drafts.filter(d => d.draft_id !== id));
    try {
      await deleteDraft(id);
      // Refresh repository counts and current page
      await loadAllRepositories();
      await loadDrafts(currentPage, repoFilter);
    } catch (err) {
      setError((err as Error).message || 'Failed to delete plan');
      await loadDrafts(currentPage, repoFilter);
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'executed':
        return 'bg-green-100 text-green-800';
      case 'review':
        return 'bg-blue-100 text-blue-800';
      case 'generating':
      case 'refining':
        return 'bg-yellow-100 text-yellow-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  const getStatusLabel = (status: string) => {
    switch (status) {
      case 'executed':
        return 'Finalized';
      case 'review':
        return 'Ready for Review';
      case 'generating':
        return 'Generating';
      case 'refining':
        return 'Refining';
      case 'draft':
        return 'Draft';
      default:
        return status.charAt(0).toUpperCase() + status.slice(1);
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'executed':
        return <CheckCircle size={12} className="text-green-600" />;
      case 'review':
        return <Settings2 size={12} className="text-blue-600" />;
      case 'generating':
      case 'refining':
        return <Loader2 size={12} className="text-yellow-600 animate-spin" />;
      default:
        return <Clock size={12} className="text-gray-500" />;
    }
  };

  const renderIssueSummary = (summary: IssueSummary | null | undefined) => {
    if (!summary || summary.total === 0) {
      return <span className="text-gray-400 text-sm">No issues</span>;
    }

    return (
      <div className="flex items-center gap-2 text-xs">
        <span className="flex items-center gap-1 text-gray-600">
          <AlertCircle size={12} />
          {summary.total}
        </span>
        {summary.processing > 0 && (
          <span className="flex items-center gap-1 text-blue-600" title="Processing">
            <Play size={12} />
            {summary.processing}
          </span>
        )}
        {summary.pending > 0 && (
          <span className="flex items-center gap-1 text-yellow-600" title="Pending">
            <Clock size={12} />
            {summary.pending}
          </span>
        )}
        {summary.merged > 0 && (
          <span className="flex items-center gap-1 text-green-600" title="Merged">
            <GitPullRequest size={12} />
            {summary.merged}
          </span>
        )}
        {summary.closed > 0 && (
          <span className="flex items-center gap-1 text-red-600" title="Closed">
            <XCircle size={12} />
            {summary.closed}
          </span>
        )}
      </div>
    );
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
          {allRepositories.length > 1 && (
            <div className="flex items-center gap-2">
              <Filter size={16} className="text-gray-500" />
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
          <Link
            to="/"
            className="px-4 py-2 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 transition-colors"
          >
            + New Plan
          </Link>
        </div>
      </div>

      {totalAllDrafts === 0 && !loading ? (
        <div className="text-center py-20 bg-gray-50 rounded-lg border border-dashed border-gray-300">
          <div className="mb-4">
            <svg className="w-16 h-16 mx-auto text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
          </div>
          <p className="text-gray-500 mb-4">No plans found. Create your first plan!</p>
          <Link
            to="/"
            className="inline-block px-4 py-2 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 transition-colors"
          >
            Create Your First Plan
          </Link>
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
                    <span className={`px-2 inline-flex items-center gap-1 text-xs leading-5 font-semibold rounded-full ${getStatusBadge(draft.status)}`}>
                      {getStatusIcon(draft.status)}
                      {getStatusLabel(draft.status)}
                    </span>
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
                      {draft.status === 'executed' ? 'Manage' : 'Resume'}
                    </Link>
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
