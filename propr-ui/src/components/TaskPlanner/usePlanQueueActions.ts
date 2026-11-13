import { useCallback, useEffect, useMemo, useState } from 'react';
import { retryPlanQueueIssue, skipPlanQueueIssue, type PlanExecutionQueue, type PlanExecutionQueueIssue } from '../../api/planIssuesApi';
import { useSocket } from '../../contexts/useSocket';

export type PlanQueueAction = 'skip' | 'skip_release' | 'retry';

interface UsePlanQueueActionsProps {
  draftId: string;
  executionQueue: PlanExecutionQueue | null;
  setExecutionQueue: (queue: PlanExecutionQueue | null) => void;
  refresh: () => Promise<void>;
  setError: (message: string | null) => void;
}

/**
 * Per-issue execution queue state for the Planner Studio rows, and the skip and retry
 * actions on them. A plan-domain activity frame for this plan (an issue became blocked,
 * or a blocker was resolved) refreshes the rows, so an open view shows the blocker
 * without a reload.
 */
export function usePlanQueueActions({ draftId, executionQueue, setExecutionQueue, refresh, setError }: UsePlanQueueActionsProps) {
  const [pendingAction, setPendingAction] = useState<{ issueNumber: number; action: PlanQueueAction } | null>(null);
  const { isConnected, onActivityUpdate, subscribeToActivity, unsubscribeFromActivity } = useSocket();

  const queueStates = useMemo(() => {
    const states = new Map<number, PlanExecutionQueueIssue>();
    if (executionQueue?.status !== 'active') return states;
    for (const state of executionQueue.issueStates ?? []) states.set(state.issue, state);
    return states;
  }, [executionQueue]);

  /** Issues of a graph execution that depend on each issue: a skip can release them. */
  const dependents = useMemo(() => {
    const byPrerequisite = new Map<number, number[]>();
    if (executionQueue?.executionMode !== 'graph') return byPrerequisite;
    for (const state of executionQueue.issueStates ?? []) {
      for (const prerequisite of state.dependsOn ?? []) byPrerequisite.set(prerequisite, [...(byPrerequisite.get(prerequisite) ?? []), state.issue]);
    }
    return byPrerequisite;
  }, [executionQueue]);

  const runAction = useCallback(async (issueNumber: number, action: PlanQueueAction) => {
    const state = queueStates.get(issueNumber);
    const executionId = executionQueue?.executionId;
    if (!state || !executionId) return;
    setPendingAction({ issueNumber, action });
    try {
      const result = action === 'retry'
        ? await retryPlanQueueIssue(draftId, issueNumber, { executionId, expectedState: state.state })
        : await skipPlanQueueIssue(draftId, issueNumber, { executionId, expectedState: state.state,
          ...(action === 'skip_release' ? { satisfiesDependents: true } : {}) });
      setExecutionQueue(result.queue);
      await refresh();
    } catch (err) {
      console.error(`Failed to ${action === 'retry' ? 'retry' : 'skip'} issue #${issueNumber}:`, err);
      setError(err instanceof Error && err.message ? err.message : `Failed to ${action === 'retry' ? 'retry' : 'skip'} issue #${issueNumber}`);
      await refresh().catch(() => undefined);
    } finally {
      setPendingAction(null);
    }
  }, [draftId, executionQueue?.executionId, queueStates, refresh, setError, setExecutionQueue]);

  useEffect(() => {
    if (!draftId || !isConnected || !onActivityUpdate) return;
    const unsubscribe = onActivityUpdate(payload => {
      // The server forwards the scoped activity envelope (entityId); the shell type names it subjectId.
      const frame = payload as unknown as { domain: string; change: string; entityId?: string; subjectId?: string };
      if (frame.domain === 'plan' && (frame.entityId ?? frame.subjectId) === draftId && (frame.change === 'blocked' || frame.change === 'progressed')) {
        void refresh().catch(() => undefined);
      }
    });
    subscribeToActivity?.();
    return () => { unsubscribe(); unsubscribeFromActivity?.(); };
  }, [draftId, isConnected, onActivityUpdate, subscribeToActivity, unsubscribeFromActivity, refresh]);

  /** Row props for one issue: its queue state and the actions on it (none for a read-only plan). */
  const rowProps = useCallback((issueNumber: number, readOnly: boolean) => ({
    queueState: queueStates.get(issueNumber),
    queueDependents: dependents.get(issueNumber),
    queueAction: pendingAction?.issueNumber === issueNumber ? pendingAction.action : null,
    onQueueAction: readOnly ? undefined : runAction,
  }), [queueStates, dependents, pendingAction, runAction]);

  return { queueStates, dependents, pendingAction, runAction, rowProps };
}
