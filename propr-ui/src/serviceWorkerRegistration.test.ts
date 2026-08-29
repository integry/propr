import { describe, expect, test, vi } from 'vitest';
import {
  canRegisterServiceWorker,
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
    serviceWorker: {
      register: vi.fn().mockResolvedValue(registration),
    },
    ...overrides,
  };
}

describe('service worker registration', () => {
  test('registers the root-scoped worker without HTTP cache reuse in production', async () => {
    const current = environment();

    await expect(registerServiceWorker(current)).resolves.toBe(registration);
    expect(current.serviceWorker?.register).toHaveBeenCalledWith('/service-worker.js', {
      scope: '/',
      updateViaCache: 'none',
    });
  });

  test.each([
    ['development', { isProduction: false }],
    ['an insecure context', { isSecureContext: false }],
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
