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
    window.__PROPR_CONFIG__ = { apiBaseUrl: 'https://t-abc123.propr.dev' };
    const getApiBaseUrl = await loadGetApiBaseUrl();
    expect(getApiBaseUrl()).toBe('https://t-abc123.propr.dev');
  });

  it('prefers runtime config over the build-time env var', async () => {
    vi.stubEnv('VITE_API_BASE_URL', 'https://app.propr.dev');
    window.__PROPR_CONFIG__ = { apiBaseUrl: 'https://t-abc123.propr.dev' };
    const getApiBaseUrl = await loadGetApiBaseUrl();
    expect(getApiBaseUrl()).toBe('https://t-abc123.propr.dev');
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
    window.__PROPR_CONFIG__ = { apiBaseUrl: 'https://t-abc123.propr.dev/' };
    const getApiBaseUrl = await loadGetApiBaseUrl();
    expect(getApiBaseUrl()).toBe('https://t-abc123.propr.dev');
  });

  it('strips multiple trailing slashes', async () => {
    window.__PROPR_CONFIG__ = { apiBaseUrl: 'https://t-abc123.propr.dev///' };
    const getApiBaseUrl = await loadGetApiBaseUrl();
    expect(getApiBaseUrl()).toBe('https://t-abc123.propr.dev');
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
      hostedTunnelQueryApiBaseUrl('app.propr.dev', '?tunnel=t-abc123.propr.dev')
    ).toBe('https://t-abc123.propr.dev');
  });

  it('accepts a full hosted proxy URL and strips trailing slashes', async () => {
    const { hostedTunnelQueryApiBaseUrl } = await load();
    expect(
      hostedTunnelQueryApiBaseUrl('app.propr.dev', '?tunnel=https%3A%2F%2Ft-abc123.propr.dev%2F%2F')
    ).toBe('https://t-abc123.propr.dev');
  });

  it('accepts an instance id for manually built hosted UI links', async () => {
    const { hostedTunnelQueryApiBaseUrl } = await load();
    expect(hostedTunnelQueryApiBaseUrl('app.propr.dev', '?tunnel=abc123')).toBe(
      'https://t-abc123.propr.dev'
    );
  });

  it('ignores tunnel query params off the hosted UI origin', async () => {
    const { hostedTunnelQueryApiBaseUrl } = await load();
    expect(
      hostedTunnelQueryApiBaseUrl('propr.example.com', '?tunnel=t-abc123.propr.dev')
    ).toBeNull();
  });

  it('rejects non-ProPR proxy tunnel query params', async () => {
    const { hostedTunnelQueryApiBaseUrl } = await load();
    for (const bad of [
      '?tunnel=https%3A%2F%2Fcustom.example.com',
      '?tunnel=http%3A%2F%2Ft-abc123.propr.dev',
      '?tunnel=t-a.b.propr.dev',
      '?tunnel=t-abc123.propr.dev%2Fapi',
      '?tunnel=t-abc123.propr.dev%3Ffrom%3Dconnect',
      '?tunnel=t-abc123.propr.dev%23fragment',
      '?tunnel=%2Fapi'
    ]) {
      expect(hostedTunnelQueryApiBaseUrl('app.propr.dev', bad)).toBeNull();
    }
  });
});

describe('stored hosted tunnel API base (flow-token-gated sessionStorage)', () => {
  const load = async () => await import('./runtimeConfig');

  beforeEach(() => {
    vi.resetModules();
  });

  it('stores a valid hosted tunnel API base and a flow token in sessionStorage', async () => {
    const {
      HOSTED_TUNNEL_API_BASE_STORAGE_KEY,
      HOSTED_TUNNEL_FLOW_ID_KEY,
      rememberHostedTunnelApiBaseUrl,
    } = await load();
    const storage = memoryStorage();

    const flowId = rememberHostedTunnelApiBaseUrl(
      'app.propr.dev',
      'https://t-abc123.propr.dev/',
      storage
    );

    expect(typeof flowId).toBe('string');
    expect(flowId!.length).toBeGreaterThan(0);
    expect(storage.setItem).toHaveBeenCalledWith(
      HOSTED_TUNNEL_API_BASE_STORAGE_KEY,
      'https://t-abc123.propr.dev'
    );
    expect(storage.setItem).toHaveBeenCalledWith(HOSTED_TUNNEL_FLOW_ID_KEY, flowId);
  });

  it('reads a valid stored tunnel when the URL flow token matches', async () => {
    const {
      HOSTED_TUNNEL_API_BASE_STORAGE_KEY,
      HOSTED_TUNNEL_FLOW_ID_KEY,
      readStoredHostedTunnelApiBaseUrl,
    } = await load();
    const storage = memoryStorage({
      [HOSTED_TUNNEL_API_BASE_STORAGE_KEY]: 'https://t-abc123.propr.dev/',
      [HOSTED_TUNNEL_FLOW_ID_KEY]: 'test-flow-id',
    });

    expect(
      readStoredHostedTunnelApiBaseUrl('app.propr.dev', 'test-flow-id', storage)
    ).toBe('https://t-abc123.propr.dev');
    expect(
      readStoredHostedTunnelApiBaseUrl('propr.example.com', 'test-flow-id', storage)
    ).toBeNull();
  });

  it('rejects a stored tunnel when the URL flow token does not match', async () => {
    const {
      HOSTED_TUNNEL_API_BASE_STORAGE_KEY,
      HOSTED_TUNNEL_FLOW_ID_KEY,
      readStoredHostedTunnelApiBaseUrl,
    } = await load();
    const storage = memoryStorage({
      [HOSTED_TUNNEL_API_BASE_STORAGE_KEY]: 'https://t-abc123.propr.dev',
      [HOSTED_TUNNEL_FLOW_ID_KEY]: 'real-flow-id',
    });

    expect(readStoredHostedTunnelApiBaseUrl('app.propr.dev', 'wrong-flow-id', storage)).toBeNull();
    expect(readStoredHostedTunnelApiBaseUrl('app.propr.dev', null, storage)).toBeNull();
  });

  it('rejects storage that has no flow token (was never legitimately set)', async () => {
    const { HOSTED_TUNNEL_API_BASE_STORAGE_KEY, readStoredHostedTunnelApiBaseUrl } = await load();
    const storage = memoryStorage({
      [HOSTED_TUNNEL_API_BASE_STORAGE_KEY]: 'https://t-abc123.propr.dev',
      // No HOSTED_TUNNEL_FLOW_ID_KEY — simulates old/externally written storage
    });

    expect(readStoredHostedTunnelApiBaseUrl('app.propr.dev', 'any-flow-id', storage)).toBeNull();
    expect(readStoredHostedTunnelApiBaseUrl('app.propr.dev', null, storage)).toBeNull();
  });

  it('removes an invalid stored tunnel value when flow token matches', async () => {
    const {
      HOSTED_TUNNEL_API_BASE_STORAGE_KEY,
      HOSTED_TUNNEL_FLOW_ID_KEY,
      readStoredHostedTunnelApiBaseUrl,
    } = await load();
    const storage = memoryStorage({
      [HOSTED_TUNNEL_API_BASE_STORAGE_KEY]: 'https://custom.example.com',
      [HOSTED_TUNNEL_FLOW_ID_KEY]: 'my-flow',
    });

    expect(readStoredHostedTunnelApiBaseUrl('app.propr.dev', 'my-flow', storage)).toBeNull();
    expect(storage.removeItem).toHaveBeenCalledWith(HOSTED_TUNNEL_API_BASE_STORAGE_KEY);
  });

  it('two independent sessionStorage objects select different tunnels with no cross-over', async () => {
    const { readStoredHostedTunnelApiBaseUrl, rememberHostedTunnelApiBaseUrl } = await load();
    const storageA = memoryStorage();
    const storageB = memoryStorage();

    const flowIdA = rememberHostedTunnelApiBaseUrl('app.propr.dev', 'https://t-aaa111.propr.dev', storageA);
    const flowIdB = rememberHostedTunnelApiBaseUrl('app.propr.dev', 'https://t-bbb222.propr.dev', storageB);

    expect(readStoredHostedTunnelApiBaseUrl('app.propr.dev', flowIdA, storageA)).toBe('https://t-aaa111.propr.dev');
    expect(readStoredHostedTunnelApiBaseUrl('app.propr.dev', flowIdB, storageB)).toBe('https://t-bbb222.propr.dev');
    // Cross-tab: Tab A's flow ID does not unlock Tab B's storage and vice versa
    expect(readStoredHostedTunnelApiBaseUrl('app.propr.dev', flowIdA, storageB)).toBeNull();
    expect(readStoredHostedTunnelApiBaseUrl('app.propr.dev', flowIdB, storageA)).toBeNull();
  });

  it('does not read from an old localStorage entry — stale global value is ignored', async () => {
    const { readStoredHostedTunnelApiBaseUrl } = await load();
    // Simulate an empty sessionStorage (new tab) while a stale localStorage value exists.
    // The sessionStorage storage mock has no entry, so the result must be null.
    const emptySession = memoryStorage();
    expect(readStoredHostedTunnelApiBaseUrl('app.propr.dev', null, emptySession)).toBeNull();
    expect(readStoredHostedTunnelApiBaseUrl('app.propr.dev', 'any-flow', emptySession)).toBeNull();
  });

  // ── Regression: fresh context with prepopulated storage ──────────────────────
  it('rejects a fresh context whose sessionStorage was prepopulated from another tab but whose URL has no flow selector', async () => {
    const {
      HOSTED_TUNNEL_API_BASE_STORAGE_KEY,
      HOSTED_TUNNEL_FLOW_ID_KEY,
      readStoredHostedTunnelApiBaseUrl,
      resolveApiBaseUrl,
    } = await load();

    // Simulate Tab A's sessionStorage being copied into a new browsing context.
    const copiedStorage = memoryStorage({
      [HOSTED_TUNNEL_API_BASE_STORAGE_KEY]: 'https://t-tabA.propr.dev',
      [HOSTED_TUNNEL_FLOW_ID_KEY]: 'tab-a-flow-id',
    });

    // The new context has no ?tunnel= or ?flow= in its URL.
    expect(
      readStoredHostedTunnelApiBaseUrl('app.propr.dev', null, copiedStorage)
    ).toBeNull();
    expect(
      resolveApiBaseUrl('app.propr.dev', '', undefined, undefined, copiedStorage)
    ).toBe('');
  });

  // ── Regression: a direct new app.propr.dev visit never inherits a prior tab ──
  it('a direct new app.propr.dev visit with no query params resolves no instance even with prepopulated storage', async () => {
    const {
      HOSTED_TUNNEL_API_BASE_STORAGE_KEY,
      HOSTED_TUNNEL_FLOW_ID_KEY,
      hostedUiConnectionIssue,
    } = await load();

    const prepopulated = memoryStorage({
      [HOSTED_TUNNEL_API_BASE_STORAGE_KEY]: 'https://t-prior.propr.dev',
      [HOSTED_TUNNEL_FLOW_ID_KEY]: 'some-prior-flow',
    });

    const issue = hostedUiConnectionIssue('app.propr.dev', undefined, '', prepopulated);
    expect(issue?.title).toBe('Connect a ProPR stack');
  });

  // ── Regression: Tab A and Tab B keep their own tunnels across login redirects ─
  it('Tab A and Tab B each select a different tunnel and after login-redirect reloads still resolve only their own origin', async () => {
    const { rememberHostedTunnelApiBaseUrl, resolveApiBaseUrl } = await load();

    const storageA = memoryStorage();
    const storageB = memoryStorage();

    // Both tabs visit their respective ?tunnel= deep links and remember the selection.
    const flowIdA = rememberHostedTunnelApiBaseUrl('app.propr.dev', 'https://t-alpha.propr.dev', storageA);
    const flowIdB = rememberHostedTunnelApiBaseUrl('app.propr.dev', 'https://t-beta.propr.dev', storageB);

    // After login redirect, each tab's URL carries ?flow=<id>; ?tunnel= is gone.
    expect(
      resolveApiBaseUrl('app.propr.dev', `?flow=${flowIdA}`, undefined, undefined, storageA)
    ).toBe('https://t-alpha.propr.dev');
    expect(
      resolveApiBaseUrl('app.propr.dev', `?flow=${flowIdB}`, undefined, undefined, storageB)
    ).toBe('https://t-beta.propr.dev');

    // After a deep-route reload (/tasks), the flow token is still in the URL.
    expect(
      resolveApiBaseUrl('app.propr.dev', `?flow=${flowIdA}`, undefined, undefined, storageA)
    ).toBe('https://t-alpha.propr.dev');
    expect(
      resolveApiBaseUrl('app.propr.dev', `?flow=${flowIdB}`, undefined, undefined, storageB)
    ).toBe('https://t-beta.propr.dev');
  });

  // ── Regression: valid query/flow survives same-tab OAuth navigation ───────────
  it('a valid ?tunnel= selection survives same-tab OAuth navigation and subsequent ?flow= reload', async () => {
    const { rememberHostedTunnelApiBaseUrl, resolveApiBaseUrl } = await load();

    const storage = memoryStorage();

    // Initial load: ?tunnel= present → tunnel stored, flow token returned.
    const flowId = rememberHostedTunnelApiBaseUrl('app.propr.dev', 'https://t-abc123.propr.dev', storage);
    expect(typeof flowId).toBe('string');

    // Post-OAuth callback with ?flow= in URL (the login page threaded it through).
    expect(
      resolveApiBaseUrl('app.propr.dev', `?flow=${flowId}`, undefined, undefined, storage)
    ).toBe('https://t-abc123.propr.dev');

    // Deep-route reload still has ?flow= in URL.
    expect(
      resolveApiBaseUrl('app.propr.dev', `?flow=${flowId}`, undefined, undefined, storage)
    ).toBe('https://t-abc123.propr.dev');
  });

  // ── Regression: invalid tunnel input is rejected and does not overwrite ───────
  it('an invalid tunnel query param is not used as the API base and does not overwrite a valid current flow', async () => {
    const { rememberHostedTunnelApiBaseUrl, resolveApiBaseUrl } = await load();

    const storage = memoryStorage();
    const flowId = rememberHostedTunnelApiBaseUrl('app.propr.dev', 'https://t-valid.propr.dev', storage);

    // Someone navigates to ?tunnel=evil.example.com — invalid, must be rejected.
    const resultWithBadTunnel = resolveApiBaseUrl(
      'app.propr.dev',
      '?tunnel=evil.example.com',
      undefined,
      undefined,
      storage
    );
    expect(resultWithBadTunnel).not.toContain('evil');
    expect(resultWithBadTunnel).toBe('');  // no valid tunnel or flow in this URL

    // The stored valid tunnel is still intact — same-tab reload with flow token works.
    expect(
      resolveApiBaseUrl('app.propr.dev', `?flow=${flowId}`, undefined, undefined, storage)
    ).toBe('https://t-valid.propr.dev');
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
        '?tunnel=t-abc123.propr.dev',
        { apiBaseUrl: 'https://t-runtime.propr.dev' },
        'https://t-build.propr.dev',
        storage
      )
    ).toBe('https://t-abc123.propr.dev');
    expect(storage.setItem).toHaveBeenCalled();
  });

  it('falls back to runtime config when the tunnel query is invalid', async () => {
    const { resolveApiBaseUrl } = await load();
    expect(
      resolveApiBaseUrl(
        'app.propr.dev',
        '?tunnel=custom.example.com',
        { apiBaseUrl: 'https://t-runtime.propr.dev' },
        'https://t-build.propr.dev'
      )
    ).toBe('https://t-runtime.propr.dev');
  });

  it('uses the stored hosted tunnel when the query is gone after a login redirect and URL carries the flow token', async () => {
    const { HOSTED_TUNNEL_API_BASE_STORAGE_KEY, HOSTED_TUNNEL_FLOW_ID_KEY, resolveApiBaseUrl } = await load();
    const storage = memoryStorage({
      [HOSTED_TUNNEL_API_BASE_STORAGE_KEY]: 'https://t-abc123.propr.dev',
      [HOSTED_TUNNEL_FLOW_ID_KEY]: 'my-flow-id',
    });

    expect(
      resolveApiBaseUrl('app.propr.dev', '?flow=my-flow-id', undefined, undefined, storage)
    ).toBe('https://t-abc123.propr.dev');
  });

  it('does not use the stored hosted tunnel when URL has no flow token', async () => {
    const { HOSTED_TUNNEL_API_BASE_STORAGE_KEY, HOSTED_TUNNEL_FLOW_ID_KEY, resolveApiBaseUrl } = await load();
    const storage = memoryStorage({
      [HOSTED_TUNNEL_API_BASE_STORAGE_KEY]: 'https://t-abc123.propr.dev',
      [HOSTED_TUNNEL_FLOW_ID_KEY]: 'my-flow-id',
    });

    // Simulates a new tab that inherited sessionStorage but navigated to app.propr.dev
    // without a ?flow= parameter — must not use the inherited tunnel.
    expect(
      resolveApiBaseUrl('app.propr.dev', '', undefined, undefined, storage)
    ).toBe('');
  });

  it('does not use the stored hosted tunnel on self-hosted origins', async () => {
    const { HOSTED_TUNNEL_API_BASE_STORAGE_KEY, HOSTED_TUNNEL_FLOW_ID_KEY, resolveApiBaseUrl } = await load();
    const storage = memoryStorage({
      [HOSTED_TUNNEL_API_BASE_STORAGE_KEY]: 'https://t-abc123.propr.dev',
      [HOSTED_TUNNEL_FLOW_ID_KEY]: 'my-flow-id',
    });

    expect(
      resolveApiBaseUrl(
        'propr.example.com',
        '?flow=my-flow-id',
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
        '?tunnel=t-abc123.propr.dev'
      )
    ).toBeNull();
  });

  it('does not warn about missing config when a stored hosted tunnel with matching flow token is present', async () => {
    const { runtimeConfigWarning, HOSTED_TUNNEL_API_BASE_STORAGE_KEY, HOSTED_TUNNEL_FLOW_ID_KEY } =
      await (await import('./runtimeConfig'), vi.resetModules(), import('./runtimeConfig'));
    const storage = memoryStorage({
      [HOSTED_TUNNEL_API_BASE_STORAGE_KEY]: 'https://t-abc123.propr.dev',
      [HOSTED_TUNNEL_FLOW_ID_KEY]: 'my-flow',
    });

    expect(runtimeConfigWarning('app.propr.dev', undefined, '?flow=my-flow', storage)).toBeNull();
  });

  it('warns when storage has a tunnel but URL has no matching flow token', async () => {
    const { runtimeConfigWarning, HOSTED_TUNNEL_API_BASE_STORAGE_KEY, HOSTED_TUNNEL_FLOW_ID_KEY } =
      await import('./runtimeConfig');
    const storage = memoryStorage({
      [HOSTED_TUNNEL_API_BASE_STORAGE_KEY]: 'https://t-abc123.propr.dev',
      [HOSTED_TUNNEL_FLOW_ID_KEY]: 'my-flow',
    });

    // No ?flow= in URL → inherited storage is not trusted → warning fires.
    expect(runtimeConfigWarning('app.propr.dev', undefined, '', storage)).not.toBeNull();
  });

  it('warns on the hosted UI origin when apiBaseUrl is empty', async () => {
    const runtimeConfigWarning = await loadWarning();
    expect(runtimeConfigWarning('app.propr.dev', { apiBaseUrl: '' })).toContain('apiBaseUrl is empty');
    expect(runtimeConfigWarning('app.propr.dev', { apiBaseUrl: '   ' })).toContain('apiBaseUrl is empty');
  });

  it('does not warn when apiBaseUrl is configured', async () => {
    const runtimeConfigWarning = await loadWarning();
    expect(runtimeConfigWarning('app.propr.dev', { apiBaseUrl: 'https://t-abc123.propr.dev' })).toBeNull();
  });

  it('warns on the hosted UI origin when apiBaseUrl is not a valid http(s) URL', async () => {
    const runtimeConfigWarning = await loadWarning();
    for (const bad of ['t-abc123.propr.dev', '/api', 'ftp://t-abc123.propr.dev', 'not a url']) {
      expect(runtimeConfigWarning('app.propr.dev', { apiBaseUrl: bad })).toContain('not a valid http(s) URL');
    }
  });

  it('warns on the hosted UI origin when apiBaseUrl is a valid URL but not a ProPR proxy URL', async () => {
    const runtimeConfigWarning = await loadWarning();
    for (const notProxy of ['https://custom.example.com', 'http://t-abc123.propr.dev', 'https://t-a.b.propr.dev']) {
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

  it('does not block hosted UI visits with a query tunnel', async () => {
    const hostedUiConnectionIssue = await loadIssue();
    expect(
      hostedUiConnectionIssue('app.propr.dev', undefined, '?tunnel=t-abc123.propr.dev')
    ).toBeNull();
  });

  it('does not block hosted UI visits with a stored tunnel and matching flow token', async () => {
    const { hostedUiConnectionIssue, HOSTED_TUNNEL_API_BASE_STORAGE_KEY, HOSTED_TUNNEL_FLOW_ID_KEY } =
      await import('./runtimeConfig');
    const storage = memoryStorage({
      [HOSTED_TUNNEL_API_BASE_STORAGE_KEY]: 'https://t-stored.propr.dev',
      [HOSTED_TUNNEL_FLOW_ID_KEY]: 'flow-xyz',
    });

    expect(hostedUiConnectionIssue('app.propr.dev', undefined, '?flow=flow-xyz', storage)).toBeNull();
  });

  it('blocks when storage has a tunnel but URL has no matching flow token', async () => {
    const { hostedUiConnectionIssue, HOSTED_TUNNEL_API_BASE_STORAGE_KEY, HOSTED_TUNNEL_FLOW_ID_KEY } =
      await import('./runtimeConfig');
    const storage = memoryStorage({
      [HOSTED_TUNNEL_API_BASE_STORAGE_KEY]: 'https://t-stored.propr.dev',
      [HOSTED_TUNNEL_FLOW_ID_KEY]: 'flow-xyz',
    });

    // Inherited storage without URL authority → should block and prompt reconnect.
    expect(
      hostedUiConnectionIssue('app.propr.dev', undefined, '', storage)?.title
    ).toBe('Connect a ProPR stack');
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
    expect(isValidHttpUrl('https://t-abc123.propr.dev')).toBe(true);
    expect(isValidHttpUrl('http://localhost:4000')).toBe(true);
  });

  it('rejects scheme-less hosts, paths, non-http schemes, and junk', async () => {
    const isValidHttpUrl = await load();
    for (const bad of ['t-abc123.propr.dev', '/api', 'ftp://host', 'not a url', '']) {
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
    for (const other of ['localhost', '127.0.0.1', 't-abc123.propr.dev', 'propr.example.com', 'example.com']) {
      expect(isHostedUiOrigin(other)).toBe(false);
    }
  });
});

describe('legacy localStorage key removal', () => {
  const load = async () => await import('./runtimeConfig');

  beforeEach(() => {
    vi.resetModules();
  });

  it('removes the legacy localStorage key on module load and never uses its value', async () => {
    const LEGACY_KEY = 'propr.hostedTunnelApiBaseUrl';

    // Pre-populate localStorage with a value that would have been used by the
    // old localStorage-based implementation.
    window.localStorage.setItem(LEGACY_KEY, 'https://t-legacy.propr.dev');

    // Import the module — the side-effect block must remove the key.
    const { readStoredHostedTunnelApiBaseUrl, resolveApiBaseUrl } = await load();

    // The key must have been removed from localStorage.
    expect(window.localStorage.getItem(LEGACY_KEY)).toBeNull();

    // The value must NOT have been migrated — sessionStorage is empty, so
    // the function returns null regardless of what was in localStorage.
    const emptySession = memoryStorage();
    expect(readStoredHostedTunnelApiBaseUrl('app.propr.dev', null, emptySession)).toBeNull();
    expect(resolveApiBaseUrl('app.propr.dev', '', undefined, undefined, emptySession)).toBe('');

    // Clean up
    window.localStorage.removeItem(LEGACY_KEY);
  });
});
