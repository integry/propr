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
  listBackend: vi.fn(),
  registerBackend: vi.fn(),
  revokeBackend: vi.fn(),
  getOrRegisterWorker: vi.fn(),
  supportsWorkerOrigin: vi.fn(),
  supportsWorkers: vi.fn(),
}));

vi.mock('../api/notificationApi', () => ({
  getNotificationCapabilities: mocks.getCapabilities,
  listPushSubscriptions: mocks.listBackend,
  registerPushSubscription: mocks.registerBackend,
  revokePushSubscription: mocks.revokeBackend,
  PushSubscriptionOwnershipConflictError: class extends Error {},
}));

vi.mock('../serviceWorkerRegistration', () => ({
  browserSupportsServiceWorkerOrigin: mocks.supportsWorkerOrigin,
  browserSupportsServiceWorkers: mocks.supportsWorkers,
  getOrRegisterServiceWorker: mocks.getOrRegisterWorker,
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

    unsubscribeBrowser = vi.fn(async () => {
      getSubscription.mockResolvedValue(null);
      return true;
    });
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
    mocks.listBackend.mockResolvedValue({ subscriptions: [] });
    mocks.getOrRegisterWorker.mockResolvedValue(registration);
    mocks.supportsWorkerOrigin.mockReturnValue(true);
    mocks.supportsWorkers.mockReturnValue(true);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  const Probe = () => {
    const push = useBrowserPush();
    return (
      <div>
        <span>{push.isLoading ? 'loading' : push.subscription ? 'subscribed' : 'ready'}</span>
        <span data-testid="push-permission">{push.permission}</span>
        {push.error && <span role="alert">{push.error}</span>}
        <button type="button" onClick={() => void push.enable().catch(() => undefined)}>Enable</button>
        <button type="button" onClick={() => void push.disable().catch(() => undefined)}>Disable</button>
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

  test.each([null, 'another-user', 'user-1'])('an existing subscription with owner %s never enrolls on load', async owner => {
    permission = 'granted';
    getSubscription.mockResolvedValue(subscription);
    if (owner) localStorage.setItem('propr:push-subscription-owner', owner);
    render(<AuthProvider user={user}><BrowserPushProvider><Probe /></BrowserPushProvider></AuthProvider>);
    await screen.findByText('ready');
    expect(mocks.listBackend).toHaveBeenCalledTimes(owner === 'another-user' ? 0 : 1);
    expect(mocks.registerBackend).not.toHaveBeenCalled();
    expect(subscribeBrowser).not.toHaveBeenCalled();
    expect(unsubscribeBrowser).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('propr:push-subscription-owner')).toBeNull();
    expect(requestPermission).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Enable' }));
    await screen.findByText('subscribed');
    expect(mocks.registerBackend).toHaveBeenCalledTimes(1);
  });

  test.each([
    { configured: true, missingOwner: false },
    { configured: false, missingOwner: false },
    { configured: true, missingOwner: true },
  ])('unsubscribes the previous account on user change with push configured=$configured and missing owner=$missingOwner', async ({ configured, missingOwner }) => {
    permission = 'granted';
    getSubscription.mockResolvedValue(subscription);
    localStorage.setItem('propr:push-subscription-owner', user.id);
    mocks.listBackend.mockResolvedValue({ subscriptions: [{ endpoint: subscription.endpoint, revokedAt: null }] });
    const { rerender } = render(
      <AuthProvider user={user}><BrowserPushProvider><Probe /></BrowserPushProvider></AuthProvider>,
    );
    await screen.findByText('subscribed');
    expect(unsubscribeBrowser).not.toHaveBeenCalled();

    if (missingOwner) localStorage.removeItem('propr:push-subscription-owner');
    mocks.getCapabilities.mockResolvedValue({
      push: { configured, vapidPublicKey: configured ? 'AQID_v8' : null },
    });
    mocks.listBackend.mockResolvedValue({ subscriptions: [] });
    rerender(
      <AuthProvider user={{ ...user, id: 'user-2' }}><BrowserPushProvider><Probe /></BrowserPushProvider></AuthProvider>,
    );

    await screen.findByText('ready');
    expect(unsubscribeBrowser).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('propr:push-subscription-owner')).toBeNull();
    expect(subscribeBrowser).not.toHaveBeenCalled();
    expect(mocks.registerBackend).not.toHaveBeenCalled();
    expect(mocks.revokeBackend).not.toHaveBeenCalled();
    expect(requestPermission).not.toHaveBeenCalled();

    if (configured) {
      fireEvent.click(screen.getByRole('button', { name: 'Enable' }));
      await screen.findByText('subscribed');
      expect(subscribeBrowser).toHaveBeenCalledTimes(1);
      expect(mocks.registerBackend).toHaveBeenCalledTimes(1);
      expect(localStorage.getItem('propr:push-subscription-owner')).toBe('user-2');
    }
  });

  test.each([null, user.id])('preserves browser enrollment with stored owner %s when the ownership lookup fails', async owner => {
    permission = 'granted';
    getSubscription.mockResolvedValue(subscription);
    if (owner) localStorage.setItem('propr:push-subscription-owner', owner);
    mocks.listBackend.mockRejectedValueOnce(new Error('Ownership lookup unavailable'));
    render(<AuthProvider user={user}><BrowserPushProvider><Probe /></BrowserPushProvider></AuthProvider>);

    await screen.findByText(owner === user.id ? 'subscribed' : 'ready');
    expect(screen.getByRole('alert')).toHaveTextContent('Ownership lookup unavailable');
    expect(localStorage.getItem('propr:push-subscription-owner')).toBe(owner);
    expect(mocks.listBackend).toHaveBeenCalledTimes(1);
    expect(unsubscribeBrowser).not.toHaveBeenCalled();
    expect(subscribeBrowser).not.toHaveBeenCalled();
    expect(mocks.registerBackend).not.toHaveBeenCalled();
    expect(mocks.revokeBackend).not.toHaveBeenCalled();
    expect(requestPermission).not.toHaveBeenCalled();
  });

  test('an already enrolled browser is recognized through a read-only ownership check', async () => {
    permission = 'granted';
    getSubscription.mockResolvedValue(subscription);
    mocks.listBackend.mockResolvedValue({ subscriptions: [{ endpoint: subscription.endpoint, revokedAt: null }] });
    render(<AuthProvider user={user}><BrowserPushProvider><Probe /></BrowserPushProvider></AuthProvider>);
    await screen.findByText('subscribed');
    expect(unsubscribeBrowser).not.toHaveBeenCalled();
    expect(mocks.registerBackend).not.toHaveBeenCalled();
    expect(subscribeBrowser).not.toHaveBeenCalled();
    expect(requestPermission).not.toHaveBeenCalled();
  });

  test('recognition without owner metadata protects account changes when the ownership lookup is unavailable', async () => {
    permission = 'granted';
    getSubscription.mockResolvedValue(subscription);
    mocks.listBackend.mockResolvedValue({ subscriptions: [{ endpoint: subscription.endpoint, revokedAt: null }] });
    expect(localStorage.getItem('propr:push-subscription-owner')).toBeNull();
    const { rerender } = render(
      <AuthProvider user={user}><BrowserPushProvider><Probe /></BrowserPushProvider></AuthProvider>,
    );

    await screen.findByText('subscribed');
    expect(mocks.listBackend).toHaveBeenCalledTimes(1);
    expect(unsubscribeBrowser).not.toHaveBeenCalled();
    expect(localStorage.getItem('propr:push-subscription-owner')).toBe(user.id);

    mocks.listBackend.mockRejectedValue(new Error('Ownership lookup unavailable'));
    rerender(
      <AuthProvider user={{ ...user, id: 'user-2' }}><BrowserPushProvider><Probe /></BrowserPushProvider></AuthProvider>,
    );

    await screen.findByText('ready');
    expect(unsubscribeBrowser).toHaveBeenCalledTimes(1);
    expect(await registration.pushManager.getSubscription()).toBeNull();
    expect(localStorage.getItem('propr:push-subscription-owner')).toBeNull();
    expect(mocks.listBackend).toHaveBeenCalledTimes(1);
    expect(mocks.registerBackend).not.toHaveBeenCalled();
    expect(mocks.revokeBackend).not.toHaveBeenCalled();
    expect(subscribeBrowser).not.toHaveBeenCalled();
    expect(requestPermission).not.toHaveBeenCalled();
  });

  test('disabled instance does not attempt enrollment even with an existing subscription and permission', async () => {
    permission = 'granted';
    getSubscription.mockResolvedValue(subscription);
    mocks.getCapabilities.mockResolvedValue({ push: { configured: false, vapidPublicKey: null } });
    render(<AuthProvider user={user}><BrowserPushProvider><Probe /></BrowserPushProvider></AuthProvider>);
    await screen.findByText('subscribed');
    fireEvent.click(screen.getByRole('button', { name: 'Enable' }));
    await act(async () => undefined);
    expect(mocks.listBackend).not.toHaveBeenCalled();
    expect(mocks.registerBackend).not.toHaveBeenCalled();
    expect(subscribeBrowser).not.toHaveBeenCalled();
    expect(requestPermission).not.toHaveBeenCalled();
  });

  test('does not subscribe or call the backend when the permission prompt is denied', async () => {
    requestPermission.mockImplementationOnce(async () => {
      permission = 'denied';
      return permission;
    });
    render(
      <AuthProvider user={user}>
        <BrowserPushProvider><Probe /></BrowserPushProvider>
      </AuthProvider>,
    );

    await screen.findByText('ready');
    fireEvent.click(screen.getByRole('button', { name: 'Enable' }));

    await waitFor(() => expect(screen.getByTestId('push-permission')).toHaveTextContent('denied'));
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(subscribeBrowser).not.toHaveBeenCalled();
    expect(mocks.registerBackend).not.toHaveBeenCalled();
  });

  test('does not inspect service workers or prompt on an unsupported desktop origin', async () => {
    mocks.supportsWorkerOrigin.mockReturnValue(false);
    mocks.supportsWorkers.mockReturnValue(false);

    render(
      <AuthProvider user={user}>
        <BrowserPushProvider><Probe /></BrowserPushProvider>
      </AuthProvider>,
    );

    await screen.findByText('ready');
    expect(mocks.getOrRegisterWorker).not.toHaveBeenCalled();
    expect(getSubscription).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Enable' }));
    await waitFor(() => expect(requestPermission).not.toHaveBeenCalled());
    expect(subscribeBrowser).not.toHaveBeenCalled();
    expect(mocks.registerBackend).not.toHaveBeenCalled();
  });

  test.each([
    ['service workers', { serviceWorker: false, push: true, notifications: true }],
    ['PushManager', { serviceWorker: true, push: false, notifications: true }],
    ['Notifications', { serviceWorker: true, push: true, notifications: false }],
  ])('does not inspect or prompt when %s are unsupported', async (_name, support) => {
    mocks.supportsWorkers.mockReturnValue(support.serviceWorker);
    if (!support.push) Reflect.deleteProperty(window, 'PushManager');
    if (!support.notifications) Reflect.deleteProperty(window, 'Notification');

    render(
      <AuthProvider user={user}>
        <BrowserPushProvider><Probe /></BrowserPushProvider>
      </AuthProvider>,
    );

    await screen.findByText('ready');
    expect(mocks.getOrRegisterWorker).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Enable' }));
    await waitFor(() => expect(subscribeBrowser).not.toHaveBeenCalled());
    expect(requestPermission).not.toHaveBeenCalled();
    expect(mocks.registerBackend).not.toHaveBeenCalled();
  });
});
