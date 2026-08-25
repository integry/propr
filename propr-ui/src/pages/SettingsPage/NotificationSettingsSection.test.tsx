import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { NOTIFICATION_KINDS, type NotificationPreferencesResponse } from '@propr/shared';
import type { BrowserPushContextValue } from '../../hooks/useBrowserPush';
import NotificationSettingsSection from './NotificationSettingsSection';

const mocks = vi.hoisted(() => ({
  getPreferences: vi.fn(),
  updatePreferences: vi.fn(),
  commitBadgeEnabled: vi.fn(),
  push: {} as BrowserPushContextValue,
}));

vi.mock('../../api/notificationApi', () => ({
  getNotificationPreferences: mocks.getPreferences,
  updateNotificationPreferences: mocks.updatePreferences,
}));
vi.mock('../../contexts/AuthContext', () => ({
  useCurrentUser: () => ({ id: 'user-1' }),
}));
vi.mock('../../contexts/NotificationCenterContext', () => ({
  useNotificationCenter: () => ({ commitBadgeEnabled: mocks.commitBadgeEnabled }),
}));
vi.mock('../../hooks/useBrowserPush', () => ({
  useBrowserPush: () => mocks.push,
}));

const preferences: NotificationPreferencesResponse = {
  preferences: Object.fromEntries(NOTIFICATION_KINDS.map(kind => [kind, {
    inboxEnabled: true,
    pushEnabled: false,
    updatedAt: null,
  }])) as NotificationPreferencesResponse['preferences'],
  quietHours: { start: null, end: null, timezone: 'UTC' },
  badgeEnabled: true,
};

function pushState(
  overrides: Partial<BrowserPushContextValue> = {},
): BrowserPushContextValue {
  return {
    serviceWorkerSupported: true,
    pushApiSupported: true,
    notificationApiSupported: true,
    serviceWorkerRegistration: {} as ServiceWorkerRegistration,
    permission: 'granted',
    isIos: false,
    isInstalled: false,
    requiresIosInstallation: false,
    subscription: null,
    capabilities: { push: { configured: true, vapidPublicKey: 'AQID_v8' } },
    isLoading: false,
    operation: 'idle',
    error: null,
    enable: vi.fn(async () => undefined),
    disable: vi.fn(async () => undefined),
    refresh: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('Notification Settings browser enrollment guidance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getPreferences.mockResolvedValue(preferences);
    mocks.updatePreferences.mockResolvedValue(preferences);
    mocks.push = pushState();
  });

  test('explains how to recover when browser permission is denied', async () => {
    mocks.push = pushState({ permission: 'denied' });

    render(<NotificationSettingsSection />);

    expect(await screen.findByText(/Notifications are blocked for this site/)).toBeInTheDocument();
    expect(screen.getByText(/site settings, allow notifications/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Enable on this browser/ })).not.toBeInTheDocument();
    expect(mocks.push.enable).not.toHaveBeenCalled();
  });

  test('guides iOS users to install before offering Web Push enrollment', async () => {
    mocks.push = pushState({
      permission: 'default',
      isIos: true,
      isInstalled: false,
      requiresIosInstallation: true,
    });

    render(<NotificationSettingsSection />);

    expect(await screen.findByText(/Safari only allows Web Push for Home Screen apps/))
      .toBeInTheDocument();
    expect(screen.getByText('Add to Home Screen')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Enable on this browser/ })).not.toBeInTheDocument();
    expect(mocks.push.enable).not.toHaveBeenCalled();
  });
});
