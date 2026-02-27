import React from 'react';
import { Link } from 'react-router-dom';
import { Search, Filter, ChevronLeft, ChevronRight } from 'lucide-react';
import { DraftListItem } from '../api/gitfixApi';
import {
  getEffectiveStatus,
  formatRelativeTime,
  getStatusBadge,
  getStatusLabel,
  getStatusIcon,
  renderIssueSummary
} from './PlansPageUtils';

interface EmptyStateProps {
  type: 'no-plans' | 'no-search-results' | 'no-filter-results';
  searchQuery?: string;
  onCreatePlan: () => void;
  onClearSearch?: () => void;
  onClearFilter?: () => void;
}

export const EmptyState: React.FC<EmptyStateProps> = ({
  type,
  searchQuery,
  onCreatePlan,
  onClearSearch,
  onClearFilter
}) => {
  if (type === 'no-plans') {
    return (
      <div className="text-center py-20 bg-gray-50 rounded-lg border border-dashed border-gray-300">
        <div className="mb-4">
          <svg className="w-16 h-16 mx-auto text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
        </div>
        <p className="text-gray-500 mb-4">No plans found. Create your first plan!</p>
        <button
          onClick={onCreatePlan}
          className="inline-block px-4 py-2 bg-teal-600 text-white rounded-md hover:bg-teal-700 transition-colors"
        >
          Create Your First Plan
        </button>
      </div>
    );
  }

  if (type === 'no-search-results') {
    return (
      <div className="text-center py-20 bg-gray-50 rounded-lg border border-dashed border-gray-300">
        <div className="mb-4">
          <Search className="w-16 h-16 mx-auto text-gray-400" />
        </div>
        <p className="text-gray-500 mb-4">No plans found matching "{searchQuery}"</p>
        <button
          onClick={onClearSearch}
          className="inline-block px-4 py-2 bg-teal-600 text-white rounded-md hover:bg-teal-700 transition-colors"
        >
          Clear Search
        </button>
      </div>
    );
  }

  return (
    <div className="text-center py-20 bg-gray-50 rounded-lg border border-dashed border-gray-300">
      <div className="mb-4">
        <Filter className="w-16 h-16 mx-auto text-gray-400" />
      </div>
      <p className="text-gray-500 mb-4">No plans found for the selected repository.</p>
      <button
        onClick={onClearFilter}
        className="inline-block px-4 py-2 bg-teal-600 text-white rounded-md hover:bg-teal-700 transition-colors"
      >
        Show All Plans
      </button>
    </div>
  );
};

interface PlansTableRowProps {
  draft: DraftListItem;
  abortingId: string | null;
  onDelete: (id: string, e: React.MouseEvent) => void;
  onAbort: (id: string, e: React.MouseEvent) => void;
}

export const PlansTableRow: React.FC<PlansTableRowProps> = ({
  draft,
  abortingId,
  onDelete,
  onAbort
}) => {
  const effectiveStatus = getEffectiveStatus(draft.status, draft.issue_summary);

  return (
    <tr className="hover:bg-gray-50 group">
      {/* Main content cell - spans the content area */}
      <td className="px-6 py-3">
        <Link to={`/studio/${draft.draft_id}`} className="block">
          {/* Top line: Repo Chip + Title */}
          <div className="flex items-center gap-2 mb-1">
            <span className="inline-flex items-center px-2 py-0.5 text-xs font-mono bg-slate-100 text-slate-700 rounded">
              {draft.repository}
            </span>
            <span className="text-sm font-medium text-gray-900 truncate">
              {draft.name || draft.initial_prompt}
            </span>
          </div>
          {/* Bottom line: Metrics + Status + Time */}
          <div className="flex items-center gap-3 text-xs">
            {renderIssueSummary(draft.issue_summary)}
            <span className={`px-2 inline-flex items-center gap-1 leading-5 font-semibold rounded-full ${getStatusBadge(effectiveStatus)}`}>
              {getStatusIcon(effectiveStatus)}
              {getStatusLabel(effectiveStatus)}
            </span>
            <span className="text-gray-500">
              {formatRelativeTime(draft.updated_at)}
            </span>
          </div>
        </Link>
      </td>
      {/* Actions cell */}
      <td className="px-6 py-3 whitespace-nowrap text-right text-sm font-medium">
        <div className="flex items-center justify-end gap-2">
          <Link
            to={`/studio/${draft.draft_id}`}
            className="inline-flex items-center px-3 py-1.5 text-xs font-medium text-gray-700 bg-white border border-slate-200 rounded-md hover:bg-slate-50 transition-colors"
          >
            {draft.status === 'executed' || draft.status === 'merged' || effectiveStatus === 'merged' ? 'Manage' : 'Resume'}
          </Link>
          {draft.status === 'generating' && (
            <button
              onClick={(e) => onAbort(draft.draft_id, e)}
              disabled={abortingId === draft.draft_id}
              className="inline-flex items-center px-3 py-1.5 text-xs font-medium text-orange-700 bg-white border border-slate-200 rounded-md hover:bg-slate-50 transition-colors disabled:opacity-50"
            >
              {abortingId === draft.draft_id ? 'Stopping...' : 'Stop'}
            </button>
          )}
          <button
            onClick={(e) => onDelete(draft.draft_id, e)}
            className="inline-flex items-center px-3 py-1.5 text-xs font-medium text-red-700 bg-white border border-slate-200 rounded-md hover:bg-slate-50 transition-colors opacity-0 group-hover:opacity-100"
          >
            Delete
          </button>
        </div>
      </td>
    </tr>
  );
};

interface PaginationControlsProps {
  currentPage: number;
  totalPages: number;
  totalDrafts: number;
  pageSize: number;
  hasMore: boolean;
  loading: boolean;
  onPageChange: (page: number) => void;
}

export const PaginationControls: React.FC<PaginationControlsProps> = ({
  currentPage,
  totalPages,
  totalDrafts,
  pageSize,
  hasMore,
  loading,
  onPageChange
}) => {
  if (totalPages <= 1) return null;

  return (
    <div className="flex-shrink-0 flex items-center justify-between px-6 py-4 border-t border-gray-200 bg-slate-50">
      <span className="text-sm text-gray-600">
        Showing {(currentPage - 1) * pageSize + 1}-{Math.min(currentPage * pageSize, totalDrafts)} of {totalDrafts} plans
      </span>
      <div className="flex items-center gap-2">
        <button
          onClick={() => onPageChange(Math.max(1, currentPage - 1))}
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
          onClick={() => onPageChange(Math.min(totalPages, currentPage + 1))}
          disabled={!hasMore || loading}
          className="inline-flex items-center gap-1 px-3 py-1.5 text-sm font-medium rounded-md border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          Next
          <ChevronRight size={16} />
        </button>
      </div>
    </div>
  );
};

interface PlansTableProps {
  drafts: DraftListItem[];
  abortingId: string | null;
  onDelete: (id: string, e: React.MouseEvent) => void;
  onAbort: (id: string, e: React.MouseEvent) => void;
  currentPage: number;
  totalPages: number;
  totalDrafts: number;
  pageSize: number;
  hasMore: boolean;
  loading: boolean;
  onPageChange: (page: number) => void;
}

export const PlansTable: React.FC<PlansTableProps> = ({
  drafts,
  abortingId,
  onDelete,
  onAbort,
  currentPage,
  totalPages,
  totalDrafts,
  pageSize,
  hasMore,
  loading,
  onPageChange
}) => {
  return (
    <div className="flex flex-col h-full bg-white shadow rounded-lg overflow-hidden">
      <div className="flex-1 overflow-auto">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50 sticky top-0">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Plan
              </th>
              <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {drafts.map((draft) => (
              <PlansTableRow
                key={draft.draft_id}
                draft={draft}
                abortingId={abortingId}
                onDelete={onDelete}
                onAbort={onAbort}
              />
            ))}
          </tbody>
        </table>
      </div>
      <PaginationControls
        currentPage={currentPage}
        totalPages={totalPages}
        totalDrafts={totalDrafts}
        pageSize={pageSize}
        hasMore={hasMore}
        loading={loading}
        onPageChange={onPageChange}
      />
    </div>
  );
};
