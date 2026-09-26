import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { DesktopNotificationSettings } from '../../../../apps/desktop/src/shared/contract';
import DesktopNotificationSettingsSection from './DesktopNotificationSettingsSection';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  update: vi.fn(),
  test: vi.fn(),
  publish: vi.fn(),
  clear: vi.fn(),
  settingsListeners: new Set<(scope: {
    profileId: string; transportScope: string; userId: string;
  }) => void>(),
  onSettingsChanged: vi.fn(),
  onNavigate: vi.fn(() => () => undefined),
  supported: true,
  userId: 'user-1',
  desktop: null as unknown as Record<string, unknown>,
}));

const settings = (
  preferences: Partial<DesktopNotificationSettings['preferences']> = {},
): DesktopNotificationSettings => ({
  preferences: {
    enabled: false,
    taskStarted: false,
    taskCompleted: false,
    taskFailed: true,
    taskNeedsAttention: true,
    ...preferences,
  },
  capability: mocks.supported
    ? { supported: true, platform: 'linux', permission: 'unknown' }
    : { supported: false, platform: 'win32', permission: 'unsupported', reason: 'platform-deferred' },
  scope: 'account-instance-device',
});

vi.mock('../../contexts/AuthContext', () => ({
  useCurrentUser: () => ({ id: mocks.userId }),
}));
vi.mock('../../desktop/DesktopContext', () => ({
  useDesktop: () => mocks.desktop,
}));

describe('Desktop notification settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.settingsListeners.clear();
    mocks.onSettingsChanged.mockImplementation(listener => {
      mocks.settingsListeners.add(listener);
      return () => { mocks.settingsListeners.delete(listener); };
    });
    mocks.supported = true;
    mocks.userId = 'user-1';
    mocks.desktop = {
      profile: { id: 'profile-1', name: 'Engineering' },
      connection: { status: 'ready', transportScope: 'abcdefghijklmnopqrstuv' },
      notifications: {
        bridge: mocks,
        scopeFor: (userId: string) => ({
          profileId: 'profile-1', transportScope: 'abcdefghijklmnopqrstuv', userId,
        }),
      },
    };
    mocks.get.mockResolvedValue(settings());
    mocks.update.mockImplementation(async (_scope, update) => ({
      ...settings(), preferences: { ...settings().preferences, ...update },
    }));
    mocks.test.mockResolvedValue({ status: 'accepted' });
  });

  test('shows an independent section with quiet defaults and explicit enrollment', async () => {
    render(<DesktopNotificationSettingsSection />);

    expect(await screen.findByRole('heading', { name: 'Desktop notifications' })).toBeInTheDocument();
    expect(screen.getByText(/separate from Browser push/)).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Desktop notification for Task started' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Desktop notification for Task completed' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Desktop notification for Task failed' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Desktop notification for Needs attention' })).toBeChecked();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.test).not.toHaveBeenCalled();
  });

  test('enables and tests only after direct user actions', async () => {
    render(<DesktopNotificationSettingsSection />);
    const enabled = await screen.findByRole('checkbox', { name: 'Enable desktop notifications on this device' });
    fireEvent.click(enabled);
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith(
      { profileId: 'profile-1', transportScope: 'abcdefghijklmnopqrstuv', userId: 'user-1' },
      { enabled: true },
    ));
    const testButton = screen.getByRole('button', { name: 'Send test notification' });
    await waitFor(() => expect(testButton).toBeEnabled());
    fireEvent.click(testButton);
    expect(await screen.findByText(/operating system accepted the test notification/)).toBeInTheDocument();
    expect(screen.getByText(/banner may still be suppressed/)).toBeInTheDocument();
  });

  test('refetches only matching native settings changes and unsubscribes on teardown', async () => {
    const view = render(<DesktopNotificationSettingsSection />);
    const enabled = await screen.findByRole('checkbox', {
      name: 'Enable desktop notifications on this device',
    });
    expect(mocks.get).toHaveBeenCalledTimes(1);

    act(() => {
      mocks.settingsListeners.forEach(listener => listener({
        profileId: 'another-profile', transportScope: 'abcdefghijklmnopqrstuv', userId: 'user-1',
      }));
    });
    expect(mocks.get).toHaveBeenCalledTimes(1);

    mocks.get.mockResolvedValue(settings({ enabled: true, taskCompleted: true }));
    act(() => {
      mocks.settingsListeners.forEach(listener => listener({
        profileId: 'profile-1', transportScope: 'abcdefghijklmnopqrstuv', userId: 'user-1',
      }));
    });
    await waitFor(() => expect(enabled).toBeChecked());
    expect(mocks.get).toHaveBeenCalledTimes(2);

    view.unmount();
    expect(mocks.settingsListeners.size).toBe(0);
  });

  test('explains the deferred Windows capability without enrollment controls', async () => {
    mocks.supported = false;
    mocks.get.mockResolvedValue(settings());
    render(<DesktopNotificationSettingsSection />);

    expect(await screen.findByText(/currently available on Linux and macOS/)).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /Enable desktop notifications/ })).not.toBeInTheDocument();
  });

  test('keeps stale account updates and finalizers out of the active account state', async () => {
    let resolveAccountA!: (value: DesktopNotificationSettings) => void;
    let resolveAccountB!: (value: DesktopNotificationSettings) => void;
    const accountAUpdate = new Promise<DesktopNotificationSettings>(resolve => {
      resolveAccountA = resolve;
    });
    const accountBUpdate = new Promise<DesktopNotificationSettings>(resolve => {
      resolveAccountB = resolve;
    });
    mocks.update.mockReturnValueOnce(accountAUpdate).mockReturnValueOnce(accountBUpdate);
    const view = render(<DesktopNotificationSettingsSection />);

    fireEvent.click(await screen.findByRole('checkbox', {
      name: 'Enable desktop notifications on this device',
    }));
    await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(1));

    mocks.userId = 'user-2';
    mocks.get.mockResolvedValue(settings({ taskStarted: true }));
    view.rerender(<DesktopNotificationSettingsSection />);
    const started = screen.getByRole('checkbox', { name: 'Desktop notification for Task started' });
    await waitFor(() => expect(started).toBeChecked());

    const completed = screen.getByRole('checkbox', { name: 'Desktop notification for Task completed' });
    fireEvent.click(completed);
    await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(2));
    await act(async () => {
      resolveAccountA(settings({ enabled: true, taskStarted: false }));
      await accountAUpdate;
    });

    expect(started).toBeChecked();
    expect(completed).toBeDisabled();

    await act(async () => {
      resolveAccountB(settings({ taskStarted: true, taskCompleted: true }));
      await accountBUpdate;
    });
    await waitFor(() => expect(completed).toBeChecked());
    expect(completed).toBeEnabled();
  });

  test('discards stale test results while a test for the new account is pending', async () => {
    let resolveAccountA!: (value: { status: 'accepted' }) => void;
    let resolveAccountB!: (value: { status: 'not-attempted' }) => void;
    const accountATest = new Promise<{ status: 'accepted' }>(resolve => {
      resolveAccountA = resolve;
    });
    const accountBTest = new Promise<{ status: 'not-attempted' }>(resolve => {
      resolveAccountB = resolve;
    });
    mocks.get.mockResolvedValue(settings({ enabled: true }));
    mocks.test.mockReturnValueOnce(accountATest).mockReturnValueOnce(accountBTest);
    const view = render(<DesktopNotificationSettingsSection />);

    let testButton = await screen.findByRole('button', { name: 'Send test notification' });
    fireEvent.click(testButton);
    await waitFor(() => expect(mocks.test).toHaveBeenCalledTimes(1));

    mocks.userId = 'user-2';
    view.rerender(<DesktopNotificationSettingsSection />);
    testButton = screen.getByRole('button', { name: 'Send test notification' });
    await waitFor(() => expect(testButton).toBeEnabled());
    fireEvent.click(testButton);
    await waitFor(() => expect(mocks.test).toHaveBeenCalledTimes(2));

    await act(async () => {
      resolveAccountA({ status: 'accepted' });
      await accountATest;
    });
    expect(screen.queryByText(/operating system accepted the test notification/)).not.toBeInTheDocument();
    expect(testButton).toBeDisabled();

    await act(async () => {
      resolveAccountB({ status: 'not-attempted' });
      await accountBTest;
    });
    expect(await screen.findByText(/service is unavailable, disabled, or temporarily rate limited/)).toBeInTheDocument();
    expect(testButton).toBeEnabled();
  });

  test('explains macOS rejection without claiming that a banner was displayed', async () => {
    mocks.get.mockResolvedValue({
      ...settings({ enabled: true }),
      capability: { supported: true, platform: 'darwin', permission: 'unknown' },
    });
    mocks.test.mockResolvedValue({ status: 'failed' });
    render(<DesktopNotificationSettingsSection />);

    const testButton = await screen.findByRole('button', { name: 'Send test notification' });
    fireEvent.click(testButton);

    expect(await screen.findByRole('alert')).toHaveTextContent(/macOS rejected the test notification/);
    expect(screen.getByText(/signed, installed build/)).toBeInTheDocument();
    expect(screen.queryByText(/Test sent/)).not.toBeInTheDocument();
  });

  test('reports an unconfirmed native request without treating it as delivery', async () => {
    mocks.get.mockResolvedValue(settings({ enabled: true }));
    mocks.test.mockResolvedValue({ status: 'unconfirmed' });
    render(<DesktopNotificationSettingsSection />);

    const testButton = await screen.findByRole('button', { name: 'Send test notification' });
    fireEvent.click(testButton);

    expect(await screen.findByText(/did not confirm delivery/)).toBeInTheDocument();
    expect(screen.getByText(/No banner is assumed/)).toBeInTheDocument();
  });
});
