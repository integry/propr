import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getQueueStats, getSystemStatus, getTasks } from '../api/proprApi';
import { getDrafts } from '../api/plannerApi';
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
});
