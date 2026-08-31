import {
  CheckSquare,
  ChevronLeft,
  ChevronRight,
  Clock,
  Cpu,
  ExternalLink,
  GitMerge,
  Target,
  Zap,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import type { GoalListItem, GoalState } from '../api/goalsApi';
import { formatDuration, formatTokens, GOAL_STATE_COLORS, GOAL_STATE_LABELS } from './goalsPageUtils';

export const GoalStateBadge = ({ state }: { state: GoalState }) => (
  <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${GOAL_STATE_COLORS[state]}`}>
    {GOAL_STATE_LABELS[state]}
  </span>
);

const GoalModels = ({ goal }: { goal: GoalListItem }) => (
  <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
    <Zap className="h-3 w-3" aria-hidden="true" />
    <span>{goal.agent}</span>
    <span className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-600">Requested: {goal.requestedModel}</span>
    <span className={`rounded px-1.5 py-0.5 ${goal.effectiveModel !== goal.requestedModel ? 'bg-blue-100 font-medium text-blue-800' : 'bg-slate-100 text-slate-600'}`}>
      Effective: {goal.effectiveModel}
    </span>
  </span>
);

const ProjectedStats = ({ goal }: { goal: GoalListItem }) => {
  if (goal.projection.status === 'not-yet-projected') {
    return <span className="text-slate-400">Detailed statistics are not yet projected.</span>;
  }
  const { issues, pullRequests, time, tokens } = goal.projection;
  return (
    <>
      <span>{issues.processed} processed · {issues.active} active · {issues.failed} failed · {issues.blocked} blocked</span>
      <span>{pullRequests.open} open PRs · {pullRequests.mergeReady} merge-ready · {pullRequests.merged} merged</span>
      <span className="flex items-center gap-1"><Cpu className="h-3 w-3" aria-hidden="true" />{formatTokens(tokens.total)} tokens</span>
      <span className="flex items-center gap-1">
        <Clock className="h-3 w-3" aria-hidden="true" />
        {formatDuration(time.elapsedSeconds)} elapsed · {formatDuration(time.activeSeconds)} active · {formatDuration(time.pausedSeconds)} paused
      </span>
    </>
  );
};

const GoalStats = ({ goal }: { goal: GoalListItem }) => (
  <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-500">
    <GoalModels goal={goal} />
    <span>{goal.activeNodeCount} active work items · {goal.nodeCount} total</span>
    <ProjectedStats goal={goal} />
    {goal.mergePolicy !== 'manual' && <span className="flex items-center gap-1"><GitMerge className="h-3 w-3" aria-hidden="true" />{goal.mergePolicy}</span>}
    <span>Concurrency: {goal.maxActiveTasks}</span>
    {goal.ultrafixEnabled && <span>Ultrafix · goal {goal.ultrafixGoal}/10 · max {goal.ultrafixMaxCycles}</span>}
  </div>
);

const ChecklistProgress = ({ goal }: { goal: GoalListItem }) => {
  if (goal.projection.status !== 'ready' || goal.projection.checklist.total === 0) return null;
  const { completed, total } = goal.projection.checklist;
  const percent = Math.round((completed / total) * 100);
  const label = `${completed} of ${total} checklist items completed`;
  return (
    <div className="mt-2 flex items-center gap-2">
      <CheckSquare className="h-3.5 w-3.5 flex-shrink-0 text-gray-400" aria-hidden="true" />
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={completed}
        aria-valuetext={`${percent}% complete`}
        className="h-1.5 flex-1 rounded-full bg-gray-200"
      >
        <div className="h-1.5 rounded-full bg-teal-500" style={{ width: `${percent}%` }} />
      </div>
      <span className="flex-shrink-0 text-xs tabular-nums text-gray-500">{completed}/{total}</span>
    </div>
  );
};

export const GoalRow = ({ goal }: { goal: GoalListItem }) => {
  const projection = goal.projection.status === 'ready' ? goal.projection : null;
  return (
    <article className="border-b border-slate-100 bg-white last:border-0">
      <div className="px-4 py-4 sm:px-6">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <Link to={`/goals/${encodeURIComponent(goal.goalId)}`} aria-label={`Open goal: ${goal.objective}`} className="block truncate rounded text-sm font-semibold text-gray-900 hover:text-teal-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500">{goal.objective}</Link>
            <p className="mt-0.5 truncate text-xs text-gray-500">{goal.repository}</p>
          </div>
          <div className="flex flex-shrink-0 items-center gap-2">
            <GoalStateBadge state={goal.state} />
            {projection?.epicPrUrl && (
              <a href={projection.epicPrUrl} target="_blank" rel="noopener noreferrer" className="rounded p-1 text-gray-400 hover:text-primary-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500" aria-label={`Open epic pull request for ${goal.objective}`}>
                <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              </a>
            )}
          </div>
        </div>
        <ChecklistProgress goal={goal} />
        <GoalStats goal={goal} />
        {projection?.latestEvent && <p className="mt-1.5 truncate text-xs text-gray-400">{projection.latestEvent}</p>}
        {(goal.state === 'recovering' || projection?.connectionState === 'disconnected' || projection?.connectionState === 'recovering') && (
          <p className="mt-1 text-xs text-amber-700">{goal.state === 'recovering' || projection?.connectionState === 'recovering' ? 'Recovering from interrupted run…' : 'Connection lost, retrying…'}</p>
        )}
      </div>
    </article>
  );
};

interface EmptyGoalsStateProps {
  type: 'no-goals' | 'no-filter-results' | 'no-search-results';
  searchQuery?: string;
  onCreateGoal: () => void;
  onClearFilter?: () => void;
  onClearSearch?: () => void;
  createDisabled?: boolean;
}

export const EmptyGoalsState = ({ type, searchQuery, onCreateGoal, onClearFilter, onClearSearch, createDisabled }: EmptyGoalsStateProps) => {
  if (type === 'no-goals') {
    return (
      <div className="mx-4 my-4 rounded-lg border border-dashed border-gray-300 bg-gray-50 py-12 text-center sm:mx-0 sm:my-6 sm:py-20">
        <Target className="mx-auto mb-3 h-10 w-10 text-gray-300" aria-hidden="true" />
        <h2 className="mb-1 text-sm font-semibold text-gray-700">No goals yet</h2>
        <p className="mx-auto mb-4 max-w-xs text-sm text-gray-500">Goals coordinate an agent across long-running repository work.</p>
        <button type="button" onClick={onCreateGoal} disabled={createDisabled} className="inline-flex items-center gap-1.5 rounded-md bg-teal-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"><Target className="h-4 w-4" aria-hidden="true" />Create first goal</button>
      </div>
    );
  }
  if (type === 'no-search-results') {
    return (
      <div className="my-4 rounded-lg border border-dashed border-gray-300 bg-gray-50 py-12 text-center sm:my-6 sm:py-20">
        <h2 className="mb-1 text-sm font-semibold text-gray-700">No results for “{searchQuery}”</h2>
        <p className="mb-4 text-sm text-gray-500">Try another search or clear it.</p>
        {onClearSearch && <button type="button" onClick={onClearSearch} className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-600">Clear search</button>}
      </div>
    );
  }
  return (
    <div className="my-4 rounded-lg border border-dashed border-gray-300 bg-gray-50 py-12 text-center sm:my-6 sm:py-20">
      <h2 className="mb-1 text-sm font-semibold text-gray-700">No matching goals</h2>
      <p className="mb-4 text-sm text-gray-500">Try adjusting the filters.</p>
      {onClearFilter && <button type="button" onClick={onClearFilter} className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-600">Clear filters</button>}
    </div>
  );
};

export const GoalsList = ({ goals }: { goals: GoalListItem[] }) => (
  <div className="overflow-hidden rounded-lg border border-gray-200">{goals.map(goal => <GoalRow key={goal.goalId} goal={goal} />)}</div>
);

interface PaginationControlsProps {
  currentPage: number;
  hasPrevious: boolean;
  hasNext: boolean;
  loading: boolean;
  onPrevious: () => void;
  onNext: () => void;
}

export const GoalsPagination = ({ currentPage, hasPrevious, hasNext, loading, onPrevious, onNext }: PaginationControlsProps) => (
  <nav aria-label="Goals pagination" className="flex items-center justify-between px-4 py-3 text-sm text-gray-600 sm:px-6">
    <span>Page {currentPage}</span>
    <div className="flex items-center gap-1">
      <button type="button" onClick={onPrevious} disabled={!hasPrevious || loading} aria-label="Previous page" className="rounded p-1.5 disabled:opacity-40"><ChevronLeft className="h-4 w-4" aria-hidden="true" /></button>
      <button type="button" onClick={onNext} disabled={!hasNext || loading} aria-label="Next page" className="rounded p-1.5 disabled:opacity-40"><ChevronRight className="h-4 w-4" aria-hidden="true" /></button>
    </div>
  </nav>
);
