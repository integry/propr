import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getQueueStats, getSystemStatus, getTasks } from '../api/proprApi';
import { getDrafts } from '../api/plannerApi';
import * as systemStatusContext from '../contexts/SystemStatusContext';
import type { SystemStatus } from '../api/proprTypes';
import { useHeaderStats } from './useHeaderStats';

vi.mock('../api/proprApi', () => ({
  getQueueStats: vi.fn(),
  getSystemStatus: vi.fn(),
  getTasks: vi.fn(),
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
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('recovers header availability when a pushed status replaces a failed bootstrap', async () => {
    vi.mocked(getQueueStats).mockResolvedValue({ active: 0, waiting: 0, completed: 0, failed: 0, delayed: 0, paused: 0 });
    vi.mocked(getDrafts).mockResolvedValue({ drafts: [] } as never);
    vi.mocked(getTasks).mockResolvedValue({ tasks: [] });
    const failed = vi.fn(async (): Promise<SystemStatus> => { throw new Error('offline'); });
    const shared = { managed: true, isLoading: false, error: new Error('offline') as Error | null,
      status: undefined as SystemStatus | undefined, getStatus: failed, refreshStatus: failed };
    vi.spyOn(systemStatusContext, 'useSharedSystemStatus').mockImplementation(() => shared);
    const { result, rerender } = renderHook(() => useHeaderStats());
    await waitFor(() => expect(result.current.resourceStatuses.status).toBe('unavailable'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    shared.error = null;
    shared.status = { daemon: 'Running', workers: [], agents: [], warnings: [] } as unknown as SystemStatus;
    rerender();
    await waitFor(() => expect(result.current.resourceStatuses.status).toBe('available'));
    expect(result.current.error).toBeNull();
    expect(result.current.systemHealth.daemon).toBe('Running');
  });

  it('keeps the shared pushed status when the initial read returns an older snapshot', async () => {
    vi.mocked(getQueueStats).mockResolvedValue({ active: 0, waiting: 0, completed: 0, failed: 0, delayed: 0, paused: 0 });
    vi.mocked(getDrafts).mockResolvedValue({ drafts: [] } as never);
    vi.mocked(getTasks).mockResolvedValue({ tasks: [] });
    const status = { daemon: 'Running', workers: [], agents: [], warnings: [] } as unknown as SystemStatus;
    const read = vi.fn(async () => ({ ...status, daemon: 'Stopped' }));
    vi.spyOn(systemStatusContext, 'useSharedSystemStatus').mockReturnValue({
      managed: true, status, isLoading: false, error: null, getStatus: read, refreshStatus: read,
    });
    const { result } = renderHook(() => useHeaderStats());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.systemHealth.daemon).toBe('Running');
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
});
