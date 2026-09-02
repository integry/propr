export interface ServiceWorkerRegistrationEnvironment {
  isProduction: boolean;
  isSecureContext: boolean;
  serviceWorker?: Pick<ServiceWorkerContainer, 'register'>;
}

const browserEnvironment = (): ServiceWorkerRegistrationEnvironment => ({
  isProduction: import.meta.env.PROD,
  isSecureContext: typeof window !== 'undefined' && window.isSecureContext,
  serviceWorker: typeof navigator !== 'undefined' && 'serviceWorker' in navigator
    ? navigator.serviceWorker
    : undefined,
});

export const canRegisterServiceWorker = (
  environment: ServiceWorkerRegistrationEnvironment,
): boolean => environment.isProduction
  && environment.isSecureContext
  && environment.serviceWorker !== undefined;

/**
 * Register the PWA worker only for secure production builds. Development keeps
 * Vite's module graph and runtime configuration out of any persistent cache.
 */
export async function registerServiceWorker(
  environment: ServiceWorkerRegistrationEnvironment = browserEnvironment(),
): Promise<ServiceWorkerRegistration | null> {
  if (!canRegisterServiceWorker(environment)) return null;

  try {
    return await environment.serviceWorker!.register('/service-worker.js', {
      scope: '/',
      updateViaCache: 'none',
    });
  } catch (error) {
    console.warn('ProPR service worker registration failed', error);
    return null;
  }
}
