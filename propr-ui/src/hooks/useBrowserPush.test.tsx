import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { AuthProvider } from '../contexts/AuthContext';
import {
  BrowserPushProvider,
  browserSubscriptionInput,
  isIosBrowser,
  urlBase64ToUint8Array,
  useBrowserPush,
} from './useBrowserPush';

const mocks = vi.hoisted(() => ({
  getCapabilities: vi.fn(),
  registerBackend: vi.fn(),
  revokeBackend: vi.fn(),
  registerWorker: vi.fn(),
}));

vi.mock('../api/notificationApi', () => ({
  getNotificationCapabilities: mocks.getCapabilities,
  registerPushSubscription: mocks.registerBackend,
  revokePushSubscription: mocks.revokeBackend,
  PushSubscriptionOwnershipConflictError: class extends Error {},
}));

vi.mock('../serviceWorkerRegistration', () => ({
  registerServiceWorker: mocks.registerWorker,
}));

const user = {
  id: 'user-1',
  login: 'octocat',
  username: 'octocat',
  displayName: 'Octo Cat',
  email: null,
  avatarUrl: null,
  role: 'member' as const,
  permissions: [],
  authorizationSource: 'local' as const,
};

function buffer(...bytes: number[]): ArrayBuffer {
  return new Uint8Array(bytes).buffer;
}

describe('browser push helpers', () => {
  test('decodes unpadded URL-safe VAPID base64 for PushManager.subscribe', () => {
    expect(Array.from(urlBase64ToUint8Array('AQID_v8'))).toEqual([1, 2, 3, 254, 255]);
    expect(() => urlBase64ToUint8Array('not+url/safe=')).toThrow(/URL-safe base64/);
  });

  test('recognizes iOS and desktop-mode iPadOS', () => {
    expect(isIosBrowser({
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
      platform: 'iPhone',
      maxTouchPoints: 5,
    } as Navigator)).toBe(true);
    expect(isIosBrowser({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X)',
      platform: 'MacIntel',
      maxTouchPoints: 5,
    } as Navigator)).toBe(true);
  });

  test('serializes browser keys as unpadded URL-safe base64', () => {
    const input = browserSubscriptionInput({
      endpoint: 'https://fcm.googleapis.com/fcm/send/browser-1',
      expirationTime: null,
      getKey: name => name === 'p256dh' ? buffer(251, 255) : buffer(250),
    } as PushSubscription);
    expect(input.keys).toEqual({ p256dh: '-_8', auth: '-g' });
  });
});

describe('BrowserPushProvider enrollment', () => {
  let permission: NotificationPermission;
  let requestPermission: ReturnType<typeof vi.fn>;
  let subscribeBrowser: ReturnType<typeof vi.fn>;
  let unsubscribeBrowser: ReturnType<typeof vi.fn>;
  let getSubscription: ReturnType<typeof vi.fn>;
  let subscription: PushSubscription;
  let registration: ServiceWorkerRegistration;

  beforeEach(() => {
    localStorage.clear();
    permission = 'default';
    requestPermission = vi.fn(async () => {
      permission = 'granted';
      return permission;
    });
    Object.defineProperty(window, 'Notification', {
      configurable: true,
      value: {
        get permission() { return permission; },
        requestPermission,
      },
    });
    Object.defineProperty(window, 'PushManager', {
      configurable: true,
      value: class PushManager {},
    });

    unsubscribeBrowser = vi.fn().mockResolvedValue(true);
    subscription = {
      endpoint: 'https://fcm.googleapis.com/fcm/send/browser-1',
      expirationTime: null,
      getKey: (name: PushEncryptionKeyName) => name === 'p256dh'
        ? buffer(4, 1, 2, 3)
        : buffer(7, 8),
      unsubscribe: unsubscribeBrowser,
    } as unknown as PushSubscription;
    subscribeBrowser = vi.fn().mockResolvedValue(subscription);
    getSubscription = vi.fn().mockResolvedValue(null);
    registration = {
      pushManager: { getSubscription, subscribe: subscribeBrowser },
    } as unknown as ServiceWorkerRegistration;
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { getRegistration: vi.fn().mockResolvedValue(registration) },
    });
    mocks.getCapabilities.mockResolvedValue({
      push: { configured: true, vapidPublicKey: 'AQID_v8' },
    });
    mocks.registerBackend.mockResolvedValue({ subscription: { id: 'backend-1' } });
    mocks.revokeBackend.mockResolvedValue(undefined);
    mocks.registerWorker.mockResolvedValue(registration);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  const Probe = () => {
    const push = useBrowserPush();
    return (
      <div>
        <span>{push.isLoading ? 'loading' : push.subscription ? 'subscribed' : 'ready'}</span>
        <button type="button" onClick={() => void push.enable()}>Enable</button>
        <button type="button" onClick={() => void push.disable()}>Disable</button>
      </div>
    );
  };

  test('never prompts on load, then enrolls once from a click and disables both sides', async () => {
    render(
      <AuthProvider user={user}>
        <BrowserPushProvider><Probe /></BrowserPushProvider>
      </AuthProvider>,
    );

    await screen.findByText('ready');
    expect(requestPermission).not.toHaveBeenCalled();
    expect(mocks.registerBackend).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Enable' }));
    await screen.findByText('subscribed');
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(subscribeBrowser).toHaveBeenCalledTimes(1);
    expect(mocks.registerBackend).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Enable' }));
    });
    expect(mocks.registerBackend).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Disable' }));
    await waitFor(() => expect(screen.getByText('ready')).toBeInTheDocument());
    expect(mocks.revokeBackend).toHaveBeenCalledWith(subscription.endpoint);
    expect(unsubscribeBrowser).toHaveBeenCalledTimes(1);
  });
});
