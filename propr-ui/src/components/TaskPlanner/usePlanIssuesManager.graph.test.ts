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

  describe('"After" metadata follows the active execution, not the persisted graph', () => {
    const withPersisted = (dependsOn: Record<number, number[]>) => {
      state.issues = state.issues.map(entry => ({ ...entry, depends_on_issues: dependsOn[entry.issue_number] ?? [] }));
    };
    const rowFor = async (issueNumber: number) => {
      const { result } = renderHook(() => usePlanIssuesManager({ draftId: 'draft', tasks: [], useEpic: true }));
      await waitFor(() => expect(result.current.loading).toBe(false));
      const row = result.current.issues.find(entry => entry.issue_number === issueNumber)!;
      return result.current.queueRowProps(row, false);
    };

    test('a sequential execution shows its chain prerequisite though the persisted dependencies are empty', async () => {
      withPersisted({});
      state.queue = queue('sequential');
      const row = await rowFor(2);
      expect(row.dependsOn).toEqual([1]);
      expect(row.waitingOn).toEqual([1]);
    });

    test('a parallel execution enforces no edges, so persisted graph dependencies are not shown', async () => {
      withPersisted({ 2: [1], 3: [1] });
      const parallel = queue('parallel');
      state.queue = { ...parallel, issueStates: (parallel.issueStates ?? []).map(entry => ({ ...entry, dependsOn: [], waitingOn: [] })) };
      for (const issueNumber of [2, 3]) {
        const row = await rowFor(issueNumber);
        expect(row.dependsOn).toEqual([]);
        expect(row.waitingOn).toEqual([]);
      }
    });

    test('persisted dependencies are the fallback when the execution supplies none for the issue', async () => {
      withPersisted({ 4: [1] });
      state.queue = queue('graph');
      const row = await rowFor(4);
      expect(row.dependsOn).toEqual([1]);
      expect(row.waitingOn).toEqual([1]);
    });
  });
});
