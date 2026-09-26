import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { NotificationPreferencesResponse, NotificationUpdatePayload } from '@propr/shared';
import { NotificationCenterProvider, useNotificationCenter } from './NotificationCenterContext';

const authState = vi.hoisted(() => ({
  user: { id: 'user-1', username: 'first-user' } as { id: string; username: string } | null,
}));
const notificationApi = vi.hoisted(() => ({
  getNotificationPreferences: vi.fn(),
  getNotificationUnreadCount: vi.fn(),
}));

const socketState = vi.hoisted(() => ({
  isConnected: true,
  notificationCallbacks: new Set<(payload: NotificationUpdatePayload) => void>(),
}));

vi.mock('./AuthContext', () => ({ useCurrentUser: () => authState.user }));
vi.mock('./useSocket', () => ({
  useSocket: () => ({
    isConnected: socketState.isConnected,
    onNotificationUpdate: (callback: (payload: NotificationUpdatePayload) => void) => {
      socketState.notificationCallbacks.add(callback);
      return () => socketState.notificationCallbacks.delete(callback);
    },
  }),
}));
vi.mock('./DemoModeContext', () => ({ useDemoMode: () => ({ isDemoMode: false }) }));
vi.mock('../api/notificationApi', () => notificationApi);

function preferences(badgeEnabled: boolean): NotificationPreferencesResponse {
  return {
    preferences: {},
    quietHours: { start: null, end: null, timezone: 'UTC' },
    badgeEnabled,
  } as NotificationPreferencesResponse;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise; });
  return { promise, resolve };
}

let observedActions: {
  commitUnreadCount: (count: number) => void;
  refreshUnreadCount: () => Promise<void>;
  isActiveIdentity: () => boolean;
} | null = null;

const Consumer = () => {
  const center = useNotificationCenter();
  observedActions = center;
  return (
    <>
      <span>{center.badgeEnabled ? 'enabled' : 'disabled'}</span>
      <span>count:{center.unreadCount ?? 'pending'}</span>
      <button type="button" onClick={() => center.commitBadgeEnabled(true)}>Enable badge</button>
    </>
  );
};

const centerTree = () => (
  <NotificationCenterProvider key={authState.user?.id ?? 'anonymous'}>
    <Consumer />
  </NotificationCenterProvider>
);

function renderCenter() { return render(centerTree()); }

describe('NotificationCenterProvider', () => {
  beforeEach(() => {
    authState.user = { id: 'user-1', username: 'first-user' };
    notificationApi.getNotificationPreferences.mockReset();
    notificationApi.getNotificationUnreadCount.mockReset();
    notificationApi.getNotificationUnreadCount.mockResolvedValue({ unreadCount: 0 });
    socketState.isConnected = true;
    socketState.notificationCallbacks.clear();
    observedActions = null;
  });

  const pushNotificationUpdate = (change: NotificationUpdatePayload['change'] = 'created') => act(() => {
    socketState.notificationCallbacks.forEach(callback => callback({
      eventType: 'notification:update',
      change,
      occurredAt: '2026-09-26T12:00:00.000Z',
    }));
  });

  test('does not let an initial preference response overwrite a newer Settings choice', async () => {
    const initialPreference = deferred<NotificationPreferencesResponse>();
    notificationApi.getNotificationPreferences.mockReturnValue(initialPreference.promise);
    renderCenter();

    await waitFor(() => expect(notificationApi.getNotificationPreferences).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('disabled')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Enable badge' }));
    expect(screen.getByText('enabled')).toBeInTheDocument();
    await act(async () => initialPreference.resolve(preferences(false)));

    expect(screen.getByText('enabled')).toBeInTheDocument();
  });

  test('ignores a previous account preference after identity changes', async () => {
    const firstPreference = deferred<NotificationPreferencesResponse>();
    const secondUnread = deferred<{ unreadCount: number }>();
    notificationApi.getNotificationUnreadCount
      .mockResolvedValueOnce({ unreadCount: 7 })
      .mockReturnValueOnce(secondUnread.promise);
    notificationApi.getNotificationPreferences
      .mockReturnValueOnce(firstPreference.promise)
      .mockResolvedValueOnce(preferences(true));
    const view = renderCenter();
    await waitFor(() => expect(notificationApi.getNotificationPreferences).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('count:7')).toBeInTheDocument();
    const oldActions = observedActions;
    if (!oldActions) throw new Error('Notification center was not observed');

    authState.user = { id: 'user-2', username: 'second-user' };
    view.rerender(centerTree());
    expect(screen.getByText('count:pending')).toBeInTheDocument();
    expect(oldActions.isActiveIdentity()).toBe(false);
    expect(observedActions?.isActiveIdentity()).toBe(true);
    oldActions.commitUnreadCount(99);
    await oldActions.refreshUnreadCount();
    expect(screen.getByText('count:pending')).toBeInTheDocument();
    expect(notificationApi.getNotificationUnreadCount).toHaveBeenCalledTimes(2);
    await act(async () => secondUnread.resolve({ unreadCount: 2 }));
    expect(await screen.findByText('count:2')).toBeInTheDocument();
    expect(await screen.findByText('enabled')).toBeInTheDocument();
    await act(async () => firstPreference.resolve(preferences(false)));

    expect(screen.getByText('enabled')).toBeInTheDocument();
    expect(notificationApi.getNotificationPreferences).toHaveBeenCalledTimes(2);
  });

  test('reads the badge once per pushed notification change and never on a timer', async () => {
    notificationApi.getNotificationPreferences.mockResolvedValue(preferences(false));
    notificationApi.getNotificationUnreadCount
      .mockResolvedValueOnce({ unreadCount: 0 })
      .mockResolvedValue({ unreadCount: 4 });
    // Mount on the fake clock so a timer armed during render would be visible
    // to the idle check below.
    vi.useFakeTimers();
    try {
      renderCenter();
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(notificationApi.getNotificationUnreadCount).toHaveBeenCalledTimes(1);

      await pushNotificationUpdate('created');
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });

      expect(screen.getByText('count:4')).toBeInTheDocument();
      expect(notificationApi.getNotificationUnreadCount).toHaveBeenCalledTimes(2);

      // An idle connected session issues nothing of its own accord.
      await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000); });
      expect(notificationApi.getNotificationUnreadCount).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test('falls back to polling only while the socket is disconnected', async () => {
    notificationApi.getNotificationPreferences.mockResolvedValue(preferences(false));
    socketState.isConnected = false;
    // The fallback interval is armed during render, so the fake clock has to
    // exist before the provider mounts.
    vi.useFakeTimers();
    try {
      renderCenter();
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(notificationApi.getNotificationUnreadCount).toHaveBeenCalledTimes(1);

      await act(async () => { await vi.advanceTimersByTimeAsync(60_100); });

      expect(notificationApi.getNotificationUnreadCount).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test('reconciles the badge once when the socket reconnects', async () => {
    notificationApi.getNotificationPreferences.mockResolvedValue(preferences(false));
    socketState.isConnected = false;
    const view = renderCenter();
    await waitFor(() => expect(notificationApi.getNotificationUnreadCount).toHaveBeenCalledTimes(1));

    socketState.isConnected = true;
    await act(async () => { view.rerender(centerTree()); });
    await act(async () => { view.rerender(centerTree()); });

    expect(notificationApi.getNotificationUnreadCount).toHaveBeenCalledTimes(2);
  });
});
