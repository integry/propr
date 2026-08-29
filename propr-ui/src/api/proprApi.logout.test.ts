import { afterEach, describe, expect, it, vi } from 'vitest';

const memoryStorage = (initial: Record<string, string> = {}) => {
  const values = new Map(Object.entries(initial));
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      values.delete(key);
    }),
  };
};

type MemoryStorage = ReturnType<typeof memoryStorage>;

interface TestWindow {
  __PROPR_CONFIG__?: { apiBaseUrl?: string };
  alert: ReturnType<typeof vi.fn>;
  history: { replaceState: ReturnType<typeof vi.fn> };
  localStorage: MemoryStorage;
  location: {
    hash: string;
    hostname: string;
    href: string;
    pathname: string;
    search: string;
  };
  name: string;
  proprDesktop?: {
    auth: { logout: ReturnType<typeof vi.fn> };
    external: { open: ReturnType<typeof vi.fn> };
  };
  sessionStorage: MemoryStorage;
}

const hostedStorage = (flowId: string, apiBaseUrl: string): Record<string, string> => ({
  'propr.hostedTunnelApiBaseUrl': apiBaseUrl,
  'propr.hostedTunnelContextId': 'hosted-context',
  'propr.hostedTunnelFlowId': flowId,
});

const stubTestWindow = ({
  apiBaseUrl,
  hostname,
  href,
  name = '',
  pathname = '/',
  search = '',
  sessionInitial = {},
}: {
  apiBaseUrl?: string;
  hostname: string;
  href: string;
  name?: string;
  pathname?: string;
  search?: string;
  sessionInitial?: Record<string, string>;
}): TestWindow => {
  const testWindow: TestWindow = {
    __PROPR_CONFIG__: apiBaseUrl ? { apiBaseUrl } : undefined,
    alert: vi.fn(),
    history: { replaceState: vi.fn() },
    localStorage: memoryStorage(),
    location: { hash: '', hostname, href, pathname, search },
    name,
    sessionStorage: memoryStorage(sessionInitial),
  };
  vi.stubGlobal('window', testWindow);
  return testWindow;
};

const importProprApi = async () => {
  const mod = await import('./proprApi');
  return mod;
};

describe('logout', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('logs out hosted UI through the exact resolved tunnel with credentials and manual redirect', async () => {
    const flowId = 'active-flow';
    const testWindow = stubTestWindow({
      hostname: 'app.propr.dev',
      href: `https://app.propr.dev/tasks?flow=${flowId}&flow=attacker`,
      name: 'propr-hosted-flow-context:hosted-context|tab-name',
      pathname: '/tasks',
      search: `?flow=${flowId}&flow=attacker`,
      sessionInitial: hostedStorage(flowId, 'https://t-active.propr.dev'),
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 302 }));
    const { API_BASE_URL, logout } = await importProprApi();

    await Promise.resolve(logout());

    expect(API_BASE_URL).toBe('https://t-active.propr.dev');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith(new URL('https://t-active.propr.dev/api/auth/logout'), {
      credentials: 'include',
      redirect: 'manual',
    });
    expect(testWindow.location.href).toBe(`/login?logged_out=true&flow=${flowId}`);
    expect(testWindow.location.href.match(/flow=/g)).toHaveLength(1);
    expect(testWindow.location.href).not.toContain('attacker');
  });

  it('keeps the hosted tab authority intact and surfaces a clear failure when logout fetch fails', async () => {
    const flowId = 'failing-flow';
    const testWindow = stubTestWindow({
      hostname: 'app.propr.dev',
      href: `https://app.propr.dev/settings?flow=${flowId}`,
      name: 'propr-hosted-flow-context:hosted-context|tab-name',
      pathname: '/settings',
      search: `?flow=${flowId}`,
      sessionInitial: hostedStorage(flowId, 'https://t-failing.propr.dev'),
    });
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { getActiveHostedTunnelFlowId } = await import('../config/runtimeConfig');
    const { logout } = await importProprApi();

    await Promise.resolve(logout());

    expect(testWindow.location.href).toBe(`https://app.propr.dev/settings?flow=${flowId}`);
    expect(getActiveHostedTunnelFlowId()).toBe(flowId);
    expect(testWindow.alert).toHaveBeenCalledWith(
      'Unable to log out from the active hosted ProPR tunnel. Check the connection and try again.'
    );
    expect(errorSpy).toHaveBeenCalledWith(
      '[propr] Hosted logout failed; keeping the active hosted tunnel in this tab.',
      expect.any(Error)
    );
  });

  it('does not send duplicate hosted logout requests while one is in flight', async () => {
    const flowId = 'single-flight';
    const testWindow = stubTestWindow({
      hostname: 'app.propr.dev',
      href: `https://app.propr.dev/tasks?flow=${flowId}`,
      name: 'propr-hosted-flow-context:hosted-context|tab-name',
      pathname: '/tasks',
      search: `?flow=${flowId}`,
      sessionInitial: hostedStorage(flowId, 'https://t-single.propr.dev'),
    });
    let resolveFetch: (response: Response) => void = () => undefined;
    const pendingFetch = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockReturnValue(pendingFetch);
    const { logout } = await importProprApi();

    const firstLogout = Promise.resolve(logout());
    const secondLogout = Promise.resolve(logout());

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    resolveFetch(new Response('', { status: 200 }));
    await Promise.all([firstLogout, secondLogout]);
    expect(testWindow.location.href).toBe(`/login?logged_out=true&flow=${flowId}`);
  });

  it('preserves local and self-hosted direct logout navigation', async () => {
    vi.stubEnv('VITE_API_BASE_URL', 'http://localhost:4000');
    const testWindow = stubTestWindow({
      hostname: 'localhost',
      href: 'http://localhost:5173/tasks',
      pathname: '/tasks',
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 200 }));
    const { logout } = await importProprApi();

    logout();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(testWindow.location.href).toBe('http://localhost:4000/api/auth/logout');
  });

  it('logs out the active Electron session and uses hash-aware login navigation', async () => {
    const testWindow = stubTestWindow({
      apiBaseUrl: 'http://localhost:4000',
      hostname: 'renderer',
      href: 'propr-app://renderer/renderer.html#/tasks',
      pathname: '/renderer.html',
    });
    testWindow.location.hash = '#/tasks';
    const sessionLogout = vi.fn().mockResolvedValue(undefined);
    const openExternal = vi.fn();
    testWindow.proprDesktop = {
      auth: { logout: sessionLogout },
      external: { open: openExternal },
    };
    const { logout } = await importProprApi();

    await Promise.resolve(logout());

    expect(sessionLogout).toHaveBeenCalledWith('http://localhost:4000');
    expect(openExternal).not.toHaveBeenCalled();
    expect(testWindow.location.href).toBe('propr-app://renderer/renderer.html#/tasks');
    expect(testWindow.location.hash).toBe('/login?logged_out=true');
  });
});
