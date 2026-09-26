/* eslint-disable react-refresh/only-export-components */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  NotificationCapabilitiesResponse,
  PushSubscriptionInput,
} from '@propr/shared';
import {
  getNotificationCapabilities,
  listPushSubscriptions,
  PushSubscriptionOwnershipConflictError,
  registerPushSubscription,
  revokePushSubscription,
} from '../api/notificationApi';
import { useCurrentUser } from '../contexts/AuthContext';
import {
  browserSupportsServiceWorkerOrigin,
  browserSupportsServiceWorkers,
  getOrRegisterServiceWorker,
} from '../serviceWorkerRegistration';

const PUSH_OWNER_STORAGE_KEY = 'propr:push-subscription-owner';

export type BrowserNotificationPermission = NotificationPermission | 'unsupported';
export type BrowserPushOperation = 'idle' | 'enabling' | 'disabling';

export interface BrowserPushState {
  serviceWorkerOriginSupported: boolean;
  serviceWorkerSupported: boolean;
  pushApiSupported: boolean;
  notificationApiSupported: boolean;
  serviceWorkerRegistration: ServiceWorkerRegistration | null;
  permission: BrowserNotificationPermission;
  isIos: boolean;
  isInstalled: boolean;
  requiresIosInstallation: boolean;
  subscription: globalThis.PushSubscription | null;
  capabilities: NotificationCapabilitiesResponse | null;
  isLoading: boolean;
  operation: BrowserPushOperation;
  error: string | null;
}

export interface BrowserPushContextValue extends BrowserPushState {
  enable: () => Promise<void>;
  disable: () => Promise<void>;
  refresh: () => Promise<void>;
}

interface NavigatorWithStandalone extends Navigator {
  standalone?: boolean;
}

function browserSupportsPush(): boolean {
  return typeof window !== 'undefined' && 'PushManager' in window;
}

function browserSupportsNotifications(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function isIosBrowser(currentNavigator: Navigator = navigator): boolean {
  return /iPad|iPhone|iPod/.test(currentNavigator.userAgent)
    || (currentNavigator.platform === 'MacIntel' && currentNavigator.maxTouchPoints > 1);
}

export function isStandaloneWebApp(
  currentNavigator: NavigatorWithStandalone = navigator,
  mediaQuery: Pick<MediaQueryList, 'matches'> | null = typeof window === 'undefined'
    || typeof window.matchMedia !== 'function'
    ? null
    : window.matchMedia('(display-mode: standalone)'),
): boolean {
  return currentNavigator.standalone === true || mediaQuery?.matches === true;
}

export function urlBase64ToUint8Array(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new TypeError('The VAPID public key is not valid URL-safe base64.');
  }
  const padded = `${value}${'='.repeat((4 - value.length % 4) % 4)}`;
  const decoded = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  const output = new Uint8Array(new ArrayBuffer(decoded.length));
  for (let index = 0; index < decoded.length; index += 1) {
    output[index] = decoded.charCodeAt(index);
  }
  return output;
}

function arrayBufferToBase64Url(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function browserSubscriptionInput(
  subscription: globalThis.PushSubscription,
): PushSubscriptionInput {
  const p256dh = subscription.getKey('p256dh');
  const auth = subscription.getKey('auth');
  if (!p256dh || !auth) {
    throw new Error('The browser did not provide push encryption keys.');
  }
  return {
    endpoint: subscription.endpoint,
    expirationTime: subscription.expirationTime,
    keys: {
      p256dh: arrayBufferToBase64Url(p256dh),
      auth: arrayBufferToBase64Url(auth),
    },
  };
}

function currentPermission(): BrowserNotificationPermission {
  return browserSupportsNotifications() ? Notification.permission : 'unsupported';
}

async function getExistingPushSubscription(
  registration: ServiceWorkerRegistration | null,
  serviceWorkerSupported: boolean,
  pushApiSupported: boolean,
): Promise<globalThis.PushSubscription | null> {
  return registration && serviceWorkerSupported && pushApiSupported && registration.pushManager
    ? await registration.pushManager.getSubscription().catch(() => null)
    : null;
}

function initialState(): BrowserPushState {
  const isIos = typeof navigator !== 'undefined' && isIosBrowser();
  const isInstalled = typeof navigator !== 'undefined' && isStandaloneWebApp();
  return {
    serviceWorkerOriginSupported: browserSupportsServiceWorkerOrigin(),
    serviceWorkerSupported: browserSupportsServiceWorkers(),
    pushApiSupported: browserSupportsPush(),
    notificationApiSupported: browserSupportsNotifications(),
    serviceWorkerRegistration: null,
    permission: currentPermission(),
    isIos,
    isInstalled,
    requiresIosInstallation: isIos && !isInstalled,
    subscription: null,
    capabilities: null,
    isLoading: true,
    operation: 'idle',
    error: null,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Notifications could not be updated.';
}

function storedPushOwner(): string | null {
  try {
    return localStorage.getItem(PUSH_OWNER_STORAGE_KEY);
  } catch {
    return null;
  }
}

function storePushOwner(userId: string | null): void {
  try {
    if (userId === null) localStorage.removeItem(PUSH_OWNER_STORAGE_KEY);
    else localStorage.setItem(PUSH_OWNER_STORAGE_KEY, userId);
  } catch {
    // Storage can be unavailable in privacy modes; backend upserts remain safe.
  }
}

async function subscribe(
  registration: ServiceWorkerRegistration,
  vapidPublicKey: string,
): Promise<globalThis.PushSubscription> {
  if (!browserSupportsServiceWorkers() || !browserSupportsPush()) {
    throw new Error('This app origin does not support browser Web Push.');
  }
  return registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
  });
}

const BrowserPushContext = createContext<BrowserPushContextValue | null>(null);

export const BrowserPushProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const user = useCurrentUser();
  const [state, setState] = useState<BrowserPushState>(initialState);
  const stateRef = useRef(state);
  const inFlightRef = useRef<Promise<void> | null>(null);
  const reconciledRef = useRef<string | null>(null);
  stateRef.current = state;

  const inspect = useCallback(async (): Promise<void> => {
    const userId = user?.id;
    if (!userId) {
      setState(previous => ({ ...previous, isLoading: false }));
      return;
    }
    setState(previous => ({ ...previous, isLoading: true, error: null }));
    const serviceWorkerSupported = browserSupportsServiceWorkers();
    const pushApiSupported = browserSupportsPush();
    const notificationApiSupported = browserSupportsNotifications();
    const [capabilityResult, registrationResult] = await Promise.allSettled([
      getNotificationCapabilities(),
      serviceWorkerSupported && pushApiSupported && notificationApiSupported
        ? getOrRegisterServiceWorker()
        : Promise.resolve(null),
    ]);
    const capabilities = capabilityResult.status === 'fulfilled'
      ? capabilityResult.value
      : null;
    const registration = registrationResult.status === 'fulfilled'
      ? registrationResult.value
      : null;
    let localSubscription = await getExistingPushSubscription(
      registration, serviceWorkerSupported, pushApiSupported,
    );
    let reconciliationError: unknown = capabilityResult.status === 'rejected'
      ? capabilityResult.reason
      : registrationResult.status === 'rejected'
        ? registrationResult.reason
        : null;

    if (localSubscription) {
      const owner = storedPushOwner();
      try {
        if (owner !== null && owner !== userId) {
          // Stop the previous account's notifications without enrolling this one.
          await localSubscription.unsubscribe();
          storePushOwner(null);
          localSubscription = null;
        } else if (capabilities?.push.configured) {
          // Inspect ownership without creating enrollment. An existing browser
          // subscription may belong to another account or instance.
          const { subscriptions } = await listPushSubscriptions();
          if (!subscriptions.some(subscription => subscription.endpoint === localSubscription!.endpoint
            && subscription.revokedAt === null)) {
            await localSubscription.unsubscribe();
            storePushOwner(null);
            localSubscription = null;
          } else {
            storePushOwner(userId);
          }
        }
      } catch (error) {
        // A failed lookup does not invalidate known current-user enrollment.
        if (owner !== userId) localSubscription = null;
        reconciliationError = error;
      }
    }

    const isIos = isIosBrowser();
    const isInstalled = isStandaloneWebApp();
    setState(previous => ({
      ...previous,
      serviceWorkerOriginSupported: browserSupportsServiceWorkerOrigin(),
      serviceWorkerSupported,
      pushApiSupported,
      notificationApiSupported,
      serviceWorkerRegistration: registration,
      permission: currentPermission(),
      isIos,
      isInstalled,
      requiresIosInstallation: isIos && !isInstalled,
      subscription: localSubscription,
      capabilities,
      isLoading: false,
      error: reconciliationError === null ? null : errorMessage(reconciliationError),
    }));
  }, [user?.id]);

  useEffect(() => {
    reconciledRef.current = null;
    void inspect();
  }, [inspect]);

  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        setState(previous => ({ ...previous, permission: currentPermission() }));
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, []);

  const enable = useCallback((): Promise<void> => {
    if (inFlightRef.current) return inFlightRef.current;
    // Permission guards and ownership recovery belong to the same explicit user action.
    // eslint-disable-next-line complexity
    const operation = (async () => {
      const current = stateRef.current;
      const userId = user?.id;
      if (!userId) throw new Error('Sign in before enabling notifications.');
      if (current.requiresIosInstallation) {
        throw new Error('Add ProPR to your Home Screen before enabling notifications.');
      }
      if (
        !browserSupportsServiceWorkers()
        || !current.serviceWorkerOriginSupported
        || !current.serviceWorkerSupported
        || !current.notificationApiSupported
        || !current.pushApiSupported
      ) {
        throw new Error('This browser does not support Web Push.');
      }
      const vapidPublicKey = current.capabilities?.push.vapidPublicKey;
      if (!current.capabilities?.push.configured || !vapidPublicKey) {
        throw new Error('Browser notifications are unavailable for this ProPR instance.');
      }
      setState(previous => ({ ...previous, operation: 'enabling', error: null }));
      let permission = currentPermission();
      // This is the only permission request in the application. It is reached
      // solely from the Settings Enable button's click handler.
      if (permission === 'default') permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setState(previous => ({ ...previous, permission, operation: 'idle' }));
        return;
      }
      const registration = current.serviceWorkerRegistration
        ?? await getOrRegisterServiceWorker();
      if (!registration) throw new Error('The ProPR service worker is not available.');
      let localSubscription = current.subscription
        ?? await registration.pushManager.getSubscription();
      if (localSubscription && !current.subscription && storedPushOwner() !== userId) {
        await localSubscription.unsubscribe();
        localSubscription = null;
      }
      localSubscription ??= await subscribe(registration, vapidPublicKey);
      const reconciliationKey = `${userId}:${localSubscription.endpoint}`;
      if (reconciledRef.current !== reconciliationKey) {
        try {
          await registerPushSubscription(browserSubscriptionInput(localSubscription));
        } catch (error) {
          if (!(error instanceof PushSubscriptionOwnershipConflictError)) throw error;
          // Recovery also requires this explicit Enable click.
          await localSubscription.unsubscribe();
          localSubscription = await subscribe(registration, vapidPublicKey);
          await registerPushSubscription(browserSubscriptionInput(localSubscription));
        }
        reconciledRef.current = `${userId}:${localSubscription.endpoint}`;
      }
      storePushOwner(userId);
      setState(previous => ({
        ...previous,
        serviceWorkerRegistration: registration,
        subscription: localSubscription,
        permission,
        operation: 'idle',
        error: null,
      }));
    })().catch(error => {
      setState(previous => ({ ...previous, operation: 'idle', error: errorMessage(error) }));
      throw error;
    }).finally(() => {
      inFlightRef.current = null;
    });
    inFlightRef.current = operation;
    return operation;
  }, [user?.id]);

  const disable = useCallback((): Promise<void> => {
    if (inFlightRef.current) return inFlightRef.current;
    const operation = (async () => {
      setState(previous => ({ ...previous, operation: 'disabling', error: null }));
      const localSubscription = stateRef.current.subscription;
      if (localSubscription) {
        // Revoke first so a backend failure leaves a locally retryable endpoint.
        await revokePushSubscription(localSubscription.endpoint);
        await localSubscription.unsubscribe();
      }
      reconciledRef.current = null;
      storePushOwner(null);
      setState(previous => ({
        ...previous,
        subscription: null,
        operation: 'idle',
        error: null,
      }));
    })().catch(error => {
      setState(previous => ({ ...previous, operation: 'idle', error: errorMessage(error) }));
      throw error;
    }).finally(() => {
      inFlightRef.current = null;
    });
    inFlightRef.current = operation;
    return operation;
  }, []);

  const value = useMemo<BrowserPushContextValue>(() => ({
    ...state,
    enable,
    disable,
    refresh: inspect,
  }), [disable, enable, inspect, state]);

  return <BrowserPushContext.Provider value={value}>{children}</BrowserPushContext.Provider>;
};

export function useBrowserPush(): BrowserPushContextValue {
  const value = useContext(BrowserPushContext);
  if (!value) throw new Error('useBrowserPush must be used within BrowserPushProvider');
  return value;
}
