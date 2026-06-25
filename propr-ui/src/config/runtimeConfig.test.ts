import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// getApiBaseUrl reads window.__PROPR_CONFIG__ at module-load time, so each case
// resets modules and re-imports after setting up the desired environment.
const loadGetApiBaseUrl = async () => {
  const mod = await import('./runtimeConfig');
  return mod.getApiBaseUrl;
};

describe('getApiBaseUrl', () => {
  beforeEach(() => {
    vi.resetModules();
    delete window.__PROPR_CONFIG__;
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    delete window.__PROPR_CONFIG__;
    vi.unstubAllEnvs();
  });

  it('uses the runtime-configured apiBaseUrl when present', async () => {
    window.__PROPR_CONFIG__ = { apiBaseUrl: 'https://abc123.proxy.propr.dev' };
    const getApiBaseUrl = await loadGetApiBaseUrl();
    expect(getApiBaseUrl()).toBe('https://abc123.proxy.propr.dev');
  });

  it('prefers runtime config over the build-time env var', async () => {
    vi.stubEnv('VITE_API_BASE_URL', 'https://app.propr.dev');
    window.__PROPR_CONFIG__ = { apiBaseUrl: 'https://abc123.proxy.propr.dev' };
    const getApiBaseUrl = await loadGetApiBaseUrl();
    expect(getApiBaseUrl()).toBe('https://abc123.proxy.propr.dev');
  });

  it('falls back to the build-time env var when runtime config is empty', async () => {
    vi.stubEnv('VITE_API_BASE_URL', 'https://app.propr.dev');
    window.__PROPR_CONFIG__ = { apiBaseUrl: '' };
    const getApiBaseUrl = await loadGetApiBaseUrl();
    expect(getApiBaseUrl()).toBe('https://app.propr.dev');
  });

  it('treats a whitespace-only runtime value as empty', async () => {
    window.__PROPR_CONFIG__ = { apiBaseUrl: '   ' };
    const getApiBaseUrl = await loadGetApiBaseUrl();
    expect(getApiBaseUrl()).toBe('');
  });

  it('returns an empty string (same-origin) when nothing is configured', async () => {
    const getApiBaseUrl = await loadGetApiBaseUrl();
    expect(getApiBaseUrl()).toBe('');
  });
});
