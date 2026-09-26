import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getQueueStats, getSystemStatus, getTasks } from '../api/proprApi';
import { getDrafts } from '../api/plannerApi';
import { useHeaderStats } from './useHeaderStats';
import type { ActivityUpdatePayload, UsageUpdatePayload } from '@propr/shared';

/**
 * The header is mounted on every page, so what it reads - and, more
 * importantly, what it does not read - is the whole point of the push
 * contract. Each resource refreshes because the change it cares about was
 * published, and an idle instance costs nothing.
 */

const socketState = vi.hoisted(() => ({
  isConnected: true,
  activityCallbacks: new Set<(payload: ActivityUpdatePayload) => void>(),
  usageCallbacks: new Set<(payload: UsageUpdatePayload) => void>(),
}));
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
vi.mock('../config/runtimeMode', () => ({ isDesktopRuntime: () => false }));
vi.mock('../contexts/AuthContext', () => ({
  useCurrentUser: () => ({ id: identityState.userId }),
}));
vi.mock('../contexts/useSocket', () => ({
  useSocket: () => ({
    isConnected: socketState.isConnected,
    onTaskUpdate: () => () => undefined,
    onDraftUpdate: () => () => undefined,
    onQueueStatsUpdate: () => () => undefined,
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

const activityPush = (
  domain: ActivityUpdatePayload['domain'],
  change: ActivityUpdatePayload['change'],
): ActivityUpdatePayload => ({
  eventType: 'activity:update',
  domain,
  change,
  occurredAt: '2026-09-13T00:00:00.000Z',
});

describe('useHeaderStats pushed changes', () => {
  beforeEach(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    socketState.isConnected = true;
    socketState.activityCallbacks.clear();
    socketState.usageCallbacks.clear();
    vi.mocked(getQueueStats).mockResolvedValue({
      active: 0, activeJobs: [], waiting: 0, delayed: 0, completed: 0, failed: 0, paused: 0,
    } as never);
    vi.mocked(getDrafts).mockResolvedValue({ drafts: [], total: 0, page: 1, limit: 20, hasMore: false });
    vi.mocked(getTasks).mockResolvedValue({ tasks: [] });
    vi.mocked(getSystemStatus).mockResolvedValue(healthyStatus as never);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('issues no read at all over an idle period while the socket is connected', async () => {
    // Install the fake clock before mounting so every timer the hook arms is
    // on it: a timer created beforehand would never fire here, and the
    // assertion would pass without meaning anything.
    vi.useFakeTimers();
    renderHook(() => useHeaderStats());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(getSystemStatus).toHaveBeenCalledTimes(1);

    // Five minutes of an idle instance: nothing changed, so nothing is read.
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000); });

    expect(getQueueStats).toHaveBeenCalledTimes(1);
    expect(getDrafts).toHaveBeenCalledTimes(1);
    expect(getTasks).toHaveBeenCalledTimes(1);
    expect(getSystemStatus).toHaveBeenCalledTimes(1);
  });


  it('reads system status when indexing or capacity changes, and nothing else', async () => {
    renderHook(() => useHeaderStats());
    await waitFor(() => expect(getSystemStatus).toHaveBeenCalledTimes(1));

    // Per-file indexing counters do not change what the health rows say.
    act(() => socketState.activityCallbacks.forEach(callback => callback(
      activityPush('indexing', 'progress'),
    )));
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(getSystemStatus).toHaveBeenCalledTimes(1);

    act(() => socketState.activityCallbacks.forEach(callback => callback(
      activityPush('indexing', 'started'),
    )));
    await waitFor(() => expect(getSystemStatus).toHaveBeenCalledTimes(2));

    act(() => socketState.usageCallbacks.forEach(callback => callback({
      eventType: 'usage:update', provider: 'claude', occurredAt: '2026-09-13T00:02:00.000Z',
    })));
    await waitFor(() => expect(getSystemStatus).toHaveBeenCalledTimes(3));

    expect(getQueueStats).toHaveBeenCalledTimes(1);
    expect(getDrafts).toHaveBeenCalledTimes(1);
    expect(getTasks).toHaveBeenCalledTimes(1);
  });


  it('wakes the attention widget only for changes that need a person', async () => {
    renderHook(() => useHeaderStats());
    await waitFor(() => expect(getTasks).toHaveBeenCalledTimes(1));

    // An intermediate step moves the queue, but not what needs attention.
    act(() => socketState.activityCallbacks.forEach(callback => callback(
      activityPush('task', 'progress'),
    )));
    await waitFor(() => expect(getQueueStats).toHaveBeenCalledTimes(2));
    expect(getTasks).toHaveBeenCalledTimes(1);

    act(() => socketState.activityCallbacks.forEach(callback => callback(
      activityPush('task', 'blocked'),
    )));
    await waitFor(() => expect(getTasks).toHaveBeenCalledTimes(2));
    expect(getDrafts).toHaveBeenCalledTimes(1);
    expect(getSystemStatus).toHaveBeenCalledTimes(1);
  });


  it('ignores a repeated pushed state for a task it already reconciled', async () => {
    renderHook(() => useHeaderStats());
    await waitFor(() => expect(getQueueStats).toHaveBeenCalledTimes(1));

    const running: ActivityUpdatePayload = {
      ...activityPush('task', 'started'),
      subjectId: 'task-1',
    };
    act(() => socketState.activityCallbacks.forEach(callback => callback(running)));
    await waitFor(() => expect(getQueueStats).toHaveBeenCalledTimes(2));

    // The same run reporting the same state again is not news.
    act(() => socketState.activityCallbacks.forEach(callback => {
      callback({ ...running, occurredAt: '2026-09-13T00:00:30.000Z' });
      callback({ ...running, occurredAt: '2026-09-13T00:01:00.000Z' });
    }));
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(getQueueStats).toHaveBeenCalledTimes(2);

    // Its next transition is.
    act(() => socketState.activityCallbacks.forEach(callback => callback({
      ...running, change: 'completed', occurredAt: '2026-09-13T00:01:30.000Z',
    })));
    await waitFor(() => expect(getQueueStats).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(getTasks).toHaveBeenCalledTimes(2));
  });


  it('reconciles exactly once per reconnect transition', async () => {
    const { rerender } = renderHook(() => useHeaderStats());
    await waitFor(() => expect(getQueueStats).toHaveBeenCalledTimes(1));

    socketState.isConnected = false;
    rerender();
    socketState.isConnected = true;
    rerender();
    // A re-render that does not change the connection state must not read again.
    rerender();

    await waitFor(() => expect(getQueueStats).toHaveBeenCalledTimes(2));
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(getQueueStats).toHaveBeenCalledTimes(2);
    expect(getDrafts).toHaveBeenCalledTimes(2);
    expect(getTasks).toHaveBeenCalledTimes(2);
    expect(getSystemStatus).toHaveBeenCalledTimes(2);
  });
});
