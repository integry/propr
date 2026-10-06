import React from 'react';
import { Loader2, Play } from 'lucide-react';

interface ExecuteAllBarProps {
  remainingCount: number;
  taskCount: number;
  useEpic?: boolean;
  autoMerge?: boolean;
  /** Issues already running; the queue does not wait for them before it is accepted. */
  hasRunningIssues: boolean;
  canExecute: boolean;
  unavailableReason: string | null;
  executing: boolean;
  onExecuteAll: () => void;
}

/**
 * Returns why the batch cannot be queued, or null when the server will chain every remaining issue.
 * The epic queue and the auto-merge queue are the two server paths that advance through the plan
 * on their own; individual tasks without auto-merge must be dispatched one row at a time.
 * Running issues never block the batch: queueing hands the remaining tasks to the orchestrator
 * so nobody has to wait at the screen for the current ones to finish.
 */
function getBatchBlockedReason(options: {
  useEpic: boolean;
  autoMerge: boolean;
  unavailableReason: string | null;
}): string | null {
  if (!options.useEpic && !options.autoMerge) {
    return 'Individual tasks only chain automatically when auto-merge is enabled. Enable auto-merge or implement each task from its row.';
  }
  return options.unavailableReason;
}

export const ExecuteAllBar: React.FC<ExecuteAllBarProps> = ({
  remainingCount,
  taskCount,
  useEpic = false,
  autoMerge = false,
  hasRunningIssues,
  canExecute,
  unavailableReason,
  executing,
  onExecuteAll,
}) => {
  // Single-task plans run from their row; the batch control only applies to multi-issue plans
  if (remainingCount === 0 || taskCount < 2) return null;
  const blockedReason = getBatchBlockedReason({ useEpic, autoMerge, unavailableReason });
  const disabled = executing || !canExecute || blockedReason !== null;
  const taskLabel = `${remainingCount} ${remainingCount === 1 ? 'task' : 'tasks'}`;
  let summary = useEpic
    ? 'Runs each remaining issue in order and collects the PRs into one Epic PR.'
    : 'Runs each remaining issue in order, starting the next once the previous one finishes.';
  if (hasRunningIssues) summary = `${taskLabel} will be dispatched automatically as concurrency slots become available.`;

  return (
    <div className="flex flex-col gap-2 border-t border-slate-200 pt-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <p className="text-xs text-slate-500" data-testid="execute-all-hint">
        {blockedReason ?? summary}
      </p>
      <button
        type="button"
        onClick={onExecuteAll}
        disabled={disabled}
        className="inline-flex flex-shrink-0 items-center justify-center gap-2 rounded-md bg-primary-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-primary-700 disabled:cursor-not-allowed disabled:bg-slate-300"
      >
        {executing ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
        Queue Remaining ({taskLabel})
      </button>
    </div>
  );
};

export default ExecuteAllBar;
