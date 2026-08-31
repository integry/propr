import { Link } from 'react-router-dom';
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
import type { GoalListItem, GoalState } from '../api/goalsApi';
import {
  formatDuration,
  formatTokens,
  GOAL_STATE_COLORS,
  GOAL_STATE_LABELS,
} from './goalsPageUtils';

export const GoalStateBadge = ({ state }: { state: GoalState }) => (
  <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${GOAL_STATE_COLORS[state]}`}>
    {GOAL_STATE_LABELS[state]}
  </span>
);

const GoalModels = ({ goal }: { goal: GoalListItem }) => (
  <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
    <Zap className="h-3 w-3" aria-hidden="true" />
    <span>{goal.agentAlias}</span>
    <span className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-600">Requested: {goal.requestedModel}</span>
    <span className={`rounded px-1.5 py-0.5 ${goal.effectiveModel !== goal.requestedModel ? 'bg-blue-100 font-medium text-blue-800' : 'bg-slate-100 text-slate-600'}`}>
      Effective: {goal.effectiveModel}
    </span>
  </span>
);

const GoalStats = ({ goal }: { goal: GoalListItem }) => (
  <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-500">
    <GoalModels goal={goal} />
    {goal.activeTasks > 0 && <span><span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-green-500" />{goal.activeTasks} active tasks</span>}
    {(goal.issuesProcessed > 0 || goal.issuesActive > 0) && (
      <span>
        {goal.issuesProcessed} processed · {goal.issuesActive} active
        {goal.issuesFailed > 0 && <span className="ml-1 text-red-600">· {goal.issuesFailed} failed</span>}
        {goal.issuesBlocked > 0 && <span className="ml-1 text-amber-600">· {goal.issuesBlocked} blocked</span>}
      </span>
    )}
    {goal.tokenTotal > 0 && <span className="flex items-center gap-1"><Cpu className="h-3 w-3" aria-hidden="true" />{formatTokens(goal.tokenTotal)} tokens</span>}
    {goal.elapsedSeconds > 0 && (
      <span className="flex items-center gap-1">
        <Clock className="h-3 w-3" aria-hidden="true" />
        {formatDuration(goal.elapsedSeconds)}
        {goal.pausedSeconds > 0 && <span className="text-gray-400">({formatDuration(goal.pausedSeconds)} paused)</span>}
      </span>
    )}
    {goal.autoMergePolicy !== 'manual' && <span className="flex items-center gap-1"><GitMerge className="h-3 w-3" aria-hidden="true" />{goal.autoMergePolicy}</span>}
    <span>Concurrency: {goal.maxConcurrentTasks}</span>
    {goal.ultrafixEnabled && <span>Ultrafix{goal.ultrafixGoal ? ` · goal ${goal.ultrafixGoal}/10` : ''}{goal.ultrafixMaxCycles ? ` · max ${goal.ultrafixMaxCycles}` : ''}</span>}
  </div>
);

export const GoalRow = ({ goal }: { goal: GoalListItem }) => {
  const checklistPercent = goal.checklistTotal > 0
    ? Math.round((goal.checklistCompleted / goal.checklistTotal) * 100)
    : 0;
  return (
    <article className="group relative border-b border-slate-100 bg-white transition-colors last:border-0 hover:bg-gray-50">
      <Link to={`/goals/${goal.id}`} className="absolute inset-0 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500" aria-label={`Open goal: ${goal.objective}`} />
      <div className="pointer-events-none relative px-4 py-4 sm:px-6">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-gray-900 group-hover:text-primary-700">{goal.objective}</p>
            <p className="mt-0.5 truncate text-xs text-gray-500">{goal.repository}</p>
          </div>
          <div className="flex flex-shrink-0 items-center gap-2">
            <GoalStateBadge state={goal.state} />
            {goal.epicPrUrl && (
              <a
                href={goal.epicPrUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="pointer-events-auto relative z-10 rounded p-1 text-gray-400 hover:text-primary-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
                aria-label={`Open epic pull request for ${goal.objective}`}
              >
                <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              </a>
            )}
          </div>
        </div>
        {goal.checklistTotal > 0 && (
          <div className="mt-2 flex items-center gap-2" aria-label={`${goal.checklistCompleted} of ${goal.checklistTotal} checklist items completed`}>
            <CheckSquare className="h-3.5 w-3.5 flex-shrink-0 text-gray-400" aria-hidden="true" />
            <div className="h-1.5 flex-1 rounded-full bg-gray-200"><div className="h-1.5 rounded-full bg-teal-500" style={{ width: `${checklistPercent}%` }} /></div>
            <span className="flex-shrink-0 text-xs tabular-nums text-gray-500">{goal.checklistCompleted}/{goal.checklistTotal}</span>
          </div>
        )}
        <GoalStats goal={goal} />
        {goal.latestEvent && <p className="mt-1.5 truncate text-xs text-gray-400">{goal.latestEvent}</p>}
        {(goal.state === 'recovering' || goal.connectionState === 'disconnected') && (
          <p className="mt-1 text-xs text-amber-700">{goal.state === 'recovering' ? 'Recovering from interrupted run…' : 'Connection lost, retrying…'}</p>
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

export const EmptyGoalsState = ({
  type,
  searchQuery,
  onCreateGoal,
  onClearFilter,
  onClearSearch,
  createDisabled,
}: EmptyGoalsStateProps) => {
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
  <div className="overflow-hidden rounded-lg border border-gray-200">{goals.map(goal => <GoalRow key={goal.id} goal={goal} />)}</div>
);

interface PaginationControlsProps {
  currentPage: number;
  totalPages: number;
  totalGoals: number;
  pageSize: number;
  hasMore: boolean;
  loading: boolean;
  onPageChange: (page: number) => void;
}

export const GoalsPagination = ({ currentPage, totalPages, totalGoals, pageSize, hasMore, loading, onPageChange }: PaginationControlsProps) => {
  const start = (currentPage - 1) * pageSize + 1;
  const end = Math.min(currentPage * pageSize, totalGoals);
  return (
    <nav aria-label="Goals pagination" className="flex items-center justify-between px-4 py-3 text-sm text-gray-600 sm:px-6">
      <span>{totalGoals > 0 ? `${start}–${end} of ${totalGoals}` : '0 goals'}</span>
      <div className="flex items-center gap-1">
        <button type="button" onClick={() => onPageChange(currentPage - 1)} disabled={currentPage <= 1 || loading} aria-label="Previous page" className="rounded p-1.5 disabled:opacity-40"><ChevronLeft className="h-4 w-4" aria-hidden="true" /></button>
        <span className="px-2 tabular-nums">{currentPage} / {Math.max(totalPages, 1)}</span>
        <button type="button" onClick={() => onPageChange(currentPage + 1)} disabled={!hasMore || currentPage >= totalPages || loading} aria-label="Next page" className="rounded p-1.5 disabled:opacity-40"><ChevronRight className="h-4 w-4" aria-hidden="true" /></button>
      </div>
    </nav>
  );
};
