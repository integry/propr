import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { SocketContext, type SocketContextValue } from '../contexts/SocketContext';
import { NotificationCenterProvider } from '../contexts/NotificationCenterContext';
import { SystemStatusProvider } from '../contexts/SystemStatusContext';
import AgentTankSidebar from '../components/AgentTankSidebar';
import SystemStatus from '../components/SystemStatus';
import { useInboxNotifications } from '../pages/useInboxNotifications';
import { useHeaderStats } from './useHeaderStats';

const reads = vi.hoisted(() => ({ usage: vi.fn(), status: vi.fn(), inbox: vi.fn(), unread: vi.fn(),
  preferences: vi.fn(), queue: vi.fn(), drafts: vi.fn(), tasks: vi.fn() }));
vi.mock('../api/revertApi', () => ({ getAgentTankUsage: reads.usage, refreshAgentTank: vi.fn() }));
vi.mock('../api/proprApi', () => ({ getSystemStatus: reads.status, getQueueStats: reads.queue, getTasks: reads.tasks,
  INSTANCE_AUTHORIZATION_CHANGED_EVENT: 'auth-change' }));
vi.mock('../api/plannerApi', () => ({ getDrafts: reads.drafts }));
vi.mock('../api/notificationApi', () => ({ listNotifications: reads.inbox, getNotificationUnreadCount: reads.unread,
  getNotificationPreferences: reads.preferences }));
vi.mock('../contexts/AuthContext', () => ({ useCurrentUser: () => ({ id: 'owner' }) }));
vi.mock('../contexts/DemoModeContext', () => ({ useDemoMode: () => ({ isDemoMode: false }) }));
vi.mock('../components/ui/useToast', () => ({ useToast: () => ({ addToast: vi.fn() }) }));

const handlers = new Map<string, Set<(payload: never) => void>>();
const register = (name: string) => (fn: (payload: never) => void) => {
  const group = handlers.get(name) ?? new Set(); handlers.set(name, group); group.add(fn);
  return () => { group.delete(fn); };
};
const socket = {
  isConnected: true, subscribeToActivity: vi.fn(), unsubscribeFromActivity: vi.fn(),
  onActivityReady: register('ready'), onActivityUpdate: register('activity'), onNotificationUpdate: register('notification'),
  onUsageUpdate: register('usage'), onGoalUpdate: register('goal'), onTaskUpdate: register('task'),
  onDraftUpdate: register('draft'), onQueueStatsUpdate: register('queue'),
} as unknown as SocketContextValue;
function InboxAndHeader() { useInboxNotifications(); useHeaderStats(); return null; }
function tree() {
  return <SocketContext.Provider value={{ ...socket }}><MemoryRouter>
    <SystemStatusProvider><NotificationCenterProvider>
      <InboxAndHeader /><AgentTankSidebar /><SystemStatus />
    </NotificationCenterProvider></SystemStatusProvider>
  </MemoryRouter></SocketContext.Provider>;
}
const advance = async (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const emit = (name: string, payload = {}) => act(() => handlers.get(name)?.forEach(fn => fn(payload as never)));
beforeEach(() => {
  vi.useFakeTimers(); handlers.clear(); Object.values(reads).forEach(fn => fn.mockReset()); socket.isConnected = true;
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  reads.usage.mockResolvedValue({ enabled: false });
  reads.status.mockResolvedValue({ agents: [], workers: [], daemon: 'running', redis: 'connected', githubAuth: 'connected' });
  reads.inbox.mockResolvedValue({ notifications: [], unreadCount: 0, nextCursor: null });
  reads.unread.mockResolvedValue({ unreadCount: 0 }); reads.preferences.mockResolvedValue({ badgeEnabled: false });
  reads.queue.mockResolvedValue({ activeJobs: [] }); reads.drafts.mockResolvedValue({ drafts: [] }); reads.tasks.mockResolvedValue({ tasks: [] });
});
afterEach(() => { vi.useRealTimers(); });
it('keeps all five connected consumers idle, then reconciles matching pushes and disconnected fallback', async () => {
  const { rerender } = render(tree()); await advance(100);
  emit('ready'); await advance(100);
  const initial = Object.fromEntries(Object.entries(reads).map(([key, fn]) => [key, fn.mock.calls.length]));
  await advance(180_000);
  for (const [key, fn] of Object.entries(reads)) expect(fn.mock.calls.length, key).toBe(initial[key]);
  emit('notification'); emit('notification'); emit('usage');
  emit('activity', { domain: 'system', change: 'progressed', repository: null });
  await advance(100);
  expect(reads.inbox).toHaveBeenCalledTimes(initial.inbox + 1);
  expect(reads.unread).toHaveBeenCalledTimes(initial.unread + 1);
  expect(reads.usage).toHaveBeenCalledTimes(initial.usage + 1);
  expect(reads.status.mock.calls.length).toBeGreaterThan(initial.status);
  expect(reads.tasks).toHaveBeenCalledTimes(initial.tasks);
  socket.isConnected = false; rerender(tree()); await advance(60_100);
  expect(reads.usage.mock.calls.length).toBeGreaterThan(initial.usage + 1);
  expect(reads.inbox.mock.calls.length).toBeGreaterThan(initial.inbox + 1);
});
