import React from 'react';
import { Link } from 'react-router-dom';
import { Search, Filter, ChevronLeft, ChevronRight, Trash2 } from 'lucide-react';
import { DraftListItem } from '../api/proprApi';
import {
  getEffectiveStatus,
  renderStatusStrip,
  formatRelativeTime
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
      <div className="text-center py-20 mx-6 my-6 bg-gray-50 rounded-lg border border-dashed border-gray-300">
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
      <div className="text-center py-20 mx-6 my-6 bg-gray-50 rounded-lg border border-dashed border-gray-300">
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
    <div className="text-center py-20 mx-6 my-6 bg-gray-50 rounded-lg border border-dashed border-gray-300">
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
    <tr className="hover:bg-gray-50 group border-b border-slate-100">
      {/* Repository column - fixed width for scanning axis alignment */}
      <td className="px-6 py-3 w-[180px] min-w-[180px] max-w-[180px]">
        <Link to={`/studio/${draft.draft_id}`} className="block">
          <span className="inline-flex items-center px-2 py-0.5 text-xs font-mono bg-slate-100 text-slate-700 rounded truncate max-w-full">
            {draft.repository}
          </span>
        </Link>
      </td>
      {/* Plan title and status cell */}
      <td className="px-4 py-3">
        <Link to={`/studio/${draft.draft_id}`} className="block">
          {/* Plan Title */}
          <div className="mb-1">
            <span className="text-sm font-medium text-gray-900">
              {draft.name || draft.initial_prompt}
            </span>
          </div>
          {/* Bottom line: Unified Status Strip */}
          <div className="flex items-center text-xs">
            {renderStatusStrip(draft.issue_summary, effectiveStatus)}
          </div>
        </Link>
      </td>
      {/* Actions cell - right-aligned with consistent width */}
      <td className="px-6 py-3 whitespace-nowrap text-right text-sm font-medium w-[220px]">
        <div className="flex items-center justify-end gap-3">
          {/* Relative time - far right aligned */}
          <span className="text-xs text-slate-400 min-w-[80px] text-right">
            {formatRelativeTime(draft.updated_at)}
          </span>
          {/* Ghost Delete button - icon only, gray, turns red on hover */}
          <button
            onClick={(e) => onDelete(draft.draft_id, e)}
            className="inline-flex items-center justify-center w-8 h-8 text-gray-400 bg-transparent rounded-md hover:text-red-600 hover:bg-red-50 transition-colors opacity-0 group-hover:opacity-100"
            title="Delete"
          >
            <Trash2 size={16} />
          </button>
          {draft.status === 'generating' && (
            <button
              onClick={(e) => onAbort(draft.draft_id, e)}
              disabled={abortingId === draft.draft_id}
              className="inline-flex items-center px-3 py-1.5 text-xs font-medium text-orange-700 bg-white border border-slate-200 rounded-md hover:bg-slate-50 transition-colors disabled:opacity-50"
            >
              {abortingId === draft.draft_id ? 'Stopping...' : 'Stop'}
            </button>
          )}
          {/* Primary action button - fixed width for alignment */}
          <Link
            to={`/studio/${draft.draft_id}`}
            className="inline-flex items-center justify-center w-[72px] px-3 py-1.5 text-xs font-medium text-gray-700 bg-white border border-slate-200 rounded-md hover:bg-slate-50 transition-colors"
          >
            {effectiveStatus === 'merged' ? 'View' : (effectiveStatus === 'executed' || effectiveStatus === 'pr_created') ? 'Manage' : 'Resume'}
          </Link>
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
    <div className="flex items-center justify-between px-6 py-4">
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
}

export const PlansTable: React.FC<PlansTableProps> = ({
  drafts,
  abortingId,
  onDelete,
  onAbort
}) => {
  return (
    <div className="flex flex-col h-full bg-white">
      <div className="flex-1 overflow-auto">
        <table className="min-w-full">
          <thead className="sr-only">
            <tr>
              <th>Repository</th>
              <th>Plan</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody className="bg-white">
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
    </div>
  );
};
