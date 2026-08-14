import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getLiveActivity, getQueueStats, getSystemStatus, getTasks } from '../api/proprApi';
import { getDrafts } from '../api/plannerApi';
import { useHeaderStats } from './useHeaderStats';

vi.mock('../api/proprApi', () => ({
  getQueueStats: vi.fn(),
  getSystemStatus: vi.fn(),
  getTasks: vi.fn(),
  getLiveActivity: vi.fn(),
}));

vi.mock('../api/plannerApi', () => ({
  getDrafts: vi.fn(),
}));

vi.mock('../contexts/useSocket', () => ({
  useSocket: () => ({
    isConnected: false,
    onTaskUpdate: () => () => undefined,
    onDraftUpdate: () => () => undefined,
  }),
}));

describe('useHeaderStats system health', () => {
  beforeEach(() => {
    vi.mocked(getLiveActivity).mockResolvedValue({ items: [], total: 0, remaining: 0 });
  });
  afterEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('treats zero enabled agents as healthy when core services are healthy', async () => {
    vi.mocked(getQueueStats).mockResolvedValue({ active: 0, waiting: 0, completed: 0, failed: 0, delayed: 0, paused: 0 });
    vi.mocked(getDrafts).mockResolvedValue({ drafts: [] } as never);
    vi.mocked(getTasks).mockResolvedValue({ tasks: [] });
    vi.mocked(getSystemStatus).mockResolvedValue({
      daemon: 'Running',
      workers: [{ id: 1, status: 'active' }],
      redis: 'Connected',
      githubAuth: 'Authenticated',
      claudeAuth: 'Failed',
      indexing: 'Idle',
      githubEventIntake: 'ProPR Connect',
      githubEventIntakeStatus: 'Connected',
      agents: [],
    });

    const { result } = renderHook(() => useHeaderStats());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.systemHealth.isHealthy).toBe(true);
    expect(result.current.systemHealth.agents).toEqual([]);
  });

  it('surfaces the intake method and status and flags a disconnected intake as unhealthy', async () => {
    vi.mocked(getQueueStats).mockResolvedValue({ active: 0, waiting: 0, completed: 0, failed: 0, delayed: 0, paused: 0 });
    vi.mocked(getDrafts).mockResolvedValue({ drafts: [] } as never);
    vi.mocked(getTasks).mockResolvedValue({ tasks: [] });
    vi.mocked(getSystemStatus).mockResolvedValue({
      daemon: 'Running',
      workers: [{ id: 1, status: 'active' }],
      redis: 'Connected',
      githubAuth: 'Authenticated',
      claudeAuth: 'Failed',
      indexing: 'Idle',
      githubEventIntake: 'ProPR Connect',
      githubEventIntakeStatus: 'Disconnected',
      agents: [],
    });

    const { result } = renderHook(() => useHeaderStats());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.systemHealth.githubEventIntake).toBe('ProPR Connect');
    expect(result.current.systemHealth.githubEventIntakeStatus).toBe('Disconnected');
    expect(result.current.systemHealth.isHealthy).toBe(false);
  });

  it('treats a missing intake status as neutral for backward compatibility', async () => {
    vi.mocked(getQueueStats).mockResolvedValue({ active: 0, waiting: 0, completed: 0, failed: 0, delayed: 0, paused: 0 });
    vi.mocked(getDrafts).mockResolvedValue({ drafts: [] } as never);
    vi.mocked(getTasks).mockResolvedValue({ tasks: [] });
    vi.mocked(getSystemStatus).mockResolvedValue({
      daemon: 'Running',
      workers: [{ id: 1, status: 'active' }],
      redis: 'Connected',
      githubAuth: 'Authenticated',
      claudeAuth: 'Failed',
      indexing: 'Idle',
      agents: [],
    } as never);

    const { result } = renderHook(() => useHeaderStats());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.systemHealth.githubEventIntakeStatus).toBe('Unknown');
    expect(result.current.systemHealth.isHealthy).toBe(true);
  });

  it('uses the authoritative live-activity count and exact visible list as one header contract', async () => {
    const liveItems = ['active', 'waiting', 'delayed', 'prioritized'].map((status) => ({
      id: `live-${status}`,
      type: 'task' as const,
      label: status,
      repository: 'integry/propr',
      status: 'Implementing',
      createdAt: '2026-08-14T12:00:00.000Z',
    }));
    vi.mocked(getLiveActivity).mockResolvedValue({
      items: liveItems,
      total: liveItems.length,
      remaining: 0,
    });
    vi.mocked(getDrafts).mockResolvedValue({ drafts: [] } as never);
    vi.mocked(getTasks).mockResolvedValue({
      tasks: [{ id: 'historical-processing-row', status: 'processing' }],
    } as never);
    vi.mocked(getSystemStatus).mockResolvedValue({
      daemon: 'Running',
      workers: [{ id: 1, status: 'active' }],
      redis: 'Connected',
      githubAuth: 'Authenticated',
      claudeAuth: 'Failed',
      indexing: 'Idle',
      githubEventIntake: 'ProPR Connect',
      githubEventIntakeStatus: 'Connected',
      agents: [],
    });

    const { result } = renderHook(() => useHeaderStats());

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.runningCount).toBe(liveItems.length);
    expect(result.current.runningItems).toEqual(liveItems);
    expect(getQueueStats).not.toHaveBeenCalled();
  });

  it.each([
    ['draft request', () => vi.mocked(getDrafts).mockRejectedValue(new Error('drafts unavailable'))],
    ['review-task request', () => vi.mocked(getTasks).mockRejectedValue(new Error('tasks unavailable'))],
    ['system-status request', () => vi.mocked(getSystemStatus).mockRejectedValue(new Error('status unavailable'))],
  ])('preserves successful live activity when the %s fails', async (_name, failRequest) => {
    const liveItems = [{
      id: 'live-active',
      type: 'task' as const,
      label: 'Active task',
      repository: 'integry/propr',
      status: 'Implementing',
      createdAt: '2026-08-14T12:00:00.000Z',
    }];
    vi.mocked(getLiveActivity).mockResolvedValue({ items: liveItems, total: 1, remaining: 0 });
    vi.mocked(getDrafts).mockResolvedValue({ drafts: [] } as never);
    vi.mocked(getTasks).mockResolvedValue({ tasks: [] });
    vi.mocked(getSystemStatus).mockResolvedValue({
      daemon: 'Running',
      workers: [{ id: 1, status: 'active' }],
      redis: 'Connected',
      githubAuth: 'Authenticated',
      claudeAuth: 'Failed',
      indexing: 'Idle',
      githubEventIntake: 'ProPR Connect',
      githubEventIntakeStatus: 'Connected',
      agents: [],
    });
    failRequest();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const { result } = renderHook(() => useHeaderStats());

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.runningCount).toBe(1);
    expect(result.current.runningItems).toEqual(liveItems);
    consoleError.mockRestore();
  });
});
