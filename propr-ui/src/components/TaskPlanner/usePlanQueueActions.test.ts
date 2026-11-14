import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { PlanExecutionQueue } from '../../api/planIssuesApi';

const api = vi.hoisted(() => ({ skip: vi.fn(), retry: vi.fn() }));
const socket = vi.hoisted(() => ({ listeners: [] as Array<(payload: unknown) => void> }));
vi.mock('../../api/planIssuesApi', async importOriginal => ({
  ...(await importOriginal<typeof import('../../api/planIssuesApi')>()),
  skipPlanQueueIssue: api.skip,
  retryPlanQueueIssue: api.retry,
}));
vi.mock('../../contexts/useSocket', () => ({ useSocket: () => ({
  isConnected: true,
  onActivityUpdate: (listener: (payload: unknown) => void) => { socket.listeners.push(listener); return () => {}; },
  subscribeToActivity: () => {}, unsubscribeFromActivity: () => {},
}) }));

const { usePlanQueueActions } = await import('./usePlanQueueActions');

const queue: PlanExecutionQueue = {
  executionId: 'exec-1', issues: [1, 2, 3], cursor: 0, head: null, status: 'active', blockedReason: null, executionMode: 'graph', maxParallel: 2,
  issueStates: [
    { issue: 1, state: 'blocked', blockedKind: 'dispatch_failed', blockedReason: 'Could not start issue #1', schedule: 'blocked', dependsOn: [], waitingOn: [] },
    { issue: 2, state: 'pending', blockedKind: null, blockedReason: null, schedule: 'waiting', dependsOn: [1], waitingOn: [1] },
    { issue: 3, state: 'pending', blockedKind: null, blockedReason: null, schedule: 'waiting', dependsOn: [1], waitingOn: [1] },
  ],
};

describe('Planner Studio queue actions', () => {
  beforeEach(() => { api.skip.mockReset(); api.retry.mockReset(); socket.listeners.length = 0; });

  test('rows get their queue state and graph dependents; actions name the execution and the observed state', async () => {
    const setExecutionQueue = vi.fn();
    const refresh = vi.fn(async () => {});
    api.retry.mockResolvedValue({ outcome: 'retried', executionId: 'exec-1', issueNumber: 1, queue: { ...queue, status: 'active' } });
    api.skip.mockResolvedValue({ outcome: 'skipped', executionId: 'exec-1', issueNumber: 1, queue: null });
    const { result } = renderHook(() => usePlanQueueActions({ draftId: 'draft', executionQueue: queue, setExecutionQueue, refresh, setError: vi.fn() }));
    expect(result.current.rowProps(1, false).queueState?.blockedKind).toBe('dispatch_failed');
    expect(result.current.rowProps(1, false).queueDependents).toEqual([2, 3]);
    expect(result.current.rowProps(1, true).onQueueAction).toBeUndefined();
    await act(async () => { await result.current.runAction(1, 'retry'); });
    expect(api.retry).toHaveBeenCalledWith('draft', 1, { executionId: 'exec-1', expectedState: 'blocked' });
    await act(async () => { await result.current.runAction(1, 'skip_release'); });
    expect(api.skip).toHaveBeenCalledWith('draft', 1, { executionId: 'exec-1', expectedState: 'blocked', satisfiesDependents: true });
    expect(setExecutionQueue).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  test('a refused action surfaces its error and rereads the queue', async () => {
    const setError = vi.fn();
    const refresh = vi.fn(async () => {});
    api.skip.mockRejectedValue(new Error('Issue #1 is in flight; wait for its run to finish or block.'));
    const { result } = renderHook(() => usePlanQueueActions({ draftId: 'draft', executionQueue: queue, setExecutionQueue: vi.fn(), refresh, setError }));
    await act(async () => { await result.current.runAction(1, 'skip'); });
    expect(setError).toHaveBeenCalledWith('Issue #1 is in flight; wait for its run to finish or block.');
    expect(refresh).toHaveBeenCalled();
    expect(result.current.pendingAction).toBeNull();
  });

  test('a blocked activity frame for this plan refreshes the rows without a reload', async () => {
    const refresh = vi.fn(async () => {});
    renderHook(() => usePlanQueueActions({ draftId: 'draft', executionQueue: queue, setExecutionQueue: vi.fn(), refresh, setError: vi.fn() }));
    act(() => {
      for (const listener of socket.listeners) {
        listener({ domain: 'plan', change: 'blocked', entityId: 'other', repository: 'acme/repo' });
        listener({ domain: 'task', change: 'blocked', entityId: 'draft', repository: 'acme/repo' });
        listener({ domain: 'plan', change: 'blocked', entityId: 'draft', repository: 'acme/repo' });
      }
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
