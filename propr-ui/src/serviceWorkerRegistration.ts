export interface ServiceWorkerRegistrationEnvironment {
  isProduction: boolean;
  isSecureContext: boolean;
  protocol: string;
  serviceWorker?: Pick<ServiceWorkerContainer, 'getRegistration' | 'register'>;
}

const pendingRegistrations = new WeakMap<NonNullable<ServiceWorkerRegistrationEnvironment['serviceWorker']>,
  Promise<ServiceWorkerRegistration | null>>();

const browserEnvironment = (): ServiceWorkerRegistrationEnvironment => ({
  isProduction: import.meta.env.PROD,
  isSecureContext: typeof window !== 'undefined' && window.isSecureContext,
  protocol: typeof window !== 'undefined' ? window.location.protocol : '',
  serviceWorker: typeof navigator !== 'undefined' && 'serviceWorker' in navigator
    ? navigator.serviceWorker
    : undefined,
});

export const isServiceWorkerOriginSupported = (protocol: string): boolean =>
  protocol === 'http:' || protocol === 'https:';

export const canUseServiceWorkers = (
  environment: Pick<
    ServiceWorkerRegistrationEnvironment,
    'isSecureContext' | 'protocol' | 'serviceWorker'
  >,
): boolean => environment.isSecureContext
  && isServiceWorkerOriginSupported(environment.protocol)
  && environment.serviceWorker !== undefined;

export const browserSupportsServiceWorkerOrigin = (): boolean =>
  typeof window !== 'undefined' && isServiceWorkerOriginSupported(window.location.protocol);

export const browserSupportsServiceWorkers = (): boolean =>
  canUseServiceWorkers(browserEnvironment());

export const canRegisterServiceWorker = (
  environment: ServiceWorkerRegistrationEnvironment,
): boolean => environment.isProduction
  && canUseServiceWorkers(environment);

/**
 * Look up or register the root worker only where the browser can actually use
 * service workers. Electron exposes a ServiceWorkerContainer on the secure
 * propr-app protocol, but Chromium rejects that protocol when its methods are
 * called.
 */
export async function getOrRegisterServiceWorker(
  environment: ServiceWorkerRegistrationEnvironment = browserEnvironment(),
): Promise<ServiceWorkerRegistration | null> {
  if (!canUseServiceWorkers(environment)) return null;
  const pending = pendingRegistrations.get(environment.serviceWorker!);
  if (pending) return pending;
  const existing = await environment.serviceWorker!.getRegistration('/');
  return existing ?? registerServiceWorker(environment);
}

/**
 * Register the PWA worker only for secure production builds. Development keeps
 * Vite's module graph and runtime configuration out of any persistent cache.
 */
export async function registerServiceWorker(
  environment: ServiceWorkerRegistrationEnvironment = browserEnvironment(),
): Promise<ServiceWorkerRegistration | null> {
  if (!canRegisterServiceWorker(environment)) return null;

  const serviceWorker = environment.serviceWorker!;
  const pending = pendingRegistrations.get(serviceWorker);
  if (pending) return pending;
  const registration = serviceWorker.register('/service-worker.js', {
    scope: '/',
    updateViaCache: 'none',
  }).catch(error => {
    console.warn('ProPR service worker registration failed', error);
    return null;
  }).finally(() => pendingRegistrations.delete(serviceWorker));
  pendingRegistrations.set(serviceWorker, registration);
  return registration;
}
