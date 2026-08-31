import React from 'react';
import { Link } from 'react-router-dom';
import {
  Target,
  CheckSquare,
  ExternalLink,
  ChevronLeft,
  ChevronRight,
  Zap,
  GitMerge,
  Clock,
  Cpu,
} from 'lucide-react';
import type { GoalListItem, GoalState } from '../api/goalsApi';

// ─── State badge ────────────────────────────────────────────────────────────

const STATE_COLORS: Record<GoalState, string> = {
  active: 'bg-green-100 text-green-800',
  pausing: 'bg-amber-100 text-amber-800',
  paused: 'bg-gray-100 text-gray-700',
  recovering: 'bg-blue-100 text-blue-800',
  completed: 'bg-teal-100 text-teal-800',
  failed: 'bg-red-100 text-red-800',
  cancelled: 'bg-gray-100 text-gray-500',
};

const STATE_LABELS: Record<GoalState, string> = {
  active: 'Active',
  pausing: 'Pausing…',
  paused: 'Paused',
  recovering: 'Recovering',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export const GoalStateBadge: React.FC<{ state: GoalState }> = ({ state }) => (
  <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${STATE_COLORS[state] ?? 'bg-gray-100 text-gray-600'}`}>
    {STATE_LABELS[state] ?? state}
  </span>
);

// ─── Duration formatting ─────────────────────────────────────────────────────

export const formatDuration = (seconds: number): string => {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
};

export const formatTokens = (total: number): string => {
  if (total >= 1_000_000) return `${(total / 1_000_000).toFixed(1)}M`;
  if (total >= 1_000) return `${(total / 1_000).toFixed(1)}K`;
  return String(total);
};

// ─── Goal row ────────────────────────────────────────────────────────────────

export const GoalRow: React.FC<{ goal: GoalListItem }> = ({ goal }) => {
  const checklistPct =
    goal.checklistTotal > 0
      ? Math.round((goal.checklistCompleted / goal.checklistTotal) * 100)
      : 0;

  const modelDiffers =
    goal.effectiveModel && goal.effectiveModel !== goal.requestedModel;

  return (
    <Link
      to={`/goals/${goal.id}`}
      className="block hover:bg-gray-50 transition-colors border-b border-slate-100 last:border-0 bg-white group"
      aria-label={`Goal: ${goal.objective}`}
    >
      <div className="px-4 sm:px-6 py-4">
        {/* Top row: objective + state */}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-gray-900 truncate group-hover:text-primary-700">
              {goal.objective}
            </p>
            <p className="text-xs text-gray-500 mt-0.5 truncate">{goal.repository}</p>
          </div>
          <div className="flex-shrink-0 flex items-center gap-2">
            <GoalStateBadge state={goal.state} />
            {goal.epicPrUrl && (
              <a
                href={goal.epicPrUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={e => e.stopPropagation()}
                className="text-gray-400 hover:text-primary-600"
                title="Epic PR"
                aria-label="View epic pull request"
              >
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
            )}
          </div>
        </div>

        {/* Checklist progress */}
        {goal.checklistTotal > 0 && (
          <div className="mt-2">
            <div className="flex items-center gap-2">
              <CheckSquare className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />
              <div className="flex-1 bg-gray-200 rounded-full h-1.5">
                <div
                  className="bg-teal-500 h-1.5 rounded-full transition-all"
                  style={{ width: `${checklistPct}%` }}
                />
              </div>
              <span className="text-xs text-gray-500 tabular-nums flex-shrink-0">
                {goal.checklistCompleted}/{goal.checklistTotal}
              </span>
            </div>
          </div>
        )}

        {/* Stats row */}
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-500">
          {/* Agent + model */}
          <span className="flex items-center gap-1">
            <Zap className="w-3 h-3" />
            <span>{goal.agentAlias}</span>
            {modelDiffers ? (
              <span title={`Requested: ${goal.requestedModel}`}>
                <span className="text-gray-400 line-through">{goal.requestedModel}</span>
                {' → '}
                <span className="text-gray-700">{goal.effectiveModel}</span>
              </span>
            ) : (
              <span>{goal.requestedModel}</span>
            )}
          </span>

          {/* Active tasks */}
          {goal.activeTasks > 0 && (
            <span className="flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-green-500 inline-block" />
              {goal.activeTasks} active
            </span>
          )}

          {/* Issues processed/active/failed */}
          {goal.issuesProcessed > 0 && (
            <span>
              {goal.issuesProcessed} processed
              {goal.issuesFailed > 0 && (
                <span className="text-red-500 ml-1">· {goal.issuesFailed} failed</span>
              )}
              {goal.issuesBlocked > 0 && (
                <span className="text-amber-500 ml-1">· {goal.issuesBlocked} blocked</span>
              )}
            </span>
          )}

          {/* Tokens */}
          {goal.tokenTotal > 0 && (
            <span className="flex items-center gap-1">
              <Cpu className="w-3 h-3" />
              {formatTokens(goal.tokenTotal)}
            </span>
          )}

          {/* Elapsed time */}
          {goal.elapsedSeconds > 0 && (
            <span className="flex items-center gap-1">
              <Clock className="w-3 h-3" />
              {formatDuration(goal.elapsedSeconds)}
              {goal.pausedSeconds > 0 && (
                <span className="text-gray-400">
                  ({formatDuration(goal.pausedSeconds)} paused)
                </span>
              )}
            </span>
          )}

          {/* Auto-merge */}
          {goal.autoMergePolicy !== 'disabled' && (
            <span className="flex items-center gap-1" title={`Auto-merge: ${goal.autoMergePolicy}`}>
              <GitMerge className="w-3 h-3" />
              {goal.autoMergePolicy}
            </span>
          )}
        </div>

        {/* Latest event */}
        {goal.latestEvent && (
          <p className="mt-1.5 text-xs text-gray-400 truncate">{goal.latestEvent}</p>
        )}

        {/* Connection/recovery state */}
        {(goal.state === 'recovering' || goal.connectionState === 'disconnected') && (
          <p className="mt-1 text-xs text-amber-600">
            {goal.state === 'recovering' ? 'Recovering from interrupted run…' : 'Connection lost, retrying…'}
          </p>
        )}
      </div>
    </Link>
  );
};

// ─── Empty states ────────────────────────────────────────────────────────────

interface EmptyGoalsStateProps {
  type: 'no-goals' | 'no-filter-results' | 'no-search-results';
  searchQuery?: string;
  onCreateGoal: () => void;
  onClearFilter?: () => void;
  onClearSearch?: () => void;
}

export const EmptyGoalsState: React.FC<EmptyGoalsStateProps> = ({
  type,
  searchQuery,
  onCreateGoal,
  onClearFilter,
  onClearSearch,
}) => {
  if (type === 'no-goals') {
    return (
      <div className="text-center py-12 sm:py-20 mx-4 sm:mx-0 my-4 sm:my-6 bg-gray-50 rounded-lg border border-dashed border-gray-300">
        <Target className="mx-auto w-10 h-10 text-gray-300 mb-3" />
        <h3 className="text-sm font-semibold text-gray-700 mb-1">No goals yet</h3>
        <p className="text-sm text-gray-500 mb-4 max-w-xs mx-auto">
          Goals run an AI agent against a repository to produce an epic PR with sub-PRs.
        </p>
        <button
          type="button"
          onClick={onCreateGoal}
          className="inline-flex items-center gap-1.5 px-4 py-2 bg-teal-600 text-white text-sm font-medium rounded-md hover:bg-teal-700 transition-colors"
        >
          <Target className="w-4 h-4" />
          Create first goal
        </button>
      </div>
    );
  }

  if (type === 'no-search-results') {
    return (
      <div className="text-center py-12 sm:py-20 mx-4 sm:mx-0 my-4 sm:my-6 bg-gray-50 rounded-lg border border-dashed border-gray-300">
        <p className="text-sm font-semibold text-gray-700 mb-1">No results for "{searchQuery}"</p>
        <p className="text-sm text-gray-500 mb-4">Try a different search or clear the filter.</p>
        <div className="flex items-center justify-center gap-2">
          {onClearSearch && (
            <button
              type="button"
              onClick={onClearSearch}
              className="px-3 py-1.5 text-sm text-gray-600 border border-gray-300 rounded-md hover:bg-gray-50"
            >
              Clear search
            </button>
          )}
          <button
            type="button"
            onClick={onCreateGoal}
            className="px-3 py-1.5 text-sm text-white bg-teal-600 rounded-md hover:bg-teal-700"
          >
            New goal
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="text-center py-12 sm:py-20 mx-4 sm:mx-0 my-4 sm:my-6 bg-gray-50 rounded-lg border border-dashed border-gray-300">
      <p className="text-sm font-semibold text-gray-700 mb-1">No matching goals</p>
      <p className="text-sm text-gray-500 mb-4">Try adjusting the filters.</p>
      <div className="flex items-center justify-center gap-2">
        {onClearFilter && (
          <button
            type="button"
            onClick={onClearFilter}
            className="px-3 py-1.5 text-sm text-gray-600 border border-gray-300 rounded-md hover:bg-gray-50"
          >
            Clear filters
          </button>
        )}
        <button
          type="button"
          onClick={onCreateGoal}
          className="px-3 py-1.5 text-sm text-white bg-teal-600 rounded-md hover:bg-teal-700"
        >
          New goal
        </button>
      </div>
    </div>
  );
};

// ─── Goals table/list ────────────────────────────────────────────────────────

export const GoalsList: React.FC<{ goals: GoalListItem[] }> = ({ goals }) => (
  <div className="rounded-lg border border-gray-200 overflow-hidden">
    {goals.map(goal => (
      <GoalRow key={goal.id} goal={goal} />
    ))}
  </div>
);

// ─── Pagination ──────────────────────────────────────────────────────────────

interface PaginationControlsProps {
  currentPage: number;
  totalPages: number;
  totalGoals: number;
  pageSize: number;
  hasMore: boolean;
  loading: boolean;
  onPageChange: (page: number) => void;
}

export const GoalsPagination: React.FC<PaginationControlsProps> = ({
  currentPage,
  totalPages,
  totalGoals,
  pageSize,
  hasMore,
  loading,
  onPageChange,
}) => {
  const start = (currentPage - 1) * pageSize + 1;
  const end = Math.min(currentPage * pageSize, totalGoals);

  return (
    <div className="flex items-center justify-between px-4 sm:px-6 py-3 text-sm text-gray-600">
      <span>{totalGoals > 0 ? `${start}–${end} of ${totalGoals}` : '0 goals'}</span>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => onPageChange(currentPage - 1)}
          disabled={currentPage <= 1 || loading}
          aria-label="Previous page"
          className="p-1.5 rounded hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        <span className="px-2 tabular-nums">{currentPage} / {totalPages}</span>
        <button
          type="button"
          onClick={() => onPageChange(currentPage + 1)}
          disabled={!hasMore || currentPage >= totalPages || loading}
          aria-label="Next page"
          className="p-1.5 rounded hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
