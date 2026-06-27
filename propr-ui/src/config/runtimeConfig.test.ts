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

  it('strips a trailing slash from the runtime value so paths do not double up', async () => {
    window.__PROPR_CONFIG__ = { apiBaseUrl: 'https://abc123.proxy.propr.dev/' };
    const getApiBaseUrl = await loadGetApiBaseUrl();
    expect(getApiBaseUrl()).toBe('https://abc123.proxy.propr.dev');
  });

  it('strips multiple trailing slashes', async () => {
    window.__PROPR_CONFIG__ = { apiBaseUrl: 'https://abc123.proxy.propr.dev///' };
    const getApiBaseUrl = await loadGetApiBaseUrl();
    expect(getApiBaseUrl()).toBe('https://abc123.proxy.propr.dev');
  });

  it('strips a trailing slash from the build-time env var', async () => {
    vi.stubEnv('VITE_API_BASE_URL', 'https://app.propr.dev/');
    const getApiBaseUrl = await loadGetApiBaseUrl();
    expect(getApiBaseUrl()).toBe('https://app.propr.dev');
  });
});

describe('runtimeConfigWarning', () => {
  const loadWarning = async () => (await import('./runtimeConfig')).runtimeConfigWarning;

  beforeEach(() => {
    vi.resetModules();
  });

  it('warns on the hosted UI origin when config.js did not load', async () => {
    const runtimeConfigWarning = await loadWarning();
    expect(runtimeConfigWarning('app.propr.dev', undefined)).toContain('config.js did not load');
  });

  it('warns on the hosted UI origin when apiBaseUrl is empty', async () => {
    const runtimeConfigWarning = await loadWarning();
    expect(runtimeConfigWarning('app.propr.dev', { apiBaseUrl: '' })).toContain('apiBaseUrl is empty');
    expect(runtimeConfigWarning('app.propr.dev', { apiBaseUrl: '   ' })).toContain('apiBaseUrl is empty');
  });

  it('does not warn when apiBaseUrl is configured', async () => {
    const runtimeConfigWarning = await loadWarning();
    expect(runtimeConfigWarning('app.propr.dev', { apiBaseUrl: 'https://abc123.proxy.propr.dev' })).toBeNull();
  });

  it('warns on the hosted UI origin when apiBaseUrl is not a valid http(s) URL', async () => {
    const runtimeConfigWarning = await loadWarning();
    for (const bad of ['abc123.proxy.propr.dev', '/api', 'ftp://abc.proxy.propr.dev', 'not a url']) {
      expect(runtimeConfigWarning('app.propr.dev', { apiBaseUrl: bad })).toContain('not a valid http(s) URL');
    }
  });

  it('does not warn on localhost regardless of config', async () => {
    const runtimeConfigWarning = await loadWarning();
    expect(runtimeConfigWarning('localhost', undefined)).toBeNull();
    expect(runtimeConfigWarning('127.0.0.1', { apiBaseUrl: '' })).toBeNull();
  });

  it('does not warn on a self-hosted same-origin deployment', async () => {
    // A self-hosted production UI on its own domain ships the UI and API
    // together, so an empty apiBaseUrl (same-origin) is correct, not a misconfig.
    const runtimeConfigWarning = await loadWarning();
    expect(runtimeConfigWarning('propr.example.com', undefined)).toBeNull();
    expect(runtimeConfigWarning('propr.example.com', { apiBaseUrl: '' })).toBeNull();
  });
});

describe('isValidHttpUrl', () => {
  const load = async () => (await import('./runtimeConfig')).isValidHttpUrl;

  beforeEach(() => {
    vi.resetModules();
  });

  it('accepts absolute http and https URLs', async () => {
    const isValidHttpUrl = await load();
    expect(isValidHttpUrl('https://abc123.proxy.propr.dev')).toBe(true);
    expect(isValidHttpUrl('http://localhost:4000')).toBe(true);
  });

  it('rejects scheme-less hosts, paths, non-http schemes, and junk', async () => {
    const isValidHttpUrl = await load();
    for (const bad of ['abc123.proxy.propr.dev', '/api', 'ftp://host', 'not a url', '']) {
      expect(isValidHttpUrl(bad)).toBe(false);
    }
  });
});

describe('isLocalhostHostname / isHostedUiOrigin', () => {
  const load = async () => await import('./runtimeConfig');

  beforeEach(() => {
    vi.resetModules();
  });

  it('treats only the hosted UI origin as hosted', async () => {
    const { isLocalhostHostname, isHostedUiOrigin } = await load();
    expect(isHostedUiOrigin('app.propr.dev')).toBe(true);
    // localhost, per-instance proxies, and self-hosted domains are NOT the
    // managed hosted UI origin.
    for (const local of ['localhost', '127.0.0.1']) {
      expect(isLocalhostHostname(local)).toBe(true);
      expect(isHostedUiOrigin(local)).toBe(false);
    }
    for (const other of ['abc123.proxy.propr.dev', 'propr.example.com', 'example.com']) {
      expect(isHostedUiOrigin(other)).toBe(false);
    }
  });
});
