import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { isChainExecution, type PlanExecutionQueue, type PlanIssue } from '../../api/planIssuesApi';

const state = vi.hoisted(() => ({ issues: [] as PlanIssue[], queue: null as PlanExecutionQueue | null }));

vi.mock('../../api/planIssuesApi', async importOriginal => ({
  ...(await importOriginal<typeof import('../../api/planIssuesApi')>()),
  getPlanIssues: vi.fn(async () => state.issues),
  getPlanExecutionQueue: vi.fn(async () => state.queue),
}));
vi.mock('../../api/proprApi', () => ({ getInstanceCatalog: vi.fn(async () => ({ agents: [], defaultAgentAlias: undefined })) }));
vi.mock('../../contexts/useSocket', () => ({ useSocket: () => ({
  isConnected: false, onTaskUpdate: () => () => {}, onDraftUpdate: () => () => {}, subscribeToDraft: () => {}, unsubscribeFromDraft: () => {},
}) }));

const { usePlanIssuesManager } = await import('./usePlanIssuesManager');

const issue = (issue_number: number, status: PlanIssue['status']) => ({ id: issue_number, draft_id: 'draft', issue_number, status,
  agent_alias: null, model_name: null, pr_number: null }) as unknown as PlanIssue;
const queue = (executionMode: PlanExecutionQueue['executionMode'], status: PlanExecutionQueue['status'] = 'active'): PlanExecutionQueue => ({
  issues: [1, 2, 3], cursor: 0, head: null, status, blockedReason: null, executionMode, maxParallel: 2,
  issueStates: [
    { issue: 1, state: 'dispatched', blockedKind: null, blockedReason: null, schedule: 'in_flight', dependsOn: [], waitingOn: [] },
    { issue: 2, state: 'pending', blockedKind: null, blockedReason: null, schedule: 'waiting', dependsOn: [1], waitingOn: [1] },
    { issue: 3, state: 'pending', blockedKind: null, blockedReason: null, schedule: 'ready', dependsOn: [], waitingOn: [] },
  ],
});

describe('graph executions in the Planner Studio issue list', () => {
  beforeEach(() => {
    state.issues = [issue(1, 'processing'), issue(2, 'pending'), issue(3, 'pending'), issue(4, 'pending')];
    state.queue = null;
  });

  test('only an active sequential execution (or none) is a chain', () => {
    expect(isChainExecution(null)).toBe(true);
    expect(isChainExecution(queue(undefined))).toBe(true);
    expect(isChainExecution(queue('sequential'))).toBe(true);
    expect(isChainExecution(queue('graph'))).toBe(false);
    expect(isChainExecution(queue('parallel'))).toBe(false);
    expect(isChainExecution(queue('graph', 'completed'))).toBe(true);
  });

  test('a graph execution presents no first-unmerged ordering warning, and its pending issues read as queued', async () => {
    state.queue = queue('graph');
    const { result } = renderHook(() => usePlanIssuesManager({ draftId: 'draft', tasks: [], useEpic: true }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.chainExecution).toBe(false);
    expect(result.current.getUnmergedIssuesBefore(4)).toEqual([]);
    expect([...result.current.queuedIssueNumbers].sort()).toEqual([2, 3]);
  });

  test('a sequential execution keeps its ordering warning', async () => {
    state.queue = queue('sequential');
    const { result } = renderHook(() => usePlanIssuesManager({ draftId: 'draft', tasks: [], useEpic: true }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.chainExecution).toBe(true);
    expect(result.current.getUnmergedIssuesBefore(4).map(entry => entry.issue_number)).toEqual([1, 2, 3]);
  });
});
