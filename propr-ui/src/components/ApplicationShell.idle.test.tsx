import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getQueueStats, getSystemStatus, getTasks } from '../api/proprApi';
import { getDrafts } from '../api/plannerApi';
import { getAgentTankUsage } from '../api/revertApi';
import { getNotificationPreferences, getNotificationUnreadCount } from '../api/notificationApi';
import { NotificationCenterProvider, useNotificationCenter } from '../contexts/NotificationCenterContext';
import { SystemStatusProvider } from '../contexts/SystemStatusContext';
import { useHeaderStats } from '../hooks/useHeaderStats';
import AgentTankSidebar from './AgentTankSidebar';
import SystemStatus from './SystemStatus';

/**
 * The shell - header stats, the unread badge, the usage sidebar and instance
 * health - is mounted on every page, so anything it does on a timer is paid for
 * on screens that show none of it. This suite holds the line the issue drew:
 * with the socket connected and nothing happening, the shell is silent.
 */

const socketState = vi.hoisted(() => {
  const state = { isConnected: true };
  const noEvents = () => () => undefined;
  return {
    state,
    // One connected context for both accessors: nothing is pushed here, so the
    // only question this suite asks is what the shell does on its own.
    context: () => ({
      isConnected: state.isConnected,
      onTaskUpdate: noEvents,
      onDraftUpdate: noEvents,
      onQueueStatsUpdate: noEvents,
      onActivityUpdate: noEvents,
      onNotificationUpdate: noEvents,
      onUsageUpdate: noEvents,
    }),
  };
});

vi.mock('../api/proprApi', () => ({
  getQueueStats: vi.fn(),
  getSystemStatus: vi.fn(),
  getTasks: vi.fn(),
  INSTANCE_AUTHORIZATION_CHANGED_EVENT: 'propr:instance-authorization-changed',
}));
vi.mock('../api/plannerApi', () => ({ getDrafts: vi.fn() }));
vi.mock('../api/revertApi', () => ({
  getAgentTankUsage: vi.fn(),
  refreshAgentTank: vi.fn(),
}));
vi.mock('../api/notificationApi', () => ({
  getNotificationPreferences: vi.fn(),
  getNotificationUnreadCount: vi.fn(),
}));
vi.mock('../api/apiClient', () => ({
  getDesktopSocketConfigurationKey: () => 'instance-a',
  subscribeDesktopConnectionScope: () => () => undefined,
}));
vi.mock('../config/runtimeMode', () => ({ isDesktopRuntime: () => false }));
vi.mock('../contexts/AuthContext', () => ({ useCurrentUser: () => ({ id: 'user-1' }) }));
vi.mock('../contexts/DemoModeContext', () => ({ useDemoMode: () => ({ isDemoMode: false }) }));
vi.mock('../contexts/useSocket', () => ({
  useSocket: socketState.context,
  useOptionalSocket: socketState.context,
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

const HeaderStatsProbe = () => {
  const stats = useHeaderStats();
  const { unreadCount } = useNotificationCenter();
  return <div data-testid="shell">{stats.isLoading ? 'loading' : 'ready'}:{unreadCount ?? 'pending'}</div>;
};

const shell = () => (
  <MemoryRouter>
    <NotificationCenterProvider>
      <SystemStatusProvider>
        <HeaderStatsProbe />
        <SystemStatus />
        <AgentTankSidebar />
      </SystemStatusProvider>
    </NotificationCenterProvider>
  </MemoryRouter>
);

const shellReads = () => ({
  queue: vi.mocked(getQueueStats).mock.calls.length,
  drafts: vi.mocked(getDrafts).mock.calls.length,
  tasks: vi.mocked(getTasks).mock.calls.length,
  status: vi.mocked(getSystemStatus).mock.calls.length,
  usage: vi.mocked(getAgentTankUsage).mock.calls.length,
  unread: vi.mocked(getNotificationUnreadCount).mock.calls.length,
  preferences: vi.mocked(getNotificationPreferences).mock.calls.length,
});

describe('application shell while the socket is connected', () => {
  beforeEach(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    socketState.state.isConnected = true;
    vi.clearAllMocks();
    localStorage.clear();
    vi.mocked(getQueueStats).mockResolvedValue({
      active: 0, activeJobs: [], waiting: 0, delayed: 0, completed: 0, failed: 0, paused: 0,
    } as never);
    vi.mocked(getDrafts).mockResolvedValue({ drafts: [], total: 0, page: 1, limit: 20, hasMore: false });
    vi.mocked(getTasks).mockResolvedValue({ tasks: [] });
    vi.mocked(getSystemStatus).mockResolvedValue(healthyStatus as never);
    vi.mocked(getAgentTankUsage).mockResolvedValue({ enabled: false });
    vi.mocked(getNotificationUnreadCount).mockResolvedValue({ unreadCount: 2 });
    vi.mocked(getNotificationPreferences).mockResolvedValue({ badgeEnabled: false } as never);
  });

  it('issues no request at all over an idle period after its initial load', async () => {
    // Mount on the fake clock so every timer the shell arms is on it: a timer
    // created beforehand would never fire here and the assertion would pass
    // without meaning anything.
    vi.useFakeTimers();
    try {
      render(shell());
      await act(async () => { await vi.advanceTimersByTimeAsync(10); });
      expect(screen.getByTestId('shell')).toHaveTextContent('ready:2');
      const afterInitialLoad = shellReads();
      expect(afterInitialLoad.queue).toBe(1);
      expect(afterInitialLoad.usage).toBe(1);
      expect(afterInitialLoad.unread).toBe(1);

      // Five idle minutes on a connected socket.
      await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000); });

      expect(shellReads()).toEqual(afterInitialLoad);
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to polling while the socket is unavailable', async () => {
    socketState.state.isConnected = false;
    vi.useFakeTimers();
    try {
      render(shell());
      await act(async () => { await vi.advanceTimersByTimeAsync(10); });
      const afterInitialLoad = shellReads();

      await act(async () => { await vi.advanceTimersByTimeAsync(60_100); });

      const afterOutage = shellReads();
      expect(afterOutage.status).toBeGreaterThan(afterInitialLoad.status);
      expect(afterOutage.queue).toBeGreaterThan(afterInitialLoad.queue);
      expect(afterOutage.usage).toBeGreaterThan(afterInitialLoad.usage);
      expect(afterOutage.unread).toBeGreaterThan(afterInitialLoad.unread);
    } finally {
      vi.useRealTimers();
    }
  });
});
