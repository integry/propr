import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// getApiBaseUrl reads window.__PROPR_CONFIG__ at module-load time, so each case
// resets modules and re-imports after setting up the desired environment.
const loadGetApiBaseUrl = async () => {
  const mod = await import('./runtimeConfig');
  return mod.getApiBaseUrl;
};

const memoryStorage = (initial: Record<string, string> = {}) => {
  const values = new Map(Object.entries(initial));
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      values.delete(key);
    })
  };
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

  it('trims whitespace around the build-time env var', async () => {
    vi.stubEnv('VITE_API_BASE_URL', '  https://app.propr.dev/  ');
    const getApiBaseUrl = await loadGetApiBaseUrl();
    expect(getApiBaseUrl()).toBe('https://app.propr.dev');
  });
});

describe('hosted tunnel query API base', () => {
  const load = async () => await import('./runtimeConfig');

  beforeEach(() => {
    vi.resetModules();
  });

  it('accepts the Connect tunnel hostname on the hosted UI origin', async () => {
    const { hostedTunnelQueryApiBaseUrl } = await load();
    expect(
      hostedTunnelQueryApiBaseUrl('app.propr.dev', '?tunnel=abc123.proxy.propr.dev')
    ).toBe('https://abc123.proxy.propr.dev');
  });

  it('accepts a full hosted proxy URL and strips trailing slashes', async () => {
    const { hostedTunnelQueryApiBaseUrl } = await load();
    expect(
      hostedTunnelQueryApiBaseUrl('app.propr.dev', '?tunnel=https%3A%2F%2Fabc123.proxy.propr.dev%2F%2F')
    ).toBe('https://abc123.proxy.propr.dev');
  });

  it('accepts an instance id for manually built hosted UI links', async () => {
    const { hostedTunnelQueryApiBaseUrl } = await load();
    expect(hostedTunnelQueryApiBaseUrl('app.propr.dev', '?tunnel=abc123')).toBe(
      'https://abc123.proxy.propr.dev'
    );
  });

  it('ignores tunnel query params off the hosted UI origin', async () => {
    const { hostedTunnelQueryApiBaseUrl } = await load();
    expect(
      hostedTunnelQueryApiBaseUrl('propr.example.com', '?tunnel=abc123.proxy.propr.dev')
    ).toBeNull();
  });

  it('rejects non-ProPR proxy tunnel query params', async () => {
    const { hostedTunnelQueryApiBaseUrl } = await load();
    for (const bad of [
      '?tunnel=https%3A%2F%2Fcustom.example.com',
      '?tunnel=http%3A%2F%2Fabc123.proxy.propr.dev',
      '?tunnel=a.b.proxy.propr.dev',
      '?tunnel=abc123.proxy.propr.dev%2Fapi',
      '?tunnel=abc123.proxy.propr.dev%3Ffrom%3Dconnect',
      '?tunnel=abc123.proxy.propr.dev%23fragment',
      '?tunnel=%2Fapi'
    ]) {
      expect(hostedTunnelQueryApiBaseUrl('app.propr.dev', bad)).toBeNull();
    }
  });
});

describe('stored hosted tunnel API base', () => {
  const load = async () => await import('./runtimeConfig');

  beforeEach(() => {
    vi.resetModules();
  });

  it('stores a valid hosted tunnel API base for later hosted UI reloads', async () => {
    const { HOSTED_TUNNEL_API_BASE_STORAGE_KEY, rememberHostedTunnelApiBaseUrl } =
      await load();
    const storage = memoryStorage();

    rememberHostedTunnelApiBaseUrl(
      'app.propr.dev',
      'https://abc123.proxy.propr.dev/',
      storage
    );

    expect(storage.setItem).toHaveBeenCalledWith(
      HOSTED_TUNNEL_API_BASE_STORAGE_KEY,
      'https://abc123.proxy.propr.dev'
    );
  });

  it('reads a valid stored hosted tunnel only on the hosted UI origin', async () => {
    const { readStoredHostedTunnelApiBaseUrl } = await load();
    const storage = memoryStorage({
      'propr.hostedTunnelApiBaseUrl': 'https://abc123.proxy.propr.dev/'
    });

    expect(readStoredHostedTunnelApiBaseUrl('app.propr.dev', storage)).toBe(
      'https://abc123.proxy.propr.dev'
    );
    expect(readStoredHostedTunnelApiBaseUrl('propr.example.com', storage)).toBeNull();
  });

  it('removes an invalid stored hosted tunnel value', async () => {
    const { HOSTED_TUNNEL_API_BASE_STORAGE_KEY, readStoredHostedTunnelApiBaseUrl } =
      await load();
    const storage = memoryStorage({
      [HOSTED_TUNNEL_API_BASE_STORAGE_KEY]: 'https://custom.example.com'
    });

    expect(readStoredHostedTunnelApiBaseUrl('app.propr.dev', storage)).toBeNull();
    expect(storage.removeItem).toHaveBeenCalledWith(
      HOSTED_TUNNEL_API_BASE_STORAGE_KEY
    );
  });
});

describe('resolveApiBaseUrl', () => {
  const load = async () => await import('./runtimeConfig');

  beforeEach(() => {
    vi.resetModules();
  });

  it('prefers the hosted Connect tunnel deep link over runtime config and build-time config', async () => {
    const { resolveApiBaseUrl } = await load();
    const storage = memoryStorage();
    expect(
      resolveApiBaseUrl(
        'app.propr.dev',
        '?tunnel=abc123.proxy.propr.dev',
        { apiBaseUrl: 'https://runtime.proxy.propr.dev' },
        'https://build.proxy.propr.dev',
        storage
      )
    ).toBe('https://abc123.proxy.propr.dev');
    expect(storage.setItem).toHaveBeenCalled();
  });

  it('falls back to runtime config when the tunnel query is invalid', async () => {
    const { resolveApiBaseUrl } = await load();
    expect(
      resolveApiBaseUrl(
        'app.propr.dev',
        '?tunnel=custom.example.com',
        { apiBaseUrl: 'https://runtime.proxy.propr.dev' },
        'https://build.proxy.propr.dev'
      )
    ).toBe('https://runtime.proxy.propr.dev');
  });

  it('uses the stored hosted tunnel when the query is gone after a login redirect', async () => {
    const { HOSTED_TUNNEL_API_BASE_STORAGE_KEY, resolveApiBaseUrl } = await load();
    const storage = memoryStorage({
      [HOSTED_TUNNEL_API_BASE_STORAGE_KEY]: 'https://abc123.proxy.propr.dev'
    });

    expect(
      resolveApiBaseUrl('app.propr.dev', '', undefined, undefined, storage)
    ).toBe('https://abc123.proxy.propr.dev');
  });

  it('does not use the stored hosted tunnel on self-hosted origins', async () => {
    const { HOSTED_TUNNEL_API_BASE_STORAGE_KEY, resolveApiBaseUrl } = await load();
    const storage = memoryStorage({
      [HOSTED_TUNNEL_API_BASE_STORAGE_KEY]: 'https://abc123.proxy.propr.dev'
    });

    expect(
      resolveApiBaseUrl(
        'propr.example.com',
        '',
        { apiBaseUrl: 'https://runtime.example.com' },
        undefined,
        storage
      )
    ).toBe('https://runtime.example.com');
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

  it('does not warn about missing config when a valid Connect tunnel deep link is present', async () => {
    const runtimeConfigWarning = await loadWarning();
    expect(
      runtimeConfigWarning(
        'app.propr.dev',
        undefined,
        '?tunnel=abc123.proxy.propr.dev'
      )
    ).toBeNull();
  });

  it('does not warn about missing config when a stored hosted tunnel is present', async () => {
    const runtimeConfigWarning = await loadWarning();
    const storage = memoryStorage({
      'propr.hostedTunnelApiBaseUrl': 'https://abc123.proxy.propr.dev'
    });

    expect(runtimeConfigWarning('app.propr.dev', undefined, '', storage)).toBeNull();
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

  it('warns on the hosted UI origin when apiBaseUrl is a valid URL but not a ProPR proxy URL', async () => {
    const runtimeConfigWarning = await loadWarning();
    for (const notProxy of ['https://custom.example.com', 'http://abc123.proxy.propr.dev', 'https://a.b.proxy.propr.dev']) {
      expect(runtimeConfigWarning('app.propr.dev', { apiBaseUrl: notProxy })).toContain('not a hosted ProPR proxy URL');
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

describe('hosted UI connection issue', () => {
  const loadIssue = async () => (await import('./runtimeConfig')).hostedUiConnectionIssue;

  beforeEach(() => {
    vi.resetModules();
  });

  it('blocks direct hosted UI visits without a selected tunnel or runtime API URL', async () => {
    const hostedUiConnectionIssue = await loadIssue();
    expect(hostedUiConnectionIssue('app.propr.dev', undefined)?.title).toBe('Connect a ProPR stack');
    expect(hostedUiConnectionIssue('app.propr.dev', { apiBaseUrl: '' })?.title).toBe('Connect a ProPR stack');
  });

  it('does not block hosted UI visits with a query or stored tunnel', async () => {
    const hostedUiConnectionIssue = await loadIssue();
    const storage = memoryStorage({
      'propr.hostedTunnelApiBaseUrl': 'https://stored.proxy.propr.dev',
    });

    expect(
      hostedUiConnectionIssue('app.propr.dev', undefined, '?tunnel=abc123.proxy.propr.dev')
    ).toBeNull();
    expect(hostedUiConnectionIssue('app.propr.dev', undefined, '', storage)).toBeNull();
  });

  it('blocks invalid hosted runtime API URLs', async () => {
    const hostedUiConnectionIssue = await loadIssue();
    expect(hostedUiConnectionIssue('app.propr.dev', { apiBaseUrl: '/api' })?.title).toBe(
      'Invalid hosted UI configuration'
    );
    expect(
      hostedUiConnectionIssue('app.propr.dev', { apiBaseUrl: 'https://custom.example.com' })?.title
    ).toBe('Invalid hosted UI tunnel');
  });

  it('does not block local or self-hosted origins', async () => {
    const hostedUiConnectionIssue = await loadIssue();
    expect(hostedUiConnectionIssue('localhost', undefined)).toBeNull();
    expect(hostedUiConnectionIssue('propr.example.com', { apiBaseUrl: '' })).toBeNull();
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

describe('isHostedUiOrigin', () => {
  const load = async () => await import('./runtimeConfig');

  beforeEach(() => {
    vi.resetModules();
  });

  it('treats only the hosted UI origin as hosted', async () => {
    const { isHostedUiOrigin } = await load();
    expect(isHostedUiOrigin('app.propr.dev')).toBe(true);
    // localhost, per-instance proxies, and self-hosted domains are NOT the
    // managed hosted UI origin.
    for (const other of ['localhost', '127.0.0.1', 'abc123.proxy.propr.dev', 'propr.example.com', 'example.com']) {
      expect(isHostedUiOrigin(other)).toBe(false);
    }
  });
});
