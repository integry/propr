import React from 'react';
import { ListOrdered, Loader2, Play } from 'lucide-react';

interface ExecuteAllBarProps {
  /** Pending issues the execution queue does not own yet. */
  remainingCount: number;
  /** Pending issues already waiting in the execution queue. */
  queuedCount?: number;
  taskCount: number;
  useEpic?: boolean;
  autoMerge?: boolean;
  /** Issues in flight (running or in review). The batch then queues behind them instead of starting one now. */
  hasRunningIssues: boolean;
  canExecute: boolean;
  /** Demo (read-only) viewers cannot start or queue anything. */
  readOnly?: boolean;
  /** Read-only viewers and unsaved settings block both the start and the queue paths. */
  locked?: boolean;
  unavailableReason: string | null;
  executing: boolean;
  onExecuteAll: () => void;
}

/**
 * Returns why the batch cannot be queued, or null when the server will chain every remaining issue.
 * While issues run, the server queues the rest behind them, so only an idle plan needs a startable head.
 */
function getBatchBlockedReason(options: {
  readOnly: boolean;
  hasRunningIssues: boolean;
  unavailableReason: string | null;
}): string | null {
  if (options.readOnly) return 'Demo mode is read-only.';
  return options.hasRunningIssues ? null : options.unavailableReason;
}

function describeBatch(taskLabel: string, hasRunningIssues: boolean, useEpic: boolean): string {
  if (hasRunningIssues) return `Queues ${taskLabel} behind the running work. Each starts automatically as soon as the task ahead of it finishes.`;
  if (useEpic) return `Starts the first of ${taskLabel} now and runs the rest in order, collecting the PRs into one Epic PR.`;
  return `Starts the first of ${taskLabel} now and starts each next one once the previous one finishes.`;
}

const pluralTasks = (count: number) => `${count} ${count === 1 ? 'task' : 'tasks'}`;

/** "Remaining" only reads right once part of the plan has run; a fresh plan starts the whole batch. */
function getBatchButtonLabel(hasStarted: boolean, useEpic: boolean): string {
  if (hasStarted) return 'Queue Remaining';
  return useEpic ? 'Start Epic PR' : 'Start All';
}

export const ExecuteAllBar: React.FC<ExecuteAllBarProps> = ({
  remainingCount,
  queuedCount = 0,
  taskCount,
  useEpic = false,
  autoMerge = false,
  hasRunningIssues,
  canExecute,
  readOnly = false,
  locked = false,
  unavailableReason,
  executing,
  onExecuteAll,
}) => {
  // Single-task plans run from their row; the batch control only applies to multi-issue plans
  if (remainingCount + queuedCount === 0 || taskCount < 2) return null;

  if (remainingCount === 0) {
    return (
      <div className="flex items-center gap-2 border-t border-slate-200 pt-3 text-xs text-slate-500" data-testid="execute-all-hint">
        <ListOrdered size={14} className="flex-shrink-0 text-slate-400" />
        {pluralTasks(queuedCount)} queued. Each starts automatically when the task ahead of it finishes.
      </div>
    );
  }

  // The epic queue and the auto-merge queue are the only server paths that advance through the plan
  // on their own; without either, each task starts from its row, so there is no batch to offer.
  if (!useEpic && !autoMerge) {
    return (
      <div className="flex items-center gap-2 border-t border-slate-200 pt-3 text-xs text-slate-500" data-testid="execute-all-hint">
        <ListOrdered size={14} className="flex-shrink-0 text-slate-400" />
        Enable auto-merge or Epic PR to queue the remaining tasks.
      </div>
    );
  }

  const blockedReason = getBatchBlockedReason({ readOnly, hasRunningIssues, unavailableReason });
  const disabled = executing || readOnly || locked || blockedReason !== null || (!hasRunningIssues && !canExecute);
  const taskLabel = pluralTasks(remainingCount);
  const summary = describeBatch(taskLabel, hasRunningIssues, useEpic);
  const hasStarted = hasRunningIssues || remainingCount < taskCount;

  return (
    // On a phone the matrix runs past the fold, so the batch action pins to the bottom of the scroll area.
    <div className="sticky -bottom-4 z-10 -mx-4 flex flex-col gap-2 border-t border-slate-200 bg-white px-4 py-3 shadow-[0_-4px_8px_-6px_rgba(15,23,42,0.15)] sm:static sm:mx-0 sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:px-0 sm:pb-0 sm:shadow-none" data-testid="execute-all-bar">
      <p className="text-xs text-slate-500" data-testid="execute-all-hint">
        {blockedReason ?? summary}
      </p>
      <button
        type="button"
        onClick={onExecuteAll}
        disabled={disabled}
        title={readOnly ? 'Demo mode is read-only' : undefined}
        className="inline-flex w-full flex-shrink-0 items-center justify-center gap-2 rounded-md bg-primary-600 px-4 py-2.5 text-sm sm:w-auto sm:py-2 font-medium text-white shadow-sm transition-colors hover:bg-primary-700 disabled:cursor-not-allowed disabled:bg-slate-300"
      >
        {executing ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
        {getBatchButtonLabel(hasStarted, useEpic)} ({taskLabel})
      </button>
    </div>
  );
};

export default ExecuteAllBar;
