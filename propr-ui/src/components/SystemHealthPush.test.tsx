import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActivityUpdatePayload } from '@propr/shared';
import { getQueueStats, getSystemStatus, getTasks } from '../api/proprApi';
import { getDrafts } from '../api/plannerApi';
import { SystemStatusProvider, useSharedSystemStatus } from '../contexts/SystemStatusContext';
import { useHeaderStats } from '../hooks/useHeaderStats';
import SystemStatus from './SystemStatus';

/**
 * A worker or the daemon can stop while the API and this client's socket stay
 * up: no task transitions, no indexing, no capacity change - nothing in a run's
 * lifecycle says health moved. Since these surfaces stopped polling while
 * connected, the `health` domain is the only thing that can correct them, so
 * each one has to actually listen for it.
 */

const socketState = vi.hoisted(() => ({
  isConnected: true,
  activityCallbacks: new Set<(payload: ActivityUpdatePayload) => void>(),
}));

vi.mock('../api/proprApi', () => ({
  getQueueStats: vi.fn(),
  getSystemStatus: vi.fn(),
  getTasks: vi.fn(),
  INSTANCE_AUTHORIZATION_CHANGED_EVENT: 'propr:instance-authorization-changed',
}));
vi.mock('../api/plannerApi', () => ({ getDrafts: vi.fn() }));
vi.mock('../api/apiClient', () => ({
  getDesktopSocketConfigurationKey: () => 'instance-a',
  subscribeDesktopConnectionScope: () => () => undefined,
}));
vi.mock('../config/runtimeMode', () => ({ isDesktopRuntime: () => false }));
vi.mock('../contexts/AuthContext', () => ({ useCurrentUser: () => ({ id: 'user-1' }) }));
vi.mock('../contexts/useSocket', () => {
  const context = () => ({
    isConnected: socketState.isConnected,
    onTaskUpdate: () => () => undefined,
    onDraftUpdate: () => () => undefined,
    onQueueStatsUpdate: () => () => undefined,
    onNotificationUpdate: () => () => undefined,
    onUsageUpdate: () => () => undefined,
    onActivityUpdate: (callback: (payload: ActivityUpdatePayload) => void) => {
      socketState.activityCallbacks.add(callback);
      return () => socketState.activityCallbacks.delete(callback);
    },
  });
  return { useSocket: context, useOptionalSocket: context };
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

const healthChanged = (): ActivityUpdatePayload => ({
  eventType: 'activity:update',
  domain: 'health',
  change: 'updated',
  occurredAt: '2026-09-26T00:01:00.000Z',
});

const pushHealthChanged = () => act(() => {
  socketState.activityCallbacks.forEach(callback => callback(healthChanged()));
});

const HealthProbe = () => {
  const stats = useHeaderStats();
  const { status } = useSharedSystemStatus();
  return (
    <div data-testid="probe">
      {stats.systemHealth.isHealthy ? 'healthy' : 'unhealthy'}:{status?.daemon ?? 'pending'}
    </div>
  );
};

describe('pushed health changes while the socket stays connected', () => {
  beforeEach(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    socketState.isConnected = true;
    socketState.activityCallbacks.clear();
    vi.clearAllMocks();
    localStorage.clear();
    vi.mocked(getQueueStats).mockResolvedValue({
      active: 0, activeJobs: [], waiting: 0, delayed: 0, completed: 0, failed: 0, paused: 0,
    } as never);
    vi.mocked(getDrafts).mockResolvedValue({ drafts: [], total: 0, page: 1, limit: 20, hasMore: false });
    vi.mocked(getTasks).mockResolvedValue({ tasks: [] });
    vi.mocked(getSystemStatus).mockResolvedValue(healthyStatus as never);
  });

  it('shows a stopped worker in the header health and the shared status', async () => {
    render(
      <MemoryRouter>
        <SystemStatusProvider>
          <HealthProbe />
        </SystemStatusProvider>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('healthy:Running'));
    const readsAtMount = vi.mocked(getSystemStatus).mock.calls.length;

    // The workers went away. Agent Tank is disabled, nothing is indexing, and
    // the socket is still connected, so nothing else would ever say so.
    vi.mocked(getSystemStatus).mockResolvedValue({ ...healthyStatus, workers: [] } as never);
    await pushHealthChanged();

    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('unhealthy:Running'));
    expect(vi.mocked(getSystemStatus).mock.calls.length).toBeGreaterThan(readsAtMount);
  });

  it('shows a stopped daemon in the system status panel', async () => {
    render(
      <MemoryRouter>
        <SystemStatus />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText('Running')).toBeInTheDocument());

    vi.mocked(getSystemStatus).mockResolvedValue({ ...healthyStatus, daemon: 'Stopped' } as never);
    await pushHealthChanged();

    await waitFor(() => expect(screen.getByText('Stopped')).toBeInTheDocument());
  });

  it('reads nothing for a health change while the tab is hidden', async () => {
    render(
      <MemoryRouter>
        <SystemStatusProvider>
          <HealthProbe />
        </SystemStatusProvider>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('healthy:Running'));
    const readsAtMount = vi.mocked(getSystemStatus).mock.calls.length;

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    await pushHealthChanged();
    await new Promise(resolve => setTimeout(resolve, 150));

    expect(vi.mocked(getSystemStatus).mock.calls.length).toBe(readsAtMount);
  });
});
