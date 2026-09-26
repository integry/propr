import { describe, expect, test, vi } from 'vitest';
import {
  canRegisterServiceWorker,
  canUseServiceWorkers,
  getOrRegisterServiceWorker,
  isServiceWorkerOriginSupported,
  registerServiceWorker,
  type ServiceWorkerRegistrationEnvironment,
} from './serviceWorkerRegistration';

const registration = {} as ServiceWorkerRegistration;

function environment(
  overrides: Partial<ServiceWorkerRegistrationEnvironment> = {},
): ServiceWorkerRegistrationEnvironment {
  return {
    isProduction: true,
    isSecureContext: true,
    protocol: 'https:',
    serviceWorker: {
      getRegistration: vi.fn().mockResolvedValue(null),
      register: vi.fn().mockResolvedValue(registration),
    },
    ...overrides,
  };
}

describe('service worker registration', () => {
  test.each(['http:', 'https:'])('recognizes the supported %s browser protocol', protocol => {
    expect(isServiceWorkerOriginSupported(protocol)).toBe(true);
  });

  test('registers the root-scoped worker without HTTP cache reuse in production', async () => {
    const current = environment();

    await expect(registerServiceWorker(current)).resolves.toBe(registration);
    expect(current.serviceWorker?.register).toHaveBeenCalledWith('/service-worker.js', {
      scope: '/',
      updateViaCache: 'none',
    });
  });

  test('reuses an existing registration on a supported HTTPS origin', async () => {
    const current = environment();
    current.serviceWorker!.getRegistration = vi.fn().mockResolvedValue(registration);

    await expect(getOrRegisterServiceWorker(current)).resolves.toBe(registration);
    expect(current.serviceWorker?.getRegistration).toHaveBeenCalledWith('/');
    expect(current.serviceWorker?.register).not.toHaveBeenCalled();
  });

  test('rejects the propr-app origin before invoking exposed service worker APIs', async () => {
    const current = environment({ protocol: 'propr-app:' });

    expect(isServiceWorkerOriginSupported(current.protocol)).toBe(false);
    expect(canUseServiceWorkers(current)).toBe(false);
    expect(canRegisterServiceWorker(current)).toBe(false);
    await expect(getOrRegisterServiceWorker(current)).resolves.toBeNull();
    await expect(registerServiceWorker(current)).resolves.toBeNull();
    expect(current.serviceWorker?.getRegistration).not.toHaveBeenCalled();
    expect(current.serviceWorker?.register).not.toHaveBeenCalled();
  });

  test.each([
    ['development', { isProduction: false }],
    ['an insecure context', { isSecureContext: false }],
    ['an unsupported origin', { protocol: 'file:' }],
    ['a browser without service workers', { serviceWorker: undefined }],
  ])('does not register in %s', async (_name, overrides) => {
    const current = environment(overrides);

    expect(canRegisterServiceWorker(current)).toBe(false);
    await expect(registerServiceWorker(current)).resolves.toBeNull();
    if (current.serviceWorker) {
      expect(current.serviceWorker.register).not.toHaveBeenCalled();
    }
  });

  test('contains registration failures and leaves the application usable', async () => {
    const current = environment({
      serviceWorker: {
        getRegistration: vi.fn().mockResolvedValue(null),
        register: vi.fn().mockRejectedValue(new Error('registration unavailable')),
      },
    });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(registerServiceWorker(current)).resolves.toBeNull();
    expect(warning).toHaveBeenCalledWith(
      'ProPR service worker registration failed',
      expect.any(Error),
    );

    warning.mockRestore();
  });
});
