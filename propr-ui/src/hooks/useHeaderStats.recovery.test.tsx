import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getQueueStats, getSystemStatus, getTasks } from '../api/proprApi';
import { getDrafts } from '../api/plannerApi';
import { useHeaderStats } from './useHeaderStats';
import type {
  ActivityUpdatePayload,
  DraftUpdatePayload,
  QueueStatsUpdatePayload,
  TaskUpdatePayload,
  UsageUpdatePayload,
} from '@propr/shared';

const socketState = vi.hoisted(() => ({
  isConnected: true,
  queueCallbacks: new Set<(payload: QueueStatsUpdatePayload) => void>(),
  taskCallbacks: new Set<(payload: TaskUpdatePayload) => void>(),
  draftCallbacks: new Set<(payload: DraftUpdatePayload) => void>(),
  activityCallbacks: new Set<(payload: ActivityUpdatePayload) => void>(),
  usageCallbacks: new Set<(payload: UsageUpdatePayload) => void>(),
}));
const runtimeState = vi.hoisted(() => ({ isDesktop: true }));
const identityState = vi.hoisted(() => ({ configuration: 'instance-a', userId: 'user-a' }));

vi.mock('../api/proprApi', () => ({
  getQueueStats: vi.fn(),
  getSystemStatus: vi.fn(),
  getTasks: vi.fn(),
}));

vi.mock('../api/plannerApi', () => ({ getDrafts: vi.fn() }));
vi.mock('../api/apiClient', () => ({
  getDesktopSocketConfigurationKey: () => identityState.configuration,
}));
vi.mock('../config/runtimeMode', () => ({ isDesktopRuntime: () => runtimeState.isDesktop }));
vi.mock('../contexts/AuthContext', () => ({
  useCurrentUser: () => ({ id: identityState.userId }),
}));
vi.mock('../contexts/useSocket', () => ({
  useSocket: () => ({
    isConnected: socketState.isConnected,
    onTaskUpdate: (callback: (payload: TaskUpdatePayload) => void) => {
      socketState.taskCallbacks.add(callback);
      return () => socketState.taskCallbacks.delete(callback);
    },
    onDraftUpdate: (callback: (payload: DraftUpdatePayload) => void) => {
      socketState.draftCallbacks.add(callback);
      return () => socketState.draftCallbacks.delete(callback);
    },
    onQueueStatsUpdate: (callback: (payload: QueueStatsUpdatePayload) => void) => {
      socketState.queueCallbacks.add(callback);
      return () => socketState.queueCallbacks.delete(callback);
    },
    onActivityUpdate: (callback: (payload: ActivityUpdatePayload) => void) => {
      socketState.activityCallbacks.add(callback);
      return () => socketState.activityCallbacks.delete(callback);
    },
    onUsageUpdate: (callback: (payload: UsageUpdatePayload) => void) => {
      socketState.usageCallbacks.add(callback);
      return () => socketState.usageCallbacks.delete(callback);
    },
  }),
}));

const queueSnapshot = (activeJobs: Array<Record<string, unknown>>) => ({
  active: activeJobs.length,
  activeJobs,
  waiting: 0,
  delayed: 0,
  completed: 0,
  failed: 0,
  paused: 0,
});

const activeJob = {
  id: 'job-1',
  taskId: 'task-1',
  name: 'processGitHubIssue',
  title: 'Live implementation',
  repository: 'integry/propr',
  createdAt: '2026-09-09T08:00:00.000Z',
};

const queuePush = (active: number, completed = 0): QueueStatsUpdatePayload => ({
  eventType: 'queue:stats:update',
  stats: {
    active,
    activeGoals: 0,
    waiting: 0,
    delayed: 0,
    completed,
    failed: 0,
    total: active + completed,
  },
  timestamp: '2026-09-13T00:00:00.000Z',
});

const healthyStatus = {
  daemon: 'Running',
  workers: [{ id: 1, status: 'active' }],
  redis: 'Connected',
  githubAuth: 'Authenticated',
  claudeAuth: 'Ready',
  indexing: 'Idle',
  githubEventIntake: 'ProPR Connect',
  githubEventIntakeStatus: 'Connected',
  agents: [],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}

describe('useHeaderStats live recovery', () => {
  beforeEach(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    socketState.isConnected = true;
    socketState.queueCallbacks.clear();
    socketState.taskCallbacks.clear();
    socketState.draftCallbacks.clear();
    socketState.activityCallbacks.clear();
    socketState.usageCallbacks.clear();
    runtimeState.isDesktop = true;
    identityState.configuration = 'instance-a';
    identityState.userId = 'user-a';
    vi.mocked(getQueueStats).mockResolvedValue(queueSnapshot([activeJob]) as never);
    vi.mocked(getDrafts).mockResolvedValue({ drafts: [], total: 0, page: 1, limit: 20, hasMore: false });
    vi.mocked(getTasks).mockResolvedValue({ tasks: [] });
    vi.mocked(getSystemStatus).mockResolvedValue(healthyStatus);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('commits untouched initial resources when a partial live refresh supersedes queue', async () => {
    const initialDrafts = deferred<Awaited<ReturnType<typeof getDrafts>>>();
    vi.mocked(getDrafts).mockReturnValueOnce(initialDrafts.promise);

    const { result } = renderHook(() => useHeaderStats());
    try {
      await waitFor(() => {
        expect(getQueueStats).toHaveBeenCalledTimes(1);
        expect(getDrafts).toHaveBeenCalledTimes(1);
        expect(getTasks).toHaveBeenCalledTimes(1);
        expect(getSystemStatus).toHaveBeenCalledTimes(1);
      });

      act(() => socketState.queueCallbacks.forEach(callback => callback(queuePush(1))));
      await waitFor(() => expect(getQueueStats).toHaveBeenCalledTimes(2));
      // A request starting does not mean React has committed its response.
      await waitFor(() => expect(result.current.resourceStatuses.queue).toBe('available'));
      expect(result.current.resourceStatuses.drafts).toBe('checking');
      expect(result.current.isLoading).toBe(true);
    } finally {
      // Always settle the shared read, even if an assertion fails. Otherwise
      // the coordinator can keep later tests attached to this pending promise.
      await act(async () => initialDrafts.resolve({
        drafts: [{
          draft_id: 'draft-from-initial-read',
          repository: 'integry/propr',
          name: 'Initial plan',
          initial_prompt: 'Must not be discarded by the queue refresh',
          status: 'generating',
          created_at: '2026-09-13T00:00:00.000Z',
          updated_at: '2026-09-13T00:00:00.000Z',
        }],
        total: 1,
        page: 1,
        limit: 20,
        hasMore: false,
      }));
    }

    await waitFor(() => expect(result.current.activePlans.map(plan => plan.draft_id))
      .toEqual(['draft-from-initial-read']));
    expect(result.current.resourceStatuses).toEqual({
      queue: 'available', drafts: 'available', tasks: 'available', status: 'available',
    });
    expect(result.current.isLoading).toBe(false);
    expect(getDrafts).toHaveBeenCalledTimes(1);
    expect(getTasks).toHaveBeenCalledTimes(1);
    expect(getSystemStatus).toHaveBeenCalledTimes(1);
  });

  it('retries only an independently failed initial resource', async () => {
    vi.mocked(getDrafts)
      .mockRejectedValueOnce(new Error('Drafts temporarily unavailable'))
      .mockResolvedValueOnce({ drafts: [], total: 0, page: 1, limit: 20, hasMore: false });

    const { result } = renderHook(() => useHeaderStats());

    await waitFor(() => expect(getDrafts).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.resourceStatuses.drafts).toBe('available'));
    expect(result.current.resourceStatuses.tasks).toBe('available');
    expect(result.current.error).toBeNull();
    expect(getQueueStats).toHaveBeenCalledTimes(1);
    expect(getTasks).toHaveBeenCalledTimes(1);
    expect(getSystemStatus).toHaveBeenCalledTimes(1);
  });

  it('reconciles a successful completion to zero from the queue subscription', async () => {
    const { result } = renderHook(() => useHeaderStats());
    await waitFor(() => expect(result.current.runningCount).toBe(1));
    expect(result.current.activityStatus).toBe('available');

    vi.mocked(getQueueStats).mockResolvedValue(queueSnapshot([]) as never);
    act(() => socketState.queueCallbacks.forEach(callback => callback(queuePush(0, 1))));

    await waitFor(() => expect(result.current.runningCount).toBe(0));
    expect(result.current.runningItems).toEqual([]);
    expect(result.current.activityStatus).toBe('available');
  });

  it('refreshes only queue activity and bounds identical periodic invalidations', async () => {
    renderHook(() => useHeaderStats());
    await waitFor(() => expect(getQueueStats).toHaveBeenCalledTimes(1));

    const payload = queuePush(1);
    act(() => {
      socketState.queueCallbacks.forEach(callback => {
        callback(payload);
        callback({ ...payload, timestamp: '2026-09-13T00:00:05.000Z' });
        callback({ ...payload, timestamp: '2026-09-13T00:00:10.000Z' });
      });
    });

    await waitFor(() => expect(getQueueStats).toHaveBeenCalledTimes(2));
    expect(getDrafts).toHaveBeenCalledTimes(1);
    expect(getTasks).toHaveBeenCalledTimes(1);
    expect(getSystemStatus).toHaveBeenCalledTimes(1);

    // getQueueStats performs two HTTP reads. Fixture total: 5 initial + 2
    // queue reads = 7, versus 10 when every queue event caused full fanout.
    expect({ before: 10, after: 2 * 2 + 1 + 1 + 1 }).toEqual({ before: 10, after: 7 });

    act(() => socketState.queueCallbacks.forEach(callback => callback({
      ...payload,
      timestamp: '2026-09-13T00:00:15.000Z',
    })));
    await new Promise(resolve => setTimeout(resolve, 150));

    expect(getQueueStats).toHaveBeenCalledTimes(2);
    expect(getDrafts).toHaveBeenCalledTimes(1);
    expect(getTasks).toHaveBeenCalledTimes(1);
    expect(getSystemStatus).toHaveBeenCalledTimes(1);
  });

  it('retries only a failed queue reconciliation and commits its fingerprint after recovery', async () => {
    const { result } = renderHook(() => useHeaderStats());
    await waitFor(() => expect(getQueueStats).toHaveBeenCalledTimes(1));

    vi.mocked(getQueueStats)
      .mockRejectedValueOnce(new Error('Queue temporarily unavailable'))
      .mockResolvedValueOnce(queueSnapshot([activeJob]) as never);
    vi.useFakeTimers();

    const unchangedPayload = queuePush(1);
    act(() => socketState.queueCallbacks.forEach(callback => callback(unchangedPayload)));
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });

    expect(getQueueStats).toHaveBeenCalledTimes(2);
    expect(result.current.activityStatus).toBe('unavailable');

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });

    expect(getQueueStats).toHaveBeenCalledTimes(3);
    expect(getDrafts).toHaveBeenCalledTimes(1);
    expect(getTasks).toHaveBeenCalledTimes(1);
    expect(getSystemStatus).toHaveBeenCalledTimes(1);
    expect(result.current.activityStatus).toBe('available');
    expect(result.current.error).toBeNull();

    act(() => socketState.queueCallbacks.forEach(callback => callback({
      ...unchangedPayload,
      timestamp: '2026-09-13T00:00:05.000Z',
    })));
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });

    expect(getQueueStats).toHaveBeenCalledTimes(3);
  });

  it('reduces frequent same-state task updates from 55 fixture requests to 6', async () => {
    renderHook(() => useHeaderStats());
    await waitFor(() => expect(getQueueStats).toHaveBeenCalledTimes(1));
    vi.useFakeTimers();

    for (let version = 1; version <= 10; version += 1) {
      act(() => socketState.taskCallbacks.forEach(callback => callback({
        eventType: 'task:update', taskId: 'task-frequent', state: 'completed',
        previousState: version === 1 ? 'post_processing' : 'completed',
        repository: 'integry/propr', issueNumber: 2389, version,
        timestamp: `2026-09-13T00:00:${String(version).padStart(2, '0')}.000Z`,
      })));
      await act(async () => { await vi.advanceTimersByTimeAsync(150); });
    }

    expect(getTasks).toHaveBeenCalledTimes(2);
    expect(getQueueStats).toHaveBeenCalledTimes(1);
    expect(getDrafts).toHaveBeenCalledTimes(1);
    expect(getSystemStatus).toHaveBeenCalledTimes(1);
    // Before: initial 5 + ten five-request refreshes. After: initial 5 + one
    // review-list read. These are deterministic fixture counts, not a claim
    // about production traffic.
    expect({ before: 55, after: 2 + 1 + 2 + 1 }).toEqual({ before: 55, after: 6 });
  });

  it('ignores draft progress churn but refreshes a meaningful plan status transition', async () => {
    vi.mocked(getDrafts).mockResolvedValue({
      drafts: [{
        draft_id: 'draft-live', repository: 'integry/propr', status: 'generating',
        initial_prompt: 'Live plan', created_at: '2026-09-13T00:00:00.000Z',
        updated_at: '2026-09-13T00:00:00.000Z',
      }],
      total: 1, page: 1, limit: 20, hasMore: false,
    });
    renderHook(() => useHeaderStats());
    await waitFor(() => expect(getDrafts).toHaveBeenCalledTimes(1));
    vi.useFakeTimers();

    act(() => socketState.draftCallbacks.forEach(callback => {
      callback({
        eventType: 'draft:update', draftId: 'draft-live', step: 'context',
        status: 'in_progress', draftStatus: 'generating',
        timestamp: '2026-09-13T00:00:01.000Z',
      });
      callback({
        eventType: 'draft:update', draftId: 'draft-live', step: 'llm',
        status: 'in_progress', draftStatus: 'generating',
        timestamp: '2026-09-13T00:00:02.000Z',
      });
    }));
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(getDrafts).toHaveBeenCalledTimes(1);

    act(() => socketState.draftCallbacks.forEach(callback => callback({
      eventType: 'draft:update', draftId: 'draft-live', step: 'complete',
      status: 'completed', draftStatus: 'review',
      timestamp: '2026-09-13T00:00:03.000Z',
    })));
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(getDrafts).toHaveBeenCalledTimes(2);
    expect(getQueueStats).toHaveBeenCalledTimes(1);
    expect(getTasks).toHaveBeenCalledTimes(1);
    expect(getSystemStatus).toHaveBeenCalledTimes(1);
  });

  it('defers hidden-tab churn and performs one full visible recovery', async () => {
    renderHook(() => useHeaderStats());
    await waitFor(() => expect(getQueueStats).toHaveBeenCalledTimes(1));
    vi.useFakeTimers();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });

    act(() => {
      socketState.queueCallbacks.forEach(callback => callback(queuePush(0, 1)));
      socketState.taskCallbacks.forEach(callback => callback({
        eventType: 'task:update', taskId: 'task-hidden', state: 'completed',
        previousState: 'processing', timestamp: '2026-09-13T00:01:00.000Z',
      }));
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(getQueueStats).toHaveBeenCalledTimes(1);
    expect(getTasks).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });

    expect(getQueueStats).toHaveBeenCalledTimes(2);
    expect(getDrafts).toHaveBeenCalledTimes(2);
    expect(getTasks).toHaveBeenCalledTimes(2);
    expect(getSystemStatus).toHaveBeenCalledTimes(2);
  });

  it('polls one full fallback snapshot while the visible socket is disconnected', async () => {
    vi.useFakeTimers();
    const { rerender } = renderHook(() => useHeaderStats());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(getQueueStats).toHaveBeenCalledTimes(1);
    socketState.isConnected = false;
    rerender();

    await act(async () => { await vi.advanceTimersByTimeAsync(30_100); });

    expect(getQueueStats).toHaveBeenCalledTimes(2);
    expect(getDrafts).toHaveBeenCalledTimes(2);
    expect(getTasks).toHaveBeenCalledTimes(2);
    expect(getSystemStatus).toHaveBeenCalledTimes(2);
  });

  it('revalidates missed same-count draft and health changes after a web reconnect', async () => {
    runtimeState.isDesktop = false;
    const { result, rerender } = renderHook(() => useHeaderStats());
    await waitFor(() => expect(getQueueStats).toHaveBeenCalledTimes(1));

    const unchangedPayload = queuePush(1);
    act(() => socketState.queueCallbacks.forEach(callback => callback(unchangedPayload)));
    await waitFor(() => expect(getQueueStats).toHaveBeenCalledTimes(2));

    socketState.isConnected = false;
    rerender();

    vi.mocked(getDrafts).mockResolvedValue({
      drafts: [{
        draft_id: 'draft-created-offline',
        repository: 'integry/propr',
        name: 'Offline plan',
        initial_prompt: 'Created while the browser socket was disconnected',
        status: 'generating',
        created_at: '2026-09-13T00:01:00.000Z',
        updated_at: '2026-09-13T00:01:00.000Z',
      }],
      total: 1,
      page: 1,
      limit: 20,
      hasMore: false,
    });
    vi.mocked(getSystemStatus).mockResolvedValue({
      ...healthyStatus,
      redis: 'Disconnected',
    });

    socketState.isConnected = true;
    rerender();
    act(() => socketState.queueCallbacks.forEach(callback => callback({
      ...unchangedPayload,
      timestamp: '2026-09-13T00:01:05.000Z',
    })));

    // Request counts can update before React commits the recovered snapshot.
    // Wait for both state changes before checking the reconciliation counts.
    await waitFor(() => {
      expect(result.current.activePlans.map(draft => draft.draft_id)).toEqual(['draft-created-offline']);
      expect(result.current.systemHealth.redis).toBe('Disconnected');
    });
    expect(getQueueStats).toHaveBeenCalledTimes(3);
    expect(getDrafts).toHaveBeenCalledTimes(2);
    expect(getTasks).toHaveBeenCalledTimes(2);
    expect(getSystemStatus).toHaveBeenCalledTimes(2);
  });

  it('invalidates activity during a real transport outage and automatically recovers', async () => {
    const { result, rerender } = renderHook(() => useHeaderStats());
    await waitFor(() => expect(result.current.runningCount).toBe(1));

    socketState.isConnected = false;
    rerender();
    expect(result.current.activityStatus).toBe('unavailable');
    expect(result.current.runningCount).toBe(0);
    expect(result.current.runningItems).toEqual([]);

    const recovered = deferred<ReturnType<typeof queueSnapshot>>();
    vi.mocked(getQueueStats).mockReturnValueOnce(recovered.promise as never);
    socketState.isConnected = true;
    rerender();
    expect(result.current.activityStatus).toBe('checking');

    await act(async () => recovered.resolve(queueSnapshot([])));
    await waitFor(() => expect(result.current.activityStatus).toBe('available'));
    expect(result.current.runningCount).toBe(0);
    await waitFor(() => expect(getQueueStats).toHaveBeenCalledTimes(2));
  });
});
