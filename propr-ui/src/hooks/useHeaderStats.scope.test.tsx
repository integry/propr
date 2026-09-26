import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DraftUpdatePayload } from '@propr/shared';
import { getDrafts } from '../api/plannerApi';
import { getQueueStats, getSystemStatus, getTasks } from '../api/proprApi';
import { useHeaderStats } from './useHeaderStats';

const socketState = vi.hoisted(() => ({
  isConnected: true,
  draftCallbacks: new Set<(payload: DraftUpdatePayload) => void>(),
}));
const identityState = vi.hoisted(() => ({ configuration: 'instance-a', userId: 'user-a' }));

vi.mock('../api/plannerApi', () => ({ getDrafts: vi.fn() }));
vi.mock('../api/proprApi', () => ({
  getQueueStats: vi.fn(),
  getSystemStatus: vi.fn(),
  getTasks: vi.fn(),
}));
vi.mock('../api/apiClient', () => ({
  getDesktopSocketConfigurationKey: () => identityState.configuration,
}));
vi.mock('../config/runtimeMode', () => ({ isDesktopRuntime: () => true }));
vi.mock('../contexts/AuthContext', () => ({
  useCurrentUser: () => ({ id: identityState.userId }),
}));
vi.mock('../contexts/useSocket', () => ({
  useSocket: () => ({
    isConnected: socketState.isConnected,
    onTaskUpdate: () => () => undefined,
    onDraftUpdate: (callback: (payload: DraftUpdatePayload) => void) => {
      socketState.draftCallbacks.add(callback);
      return () => socketState.draftCallbacks.delete(callback);
    },
    onQueueStatsUpdate: () => () => undefined,
    onActivityUpdate: () => () => undefined,
    onUsageUpdate: () => () => undefined,
  }),
}));

const emptyDrafts = { drafts: [], total: 0, page: 1, limit: 20, hasMore: false };
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

const draftSnapshot = (id: string): Awaited<ReturnType<typeof getDrafts>> => ({
  drafts: [{
    draft_id: id,
    repository: 'integry/propr',
    name: id,
    initial_prompt: id,
    status: 'review',
    created_at: '2026-09-13T00:02:00.000Z',
    updated_at: '2026-09-13T00:02:00.000Z',
  }],
  total: 1,
  page: 1,
  limit: 20,
  hasMore: false,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}

describe('useHeaderStats request scope reconciliation', () => {
  beforeEach(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    socketState.isConnected = true;
    socketState.draftCallbacks.clear();
    identityState.configuration = 'instance-a';
    identityState.userId = 'user-a';
    vi.mocked(getQueueStats).mockResolvedValue({
      active: 0, activeJobs: [], waiting: 0, delayed: 0, completed: 0, failed: 0, paused: 0,
    } as never);
    vi.mocked(getDrafts).mockResolvedValue(emptyDrafts);
    vi.mocked(getTasks).mockResolvedValue({ tasks: [] });
    vi.mocked(getSystemStatus).mockResolvedValue(healthyStatus);
  });

  afterEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('discards an in-flight live read across reconnect and completes the full recovery', async () => {
    const { result, rerender } = renderHook(() => useHeaderStats());
    await waitFor(() => expect(result.current.resourceStatuses.drafts).toBe('available'));

    const staleDrafts = deferred<Awaited<ReturnType<typeof getDrafts>>>();
    vi.mocked(getDrafts).mockReturnValueOnce(staleDrafts.promise);
    act(() => socketState.draftCallbacks.forEach(callback => callback({
      eventType: 'draft:update',
      draftId: 'draft-stale',
      step: 'complete',
      status: 'completed',
      draftStatus: 'review',
      timestamp: '2026-09-13T00:01:00.000Z',
    })));
    await waitFor(() => expect(getDrafts).toHaveBeenCalledTimes(2));

    socketState.isConnected = false;
    rerender();
    vi.mocked(getDrafts).mockResolvedValue(draftSnapshot('draft-after-reconnect'));
    socketState.isConnected = true;
    rerender();
    await act(async () => staleDrafts.resolve(emptyDrafts));

    await waitFor(() => expect(result.current.activePlans.map(plan => plan.draft_id))
      .toEqual(['draft-after-reconnect']));
    expect(getQueueStats).toHaveBeenCalledTimes(2);
    expect(getDrafts).toHaveBeenCalledTimes(3);
    expect(getTasks).toHaveBeenCalledTimes(2);
    expect(getSystemStatus).toHaveBeenCalledTimes(2);
  });

  it('isolates deferred reads from the previous account scope', async () => {
    const oldDrafts = deferred<Awaited<ReturnType<typeof getDrafts>>>();
    vi.mocked(getDrafts).mockReturnValueOnce(oldDrafts.promise);
    const { result, rerender } = renderHook(() => useHeaderStats());
    await waitFor(() => expect(getDrafts).toHaveBeenCalledTimes(1));

    vi.mocked(getDrafts).mockResolvedValue(draftSnapshot('draft-account-b'));
    identityState.userId = 'user-b';
    rerender();

    await waitFor(() => expect(result.current.activePlans.map(plan => plan.draft_id))
      .toEqual(['draft-account-b']));
    await act(async () => oldDrafts.resolve(emptyDrafts));
    expect(result.current.activePlans.map(plan => plan.draft_id)).toEqual(['draft-account-b']);
    expect(result.current.resourceStatuses.drafts).toBe('available');
    expect(getDrafts).toHaveBeenCalledTimes(2);
  });
});
