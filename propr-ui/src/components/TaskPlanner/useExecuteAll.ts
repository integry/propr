import { useCallback, useMemo } from 'react';
import type { AgentModelPair, PlanIssue } from '../../api/planIssuesApi';

const IDLE_STATUSES = new Set<PlanIssue['status']>(['pending', 'merged', 'closed']);

/**
 * With work in flight the server queues every pending issue behind it and starts each in turn,
 * so nobody has to wait for the running task before queueing the backlog. An idle plan starts
 * its earliest pending issue, which heads the new queue.
 */
export function useExecuteAll(options: {
  issues: PlanIssue[];
  executionIntent: { canExecute: boolean; issue: PlanIssue | null; models?: AgentModelPair[] };
  isReadOnly: boolean;
  isSavingExecutionSettings: boolean;
  implementingIssue: number | null;
  queueingRemaining: boolean;
  handleImplementIssue: (issueNumber: number, models?: AgentModelPair[]) => Promise<void>;
  handleQueueRemaining: () => Promise<void>;
}) {
  const { issues, executionIntent, isReadOnly, handleImplementIssue, handleQueueRemaining } = options;
  // Running or in-review issues hold the plan's sequence; pending work queues behind them.
  const hasInFlightIssues = useMemo(() => issues.some(issue => !IDLE_STATUSES.has(issue.status)), [issues]);
  const handleExecuteAll = useCallback(() => {
    if (isReadOnly) return;
    if (hasInFlightIssues) {
      void handleQueueRemaining();
      return;
    }
    if (!executionIntent.canExecute || !executionIntent.issue) return;
    void handleImplementIssue(executionIntent.issue.issue_number, executionIntent.models);
  }, [executionIntent, handleImplementIssue, handleQueueRemaining, hasInFlightIssues, isReadOnly]);
  return {
    hasInFlightIssues,
    handleExecuteAll,
    batchLocked: isReadOnly || options.isSavingExecutionSettings,
    batchBusy: options.implementingIssue !== null || options.queueingRemaining,
  };
}
