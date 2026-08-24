import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { NotificationPreferencesResponse } from '@propr/shared';
import { NotificationCenterProvider, useNotificationCenter } from './NotificationCenterContext';

const authState = vi.hoisted(() => ({
  user: { id: 'user-1', username: 'first-user' } as { id: string; username: string } | null,
}));
const notificationApi = vi.hoisted(() => ({
  getNotificationPreferences: vi.fn(),
  getNotificationUnreadCount: vi.fn(),
}));

vi.mock('./AuthContext', () => ({ useCurrentUser: () => authState.user }));
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

const Consumer = () => {
  const center = useNotificationCenter();
  return (
    <>
      <span>{center.badgeEnabled ? 'enabled' : 'disabled'}</span>
      <button type="button" onClick={() => center.commitBadgeEnabled(true)}>Enable badge</button>
    </>
  );
};

function renderCenter() {
  return render(<NotificationCenterProvider><Consumer /></NotificationCenterProvider>);
}

describe('NotificationCenterProvider', () => {
  beforeEach(() => {
    authState.user = { id: 'user-1', username: 'first-user' };
    notificationApi.getNotificationPreferences.mockReset();
    notificationApi.getNotificationUnreadCount.mockReset();
    notificationApi.getNotificationUnreadCount.mockResolvedValue({ unreadCount: 0 });
  });

  test('does not let an initial preference response overwrite a newer Settings choice', async () => {
    const initialPreference = deferred<NotificationPreferencesResponse>();
    notificationApi.getNotificationPreferences.mockReturnValue(initialPreference.promise);
    renderCenter();

    expect(await screen.findByText('disabled')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Enable badge' }));
    expect(screen.getByText('enabled')).toBeInTheDocument();
    await act(async () => initialPreference.resolve(preferences(false)));

    expect(screen.getByText('enabled')).toBeInTheDocument();
  });

  test('ignores a previous account preference after identity changes', async () => {
    const firstPreference = deferred<NotificationPreferencesResponse>();
    notificationApi.getNotificationPreferences
      .mockReturnValueOnce(firstPreference.promise)
      .mockResolvedValueOnce(preferences(true));
    const view = renderCenter();
    await waitFor(() => expect(notificationApi.getNotificationPreferences).toHaveBeenCalledTimes(1));

    authState.user = { id: 'user-2', username: 'second-user' };
    view.rerender(<NotificationCenterProvider><Consumer /></NotificationCenterProvider>);
    expect(await screen.findByText('enabled')).toBeInTheDocument();
    await act(async () => firstPreference.resolve(preferences(false)));

    expect(screen.getByText('enabled')).toBeInTheDocument();
    expect(notificationApi.getNotificationPreferences).toHaveBeenCalledTimes(2);
  });
});
